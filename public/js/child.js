/**
 * 子女端控制台逻辑（浅色 UI · 8 页顶部导航）
 * 页面：总览 / 服药计划 / 药箱库存 / 提醒记录 / 告警中心 / 语音提醒 / AI 助手 / 家庭成员
 *
 * 这是把队友 UI（智能药箱网页版）的浅色设计系统移植过来后，
 * 将原控制台业务逻辑重新接线到新 DOM 结构的版本。
 * 关键变化：
 *   1. 导航从 `.side a[data-sec]` 改成 `#nav button[data-page]` + `.view.active` 切换；
 *   2. 各板块渲染目标改成新 ID（#nextDose / #todaySlots / #invTable …）；
 *   3. 补齐队友 UI 没做完的页：库存、家庭成员、提醒记录、告警中心卡片、AI 助手。
 */
(async function () {
  'use strict';

  // ---------- 登录守卫 ----------
  const logged = await requireLogin();
  if (!logged) return;

  // 反向保护：子女端只认「用户令牌」。
  if (api.tokenType() === 'device') {
    api.clearToken();
    alert('这里要用子女的账号密码登录；药箱/老人端请打开 /elder.html');
    location.href = '/login.html';
    return;
  }

  // ---------- 全局数据 ----------
  let elders = [];
  let medicines = [];
  let medboxes = [];
  let schedules = [];
  let members = [];          // 家庭成员（含照护成员）
  let currentElderId = null;
  let meUser = null;         // 当前登录的子女
  let lastDashboard = null;  // 总览数据缓存
  let pendingItems = [];     // 新增计划时暂存的明细
  let mediaRecorder = null;
  let audioChunks = [];
  let alertFilter = null;    // 告警中心当前过滤类型

  // 顶栏显示当前登录者与角色，并绑定登出
  try {
    const me = await api.get('/auth/me');
    meUser = me;
    const av = document.getElementById('myAvatar');
    if (av) av.textContent = (me.realName || me.username || '我').slice(0, 1);
    const lb = document.getElementById('btnLogout');
    if (lb) lb.onclick = logout;
  } catch (e) { /* 忽略，接口层已提示 */ }

  const $ = (id) => document.getElementById(id);

  // ---------- 工具 ----------
  /** 填充下拉框 */
  function fillSelect(el, list, valueKey, labelKey, placeholder) {
    if (!el) return;
    const keep = el.value;
    let html = placeholder ? `<option value="">${esc(placeholder)}</option>` : '';
    html += list.map((x) =>
      `<option value="${esc(x[valueKey])}">${esc(x[labelKey])}</option>`).join('');
    el.innerHTML = html;
    if (keep) el.value = keep;
  }

  /** 空状态块 */
  function emptyBlock(ico, txt) {
    return `<div class="empty"><span class="eico">${ico}</span>${txt}</div>`;
  }

  /** HH:MM（判断隔间状态用） */
  function nowHM() {
    const n = new Date();
    return String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0');
  }

  // ---------- 导航 ----------
  window.go = function (page) {
    const btn = document.querySelector(`#nav button[data-page="${page}"]`);
    if (btn) btn.click();
  };
  document.querySelectorAll('#nav button').forEach((b) => {
    b.addEventListener('click', () => {
      // 换页时把还在播的试听停掉，否则声音会跟着用户走到别的页面
      if (recAudio && !recAudio.paused) recAudio.pause();
      document.querySelectorAll('#nav button').forEach((x) => x.classList.remove('on'));
      document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
      b.classList.add('on');
      const view = document.getElementById('view-' + b.dataset.page);
      if (view) view.classList.add('active');
      onPageEnter(b.dataset.page);
    });
  });

  /** 首次进入某页时懒加载（AI 助手、库存、家庭成员等） */
  function onPageEnter(page) {
    if (page === 'assistant') {
      if (!$('insightList').children.length) loadInsights();
      if (!$('chatLog').children.length) {
        appendMsg('ai', '你好，我是你的用药助手。可以问我药物搭配、服药注意事项，或任何用药相关的疑问。', []);
      }
    }
  }

  // ---------- 弹层 ----------
  window.openModal = function (id) { const m = $(id); if (m) m.classList.add('open'); };
  window.closeModal = function (id) { const m = $(id); if (m) m.classList.remove('open'); };
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); });
  });

  // ---------- 数据加载 ----------
  async function loadAll() {
    try {
      elders = await api.get('/elders');
      medicines = await api.get('/medicines');
      medboxes = await api.get('/medbox');
      schedules = await api.get('/schedules');
      members = await api.get('/users');

      if (!currentElderId) currentElderId = elders.length ? elders[0].id : null;

      fillSelect($('p_elder'), elders, 'id', 'name');
      fillSelect($('s_elder'), elders, 'id', 'name');
      fillSelect($('r_elder'), elders, 'id', 'name');
      fillSelect($('ev_elder'), elders, 'id', 'name');
      fillSelect($('planElderSel'), elders, 'id', 'name', '全部老人');
      fillSelect($('s_medicine'), medicines, 'id', 'name', '--选择药品--');
      fillSelect($('c_medbox'), medboxes, 'id', 'device_code');

      if (currentElderId) {
        $('planElderSel').value = currentElderId;
        $('s_elder').value = currentElderId;
      }

      await loadCompartments();
      await loadSchedules();

      renderElders();
      renderMedboxes();
      renderMembers();
      renderRecordings();
      renderEvents();
      renderAlerts();
      renderDashboard();
      renderAiCard();
      renderInventory();
      renderRemindToday();
      loadPolicyForm();
    } catch (e) {
      console.error(e);
    }
  }

  // ================= 总览 =================
  async function renderDashboard() {
    if (!currentElderId) {
      $('ovSub').textContent = '请先在「家庭成员」里新增一位老人';
      return;
    }
    try {
      const d = await api.get(`/dashboard/${currentElderId}?days=7`);
      lastDashboard = d;
      const rate = Number(d.rate) || 0;
      const unread = Number(d.unreadAlerts) || 0;
      const elder = d.elder || elders.find((e) => e.id === currentElderId) || {};
      const boxOnline = !!(d.box && d.box.online);
      const shared = (d.box && d.box.shared_elders) || [];
      const shareTxt = shared.length ? `，与${shared.map((s) => s.name).join('、')}共用` : '';

      $('ovSub').textContent =
        `${esc(elder.name || '老人')}${shareTxt} · ` +
        (unread ? `有 ${unread} 条提醒待处理` : '一切正常');

      // KPI 概览条
      $('ovDone').textContent = `${Number(d.todayDone) || 0} / ${Number(d.todayTotal) || 0}`;
      $('ovStreak').textContent = `${Number(d.streakDays) || 0} 天`;
      $('ovUnread').textContent = unread;
      $('ovRate').textContent = rate + '%';

      renderNextDose(d);
      renderTodaySlots(d);
      renderRateCard(d, rate);
      renderCatDonut();
      renderFocusList(d);
      renderAlertMini();
      renderCompGrid(d);
      // AI 建议卡单独 60 秒刷新（见 startLiveSync），不随 10 秒轮询调 LLM
    } catch (e) { /* 接口层已 toast */ }
  }

  /** 顶部「下一次服药」大卡（含「谁」服药） */
  function renderNextDose(d) {
    const tl = d.timeline || [];
    const elderName = (d.elder && d.elder.name) || '';
    const next = tl.find((t) => t.status === 'current') || tl.find((t) => t.status === 'upcoming') || tl.find((t) => t.status === 'overdue');
    if (!next) {
      $('nextDose').innerHTML =
        `<div class="nd-left">
         <div class="nd-label">${elderName ? `<b>${esc(elderName)}</b> · ` : ''}下一次服药</div>
         <div class="nd-time">—</div>
         <div class="nd-drugs">今天没有待服药的计划</div>
         <div class="nd-meta">可在「服药计划」里新增</div></div>`;
      return;
    }
    const time = String(next.dose_time).slice(0, 5);
    const drugs = (next.items || []).map((i) => `${esc(i.medicine_name)} ${i.dose_qty}${esc(i.unit)}`).join(' · ') || '未配置药品';
    const where = next.slot_no ? `第 ${next.slot_no} 格` : '未绑定隔间';
    const stLabel = { current: '现在 · 解锁中', overdue: '已超时未取', upcoming: next.time_label || '待服' }[next.status] || '';
    $('nextDose').innerHTML = `
      <div class="nd-left">
        <div class="nd-label"><b>${esc(elderName)}</b> · 下一次服药 · ${esc(next.time_label || '')}</div>
        <div class="nd-time">${time}</div>
        <div class="nd-drugs">${drugs}</div>
        <div class="nd-meta">${where}<em>·</em>${esc(stLabel)}</div>
      </div>
      <div class="nd-cta">
        <button class="btn-voice" onclick="go('voice')">去录一段语音</button>
        <button class="btn-take" onclick="go('plan')">管理分装</button>
      </div>`;
  }

  /** 今日用药时间线（改用 .slots 四列卡片） */
  function renderTodaySlots(d) {
    const tl = d.timeline || [];
    if (!tl.length) {
      $('todaySlots').innerHTML = emptyBlock('&#128197;', '今天没有服药计划');
      $('todaySub').textContent = '可在「服药计划」新增';
      return;
    }
    const doneCount = tl.filter((t) => t.status === 'done').length;
    $('todaySub').textContent = `已完成 ${doneCount} / ${tl.length} 个时间点`;
    const meta = {
      done: { cls: 'done', st: '已按时' },
      current: { cls: 'now', st: '解锁中' },
      overdue: { cls: 'now', st: '超时未取' },
      upcoming: { cls: 'todo', st: '未到时间' },
    };
    $('todaySlots').innerHTML = tl.map((t) => {
      const m = meta[t.status] || meta.upcoming;
      const drugs = (t.items || []).map((i) => `${esc(i.medicine_name)} ${i.dose_qty}${esc(i.unit)}`).join('、') || '未配置';
      return `
        <div class="slot ${m.cls}">
          <div class="t">${String(t.dose_time).slice(0, 5)}</div>
          <div class="n">${esc(t.time_label || '')}</div>
          <div class="d">${drugs}</div>
          <div class="st">${m.st}</div>
        </div>`;
    }).join('');
  }

  /** 按时服药率 + 近 7 日柱状图 */
  function renderRateCard(d, rate) {
    const diff = Number(d.prevWeekRate) ? (rate - Number(d.prevWeekRate)).toFixed(1) : null;
    $('rateBig').textContent = rate + '%';
    $('rateDelta').innerHTML = diff === null ? '暂无上周对比'
      : Number(diff) >= 0 ? `较上周 +${diff}%` : `较上周 ${diff}%`;
    if (Number(diff) < 0) $('rateDelta').style.color = 'var(--bad)';
    else $('rateDelta').style.color = 'var(--ok)';

    renderWeekBars(d.daily || []);
  }

  /** 近 7 日柱状图：深绿=按时，浅橙=当日有漏服 */
  function renderWeekBars(daily) {
    const byDay = {};
    daily.forEach((r) => { byDay[String(r.d).slice(0, 10)] = r; });
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const now = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = dt.getFullYear() + '-' +
        String(dt.getMonth() + 1).padStart(2, '0') + '-' +
        String(dt.getDate()).padStart(2, '0');
      const rec = byDay[key];
      days.push({
        label: names[dt.getDay()],
        taken: rec ? Number(rec.taken) : 0,
        total: rec ? Number(rec.total) : 0,
        missed: rec ? Number(rec.missed) : 0,
        today: i === 0,
      });
    }
    const max = Math.max(3, ...days.map((d) => Math.max(d.total, 1)));
    $('weekBars').innerHTML = days.map((d) => {
      const h = d.total ? Math.max(6, Math.round((d.total / max) * 150)) : 6;
      const miss = d.missed > 0;
      return `
        <div class="bcol">
          <div class="bar ${miss ? 'miss' : ''}" style="height:${h}px" data-tip="${d.label}：计划 ${d.total} · 按时 ${d.taken} · 漏服 ${d.missed}"></div>
          <div class="bl">${d.label}</div>
        </div>`;
    }).join('');
    const weekTotal = days.reduce((a, d) => a + d.total, 0);
    const weekTaken = days.reduce((a, d) => a + d.taken, 0);
    $('weekFoot').innerHTML =
      `<span>近 7 日依从 <b>${weekTotal ? Math.round((weekTaken / weekTotal) * 100) : 0}%</b></span>
       <span style="margin-left:auto">橙色柱 = 当日有漏服</span>`;
  }

  /** 在库药品构成（按功能分类环形图） */
  function renderCatDonut() {
    const cats = {};
    medicines.forEach((m) => {
      const c = m.category || '未分类';
      cats[c] = (cats[c] || 0) + 1;
    });
    const entries = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, e) => a + e[1], 0);
    if (!total) {
      $('catDonut').innerHTML = emptyBlock('&#128230;', '还没有在库药品');
      $('catSub').textContent = '先在「药箱库存」添加';
      return;
    }
    $('catSub').textContent = `共 ${total} 种`;
    // 用 conic-gradient 画环形，不用第三方库
    const colors = ['#2F6B63', '#7FA69E', '#D6C08A', '#8B6FC0', '#AC5F4B', '#A9B0AB'];
    let acc = 0;
    const segs = entries.map(([name, cnt], i) => {
      const from = (acc / total) * 360;
      acc += cnt;
      const to = (acc / total) * 360;
      return { name, cnt, pct: Math.round((cnt / total) * 100), from, to, color: colors[i % colors.length] };
    });
    const grad = segs.map((s) => `${s.color} ${s.from}deg ${s.to}deg`).join(',');
    $('catDonut').innerHTML = `
      <div style="width:130px;height:130px;border-radius:50%;flex:none;background:conic-gradient(${grad});position:relative">
        <div style="position:absolute;inset:26px;background:var(--card);border-radius:50%;display:grid;place-items:center;text-align:center">
          <div style="font-size:26px;font-weight:600;font-family:var(--num);color:var(--ink)">${total}</div>
          <div style="font-size:11px;color:var(--muted)">种药品</div>
        </div>
      </div>
      <ul class="dlegend">${segs.map((s) => `
        <li><i style="width:8px;height:8px;border-radius:50%;background:${s.color};flex:none"></i>
          ${esc(s.name)}<b>${s.cnt}<small>${s.pct}%</small></b></li>`).join('')}
      </ul>`;
  }

  /** 需要关注（库存与效期） */
  function renderFocusList(d) {
    const low = (d.lowStock || []).map((m) => ({
      ico: '&#128230;', name: m.name, txt: `库存仅剩 ${m.stock_qty}（预警 ${m.stock_alert_qty}）`, st: 'low',
    }));
    // 效期关注：30 天内到期或已过期
    const exp = medicines.filter((m) => {
      if (!m.expiry_date) return false;
      const diff = (new Date(m.expiry_date) - new Date()) / 86400000;
      return diff <= 30;
    }).map((m) => {
      const diff = (new Date(m.expiry_date) - new Date()) / 86400000;
      const expired = diff < 0;
      return {
        ico: '&#9203;', name: m.name,
        txt: expired ? '已过期' : `${Math.ceil(diff)} 天后到期`,
        st: expired ? 'bad' : 'low',
      };
    });
    const list = [...low, ...exp];
    $('focusList').innerHTML = list.length
      ? list.slice(0, 6).map((it) => `
        <div class="rrow">
          <span class="ic">${it.ico}</span>
          <div class="tx"><b>${esc(it.name)}</b><small>${esc(it.txt)}</small></div>
          <span class="stt ${it.st}">${it.st === 'bad' ? '过期' : '关注'}</span>
        </div>`).join('')
      : emptyBlock('&#9989;', '库存与效期都健康');
    $('focusSub').textContent = list.length ? `${list.length} 项需要关注` : '库存与效期';
  }

  /** 漏服与异常（未读告警前 2 条） */
  async function renderAlertMini() {
    try {
      const alerts = await api.get('/alerts?limit=2&is_read=0');
      $('alertMiniSub').textContent = alerts.length ? `${alerts.length} 条未处理` : '未处理提醒';
      $('alertMini').innerHTML = alerts.length ? alerts.map((a) => `
        <div class="alert-mini ${a.level === 'urgent' ? 'urgent' : 'warning'}">
          <div class="a-head">${a.level === 'urgent' ? '&#9203;' : '&#9888;&#65039;'}
            ${esc(alertLabel(a.alert_type))}
            <span class="hint" style="font-weight:400;color:var(--muted);margin-left:auto">${fmtTime(a.created_at)}</span>
          </div>
          <div class="a-body">${esc(a.content)}</div>
          <div class="a-ops">
            <button class="sm alt call" onclick="handleAlert(${a.id})">标记已处理</button>
          </div>
        </div>`).join('')
        : emptyBlock('&#9989;', '没有漏服与异常');
    } catch (e) {
      $('alertMini').innerHTML = emptyBlock('&#9888;', '告警加载失败');
    }
  }

  /** 药箱隔间状态网格（8 格） */
  async function renderCompGrid(d) {
    try {
      const boxId = d.box ? d.box.id : (medboxes[0] || {}).id;
      const comps = boxId ? await api.get(`/medbox/${boxId}/compartments`) : [];
      const meta = {
        taken: { cls: 'taken', label: '已取' },
        unlock: { cls: 'unlock', label: '解锁中' },
        warn: { cls: 'warn', label: '异常' },
        lock: { cls: '', label: '锁定' },
      };
      $('compGrid').innerHTML = comps.length ? comps.map((c) => {
        let st = 'lock';
        if (!c.is_locked) st = 'unlock';
        if (c.time_label && String(c.dose_time).slice(0, 5) <= nowHM() && okToday(c.id)) st = 'taken';
        const m = meta[st];
        return `<div class="cc ${m.cls}"><b>${c.slot_no}</b><span>${m.label}</span>${c.elder_name ? `<em>${esc(c.elder_name)}</em>` : ''}</div>`;
      }).join('') : emptyBlock('&#128230;', '暂无隔间数据');
    } catch (e) {
      $('compGrid').innerHTML = emptyBlock('&#9888;', '隔间状态加载失败');
    }
  }
  function okToday(compId) {
    if (!lastDashboard || !lastDashboard.timeline) return false;
    return lastDashboard.timeline.some((t) => t.status === 'done');
  }

  /** AI 主动建议（取第一条） */
  async function renderAiCard() {
    try {
      const ins = await api.get('/assistant/insights?days=7');
      const first = (ins.insights || [])[0];
      $('aiCard').innerHTML = first ? `
        <div class="tip" style="padding-top:0"><b>${esc(first.title)}</b><p>${esc(first.body)}</p></div>
        <div class="hint" style="margin-top:8px">来源：${esc((first.evidence || []).map((e) => e.metric).join(' · ') || '服药流水')} · 不构成诊疗建议</div>`
        : `<div class="tip" style="padding-top:0"><b>近期服药情况良好</b><p>未发现需要处理的问题，保持当前节奏即可。</p></div>`;
    } catch (e) {
      $('aiCard').innerHTML = '<div class="hint">助手暂时离线，稍后自动恢复。</div>';
    }
  }

  // ================= 服药计划与分装 =================
  async function loadSchedules() {
    const q = currentElderId ? `?elder_id=${currentElderId}` : '';
    schedules = await api.get('/schedules' + q);
    // 录音页的「绑定时段」也用这份数据。显示「早上 08:00」而不是光一个「早」——
    // 一位老人有两个「早」（比如 07:00 和 09:30）时，只看标签根本分不清绑的是哪个。
    fillSelect($('r_schedule'),
      schedules.map((s) => Object.assign({}, s, { label: slotLabel(s) })),
      'id', 'label', '--通用/不限时段--');
    if ($('s_compartment') && medboxes.length) {
      const boxId = $('c_medbox').value || medboxes[0].id;
      const comps = await api.get(`/medbox/${boxId}/compartments`);
      // 标注每格占用状态，并默认选中第一个空闲格（让「药盒分装」能立刻显示放到哪格）
      const opts = ['<option value="">--选择隔间--</option>']
        .concat(comps.map((c) => {
          const used = c.schedule_id
            ? `${esc(c.time_label || '已用')} ${String(c.dose_time || '').slice(0, 5)}`
            : '空闲';
          return `<option value="${c.id}">第 ${c.slot_no} 格（${used}）</option>`;
        }));
      $('s_compartment').innerHTML = opts.join('');
      const firstFree = comps.find((c) => !c.schedule_id);
      if (firstFree) $('s_compartment').value = firstFree.id;
    }
    renderSchedules();
  }

  async function renderSchedules() {
    if (!schedules.length) {
      $('scheduleTable').innerHTML = emptyBlock('&#128197;', '还没有服药计划');
      $('planWeekSub').textContent = '暂无计划';
      $('planSub').textContent = '还没有服药计划，点右上角「新增服药计划」开始';
      return;
    }
    $('planWeekSub').textContent = `共 ${schedules.length} 条计划`;
    $('planSub').textContent = `共 ${schedules.length} 条服药计划`;
    const rows = [];
    for (const s of schedules) {
      const detail = await api.get('/schedules/' + s.id);
      rows.push({ s, items: detail.items });
    }
    $('scheduleTable').innerHTML = `
      <table class="g"><thead><tr><th>时间</th><th>时段</th><th>老人</th><th>隔间</th><th>窗口</th><th>药品明细</th><th>操作</th></tr></thead>
      <tbody>${rows.map(({ s, items }) => `
        <tr>
          <td><b>${String(s.dose_time).slice(0, 5)}</b></td>
          <td>${esc(s.time_label || '-')}</td>
          <td>${esc(s.elder_name || '-')}</td>
          <td>${s.slot_no ? '第' + s.slot_no + '格' : '未绑定'}</td>
          <td>前${s.window_before_min} / 后${s.window_after_min} 分</td>
          <td>${items.length
            ? items.map((i) => `${esc(i.medicine_name)} × ${i.dose_qty}${esc(i.unit)}`).join('、')
            : '<span class="hint">无</span>'}</td>
          <td><button class="sm danger" onclick="delSchedule(${s.id})">删除</button></td>
        </tr>`).join('')}</tbody></table>`;
  }

  window.delSchedule = async (id) => {
    if (!confirm('删除该计划？明细会一并删除。')) return;
    await api.del('/schedules/' + id);
    toast('已删除');
    await loadSchedules();
    await loadCompartments();
    renderDashboard();
    renderRemindToday();
  };

  $('planElderSel').addEventListener('change', (e) => {
    currentElderId = e.target.value ? Number(e.target.value) : null;
    loadSchedules();
    renderDashboard();
    renderRemindToday();
  });

  $('btnAddItem').addEventListener('click', () => {
    const mid = $('s_medicine').value;
    if (!mid) return toast('请选择药品', true);
    const m = medicines.find((x) => String(x.id) === String(mid));
    pendingItems.push({
      medicine_id: Number(mid),
      dose_qty: Number($('s_dose').value || 1),
      note: $('s_note').value || null,
      _name: m ? m.name : '',
      _unit: m ? m.unit : '',
    });
    renderItemsPreview();
    $('s_note').value = '';
  });

  function renderItemsPreview() {
    $('itemsPreview').innerHTML = pendingItems.length ? `
      <table class="g"><thead><tr><th>药品</th><th>剂量</th><th>提示</th><th></th></tr></thead>
      <tbody>${pendingItems.map((it, i) => `
        <tr><td>${esc(it._name)}</td><td>${it.dose_qty} ${esc(it._unit)}</td>
        <td>${esc(it.note || '-')}</td>
        <td><button class="sm danger" onclick="removeItem(${i})">移除</button></td></tr>`).join('')}
      </tbody></table>` : emptyBlock('&#128230;', '尚未添加明细');
  }
  window.removeItem = (i) => { pendingItems.splice(i, 1); renderItemsPreview(); };

  $('btnSaveSchedule').addEventListener('click', async () => {
    if (!$('s_elder').value) return toast('请先新增老人档案', true);
    if (!pendingItems.length) return toast('请至少添加一种药', true);
    await api.post('/schedules', {
      elder_id: Number($('s_elder').value),
      dose_time: $('s_time').value,
      time_label: $('s_label').value,
      compartment_id: $('s_compartment').value ? Number($('s_compartment').value) : null,
      window_before_min: Number($('s_before').value || 10),
      window_after_min: Number($('s_after').value || 30),
      items: pendingItems.map(({ medicine_id, dose_qty, note }) => ({ medicine_id, dose_qty, note })),
    });
    toast('计划已保存');
    pendingItems = [];
    renderItemsPreview();
    await loadSchedules();
    await loadCompartments();
    renderDashboard();
    renderRemindToday();
  });

  $('btnNewSchedule').addEventListener('click', () => {
    pendingItems = [];
    renderItemsPreview();
    $('s_time').value = '08:00';
    $('s_note').value = '';
    document.getElementById('view-plan').scrollIntoView({ behavior: 'smooth' });
  });

  // ================= 隔间 =================
  async function loadCompartments() {
    const id = $('c_medbox').value || (medboxes[0] || {}).id;
    if (!id) { $('compTable').innerHTML = emptyBlock('&#128230;', '请先创建药箱'); return; }
    const list = await api.get(`/medbox/${id}/compartments`);
    $('compTable').innerHTML = `
      <table class="g"><thead><tr><th>格号</th><th>标签</th><th>使用人</th><th>绑定计划</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${list.map((c) => `
        <tr>
          <td><b>第 ${c.slot_no} 格</b></td>
          <td>${esc(c.label || '-')}</td>
          <td>${c.elder_name ? `<b>${esc(c.elder_name)}</b>` : '<span class="hint">未分配</span>'}</td>
          <td>${c.time_label ? `${esc(c.time_label)} ${String(c.dose_time).slice(0, 5)}` : '<span class="hint">空闲</span>'}</td>
          <td>${c.is_locked ? '<span class="badge">已锁闭</span>' : '<span class="badge green">已解锁</span>'}</td>
          <td>
            <button class="sm" onclick="toggleLock(${c.id}, ${c.is_locked ? 0 : 1})">
              ${c.is_locked ? '解锁' : '锁闭'}</button>
            ${c.schedule_id ? `<button class="sm danger" onclick="unbindCompartment(${c.schedule_id})">移除计划</button>` : ''}
          </td>
        </tr>`).join('')}</tbody></table>`;
    renderSharePanel(id);
  }

  function renderSharePanel(boxId) {
    const box = medboxes.find((b) => Number(b.id) === Number(boxId)) || {};
    const linked = new Set((box.elders || []).map((e) => Number(e.elder_id)));
    const primary = (box.elders || []).find((e) => e.is_primary);
    if (!elders.length) {
      $('shareChks').innerHTML = '<span class="hint">先在「家庭成员」创建老人，再设置共用。</span>';
      return;
    }
    $('shareChks').innerHTML = elders.map((e) => `
      <label>
        <input type="checkbox" value="${e.id}" ${linked.has(Number(e.id)) ? 'checked' : ''} data-name="${esc(e.name)}">
        ${esc(e.name)}${primary && Number(primary.elder_id) === Number(e.id) ? '<span class="prime-tag">主</span>' : ''}
      </label>`).join('');
  }

  window.toggleLock = async (id, locked) => {
    await api.put('/compartments/' + id, { is_locked: locked });
    toast(locked ? '已锁闭' : '已解锁');
    await loadCompartments();
  };

  // 移除格子上绑定的计划（计划本身保留，只是不再占用这一格）
  window.unbindCompartment = async (scheduleId) => {
    if (!confirm('移除该格绑定的计划？\n计划本身不会被删除，之后可在新增计划时重新绑定格子。')) return;
    await api.put('/schedules/' + scheduleId, { compartment_id: null });
    toast('已移除该格的计划');
    await loadCompartments();
    await loadSchedules();
  };

  window.saveShare = async () => {
    const boxId = $('c_medbox').value || (medboxes[0] || {}).id;
    if (!boxId) return toast('请先创建药箱', true);
    const ids = [...$('shareChks').querySelectorAll('input:checked')].map((i) => Number(i.value));
    if (!ids.length) return toast('至少勾选一位老人（第一位为主老人）', true);
    await api.put(`/medbox/${boxId}/elders`, { elder_ids: ids });
    toast(`已保存：这台药箱将由 ${ids.length} 位老人共用`);
    medboxes = await api.get('/medbox');
    await loadCompartments();
  };
  $('c_medbox').addEventListener('change', loadCompartments);
  $('btnSaveShare').addEventListener('click', () => saveShare());

  // ================= 生成绑定码 =================
  $('btnBindCode').addEventListener('click', async () => {
    const boxId = $('c_medbox').value || (medboxes[0] || {}).id;
    if (!boxId) return toast('请先创建药箱', true);
    const r = await api.post('/auth/bind-code', { medbox_id: Number(boxId) });
    $('bindCodeText').textContent = r.bindCode;
    $('bindResult').style.display = 'block';
    toast('已生成，5 分钟内有效');
  });

  // ================= 药箱库存与效期 =================
  function medicineExpiryDays(m) {
    if (!m.expiry_date) return null;
    return Math.round((new Date(m.expiry_date) - new Date()) / 86400000);
  }

  function renderInventory() {
    const total = medicines.length;
    const low = medicines.filter((m) => Number(m.stock_qty) <= Number(m.stock_alert_qty));
    const nearExp = medicines.filter((m) => { const d = medicineExpiryDays(m); return d !== null && d >= 0 && d <= 30; });
    const expired = medicines.filter((m) => { const d = medicineExpiryDays(m); return d !== null && d < 0; });

    $('invCount').textContent = total;
    $('invLow').textContent = low.length;
    $('invNearExp').textContent = nearExp.length;
    $('invExpired').textContent = expired.length;
    $('invSub').textContent = `共 ${total} 种在库药品`;

    renderInvTable();
    renderExpTimeline();
    renderHealth();
  }

  function renderInvTable() {
    const sorted = [...medicines].sort((a, b) => Number(a.stock_qty) - Number(b.stock_qty));
    $('invListSub').textContent = `共 ${sorted.length} 种 · 按剩余量升序`;
    if (!sorted.length) {
      $('invTable').innerHTML = emptyBlock('&#128230;', '还没有在库药品');
      return;
    }
    $('invTable').innerHTML = `
      <table class="inv"><thead><tr><th>药品</th><th>分类</th><th>剩余</th><th>效期</th><th>状态</th><th style="width:110px">操作</th></tr></thead>
      <tbody>${sorted.map((m) => {
        const d = medicineExpiryDays(m);
        const low = Number(m.stock_qty) <= Number(m.stock_alert_qty);
        let st, stCls;
        if (d !== null && d < 0) { st = '已过期'; stCls = 'exp'; }
        else if (low) { st = '需补货'; stCls = 'low'; }
        else if (d !== null && d <= 30) { st = '临近效期'; stCls = 'low'; }
        else { st = '正常'; stCls = 'ok'; }
        const pct = Math.max(0, Math.min(100, Math.round((Number(m.stock_qty) / Math.max(Number(m.stock_alert_qty) * 4, 1)) * 100)));
        return `<tr class="${stCls === 'ok' ? 'okrow' : ''}" data-id="${m.id}">
          <td class="name"><b>${esc(m.name)}</b><small>${esc(m.spec || m.unit || '')}</small></td>
          <td>${esc(m.category || '未分类')}</td>
          <td><span class="bar" data-tip="剩余 ${m.stock_qty} / 预警 ${m.stock_alert_qty}"><i style="width:${pct}%;background:${low ? 'var(--warn)' : 'var(--primary)'}"></i></span>${m.stock_qty}</td>
          <td>${m.expiry_date ? String(m.expiry_date).slice(0, 10) : '—'}</td>
          <td><span class="st ${stCls}">${st}</span></td>
          <td class="ops"><a class="txtlink" data-act="edit" data-id="${m.id}">编辑</a><a class="txtlink" data-act="del" data-id="${m.id}" style="color:#e5484d;margin-left:10px">删除</a></td>
        </tr>`;
      }).join('')}</tbody></table>`;
  }

  function renderExpTimeline() {
    const list = medicines.filter((m) => { const d = medicineExpiryDays(m); return d !== null && d <= 90; })
      .sort((a, b) => medicineExpiryDays(a) - medicineExpiryDays(b));
    if (!list.length) {
      $('expTimeline').innerHTML = emptyBlock('&#9989;', '未来 90 天内没有到期的药品');
      return;
    }
    $('expTimeline').innerHTML = list.map((m) => {
      const d = medicineExpiryDays(m);
      const expired = d < 0;
      const label = expired ? `已过期 ${Math.abs(d)} 天` : (d === 0 ? '今天到期' : `${d} 天后到期`);
      return `
        <div class="tip">
          <b>${esc(m.name)} <span class="st ${expired ? 'exp' : 'low'}" style="margin-left:6px">${label}</span></b>
          <p>有效期至 ${String(m.expiry_date).slice(0, 10)} · ${esc(m.category || '未分类')}</p>
        </div>`;
    }).join('');
  }

  function renderHealth() {
    const total = medicines.length;
    const low = medicines.filter((m) => Number(m.stock_qty) <= Number(m.stock_alert_qty)).length;
    const nearExp = medicines.filter((m) => { const d = medicineExpiryDays(m); return d !== null && d >= 0 && d <= 30; }).length;
    const expired = medicines.filter((m) => { const d = medicineExpiryDays(m); return d !== null && d < 0; }).length;
    const score = total ? Math.max(0, 100 - (low + nearExp + expired * 2) * 15 - (total < 3 ? 10 : 0)) : 0;
    $('healthScore').textContent = total ? Math.min(100, score) : '—';

    const restock = medicines.filter((m) => Number(m.stock_qty) <= Number(m.stock_alert_qty));
    $('restockList').innerHTML = restock.length
      ? restock.map((m) => `<li><b>${esc(m.name)}</b><span class="num">剩 ${m.stock_qty} · 需补</span></li>`).join('')
      : '<li style="color:var(--muted)">无需补药</li>';

    const expList = medicines.filter((m) => { const d = medicineExpiryDays(m); return d !== null && d < 0; });
    $('expSub').textContent = expList.length ? `${expList.length} 种待清理` : '待处理';
    $('expList').innerHTML = expList.length
      ? expList.map((m) => `<div class="tip"><b>${esc(m.name)}</b><p>已过期，建议清理</p></div>`).join('')
      : '<div class="hint" style="padding:8px 0">没有过期药品</div>';
  }

  // 操作列点击：编辑 / 删除（事件委托到表格容器，只绑定一次）
  $('invTable').addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const id = a.getAttribute('data-id');
    if (a.getAttribute('data-act') === 'edit') openEditMed(id);
    else if (a.getAttribute('data-act') === 'del') deleteMed(id);
  });

  $('onlyAbn').addEventListener('click', () => {
    const tbl = $('invTable') && $('invTable').querySelector('table.inv');
    if (!tbl) return;
    tbl.classList.toggle('hide-ok');
    const hidden = tbl.classList.contains('hide-ok');
    $('onlyAbn').textContent = hidden ? '显示全部' : '仅看异常';
  });

  $('restockBtn').addEventListener('click', () => {
    const list = medicines.filter((m) => Number(m.stock_qty) <= Number(m.stock_alert_qty));
    if (!list.length) return toast('家里暂时不缺货，都很充足');
    const rows = [['药品', '当前库存', '预警库存', '需补数量']];
    list.forEach((m) => rows.push([m.name, m.stock_qty, m.stock_alert_qty, Number(m.stock_alert_qty) - Number(m.stock_qty) + 7]));
    const csv = '\uFEFF' + rows.map((r) => r.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = '购药清单.csv';
    a.click();
    toast('已生成购药清单');
  });

  $('cleanBtn').addEventListener('click', async () => {
    const list = medicines.filter((m) => { const d = medicineExpiryDays(m); return d !== null && d < 0; });
    if (!list.length) return toast('没有过期药品');
    if (!confirm(`确定将 ${list.length} 种过期药品标记为已清理？此操作会从库存移除。`)) return;
    for (const m of list) {
      await api.del('/medicines/' + m.id);
    }
    toast('已清理');
    await loadAll();
  });

  // ================= 提醒记录 =================
  async function renderRemindToday() {
    if (!currentElderId) {
      $('remindSub').textContent = '请先在「家庭成员」里新增一位老人';
      return;
    }
    try {
      const d = await api.get(`/dashboard/${currentElderId}?days=1`);
      const tl = d.timeline || [];
      const rate = Number(d.rate) || 0;
      const done = tl.filter((t) => t.status === 'done').length;
      const overdue = tl.filter((t) => t.status === 'overdue').length;
      $('todayRemindSub').textContent = `今日 ${tl.length} 个时间点`;
      $('remindSub').textContent = `今日 ${tl.length} 个时间点 · 近 7 日依从率 ${rate}%`;
      $('todayRemindList').innerHTML = tl.length ? tl.map((t) => {
        const meta = {
          done: { cls: 'done', st: '已按时' },
          current: { cls: 'now', st: '提醒中' },
          overdue: { cls: 'now', st: '超时未取' },
          upcoming: { cls: 'todo', st: '待提醒' },
        }[t.status] || { cls: 'todo', st: '待提醒' };
        const drugs = (t.items || []).map((i) => `${esc(i.medicine_name)} ${i.dose_qty}${esc(i.unit)}`).join('、') || '未配置';
        return `
          <div class="qitem ${meta.cls}">
            <div class="qt">${String(t.dose_time).slice(0, 5)}</div>
            <div class="qn">${esc(t.time_label || '')} · ${drugs}</div>
            <div class="qc">${meta.st}</div>
          </div>`;
      }).join('') : emptyBlock('&#128197;', '今天没有服药计划');
      // KPI 概览条
      $('rkToday').textContent = tl.length;
      $('rkDone').textContent = done;
      $('rkOverdue').textContent = overdue;
      $('rkRate').textContent = rate + '%';
    } catch (e) { /* ignore */ }
  }

  function loadPolicyForm() {
    const e = elders.find((x) => x.id === currentElderId);
    if (!e || !$('p_elder')) return;
    $('p_elder').value = e.id;
    $('p_volume').value = e.volume_level;
    $('p_volume_val').textContent = e.volume_level;
    $('p_rate').value = e.speech_rate;
    $('p_repeat').value = e.repeat_times;
    $('p_timeout').value = e.timeout_minutes;
    $('p_dupwin').value = e.duplicate_window_minutes;
    $('p_30').checked = !!e.remind_30m;
    $('p_10').checked = !!e.remind_10m;
    $('p_3').checked = !!e.remind_3m;
  }
  $('p_elder').addEventListener('change', loadPolicyForm);
  // 音量滑块实时显示数值
  $('p_volume').addEventListener('input', () => {
    $('p_volume_val').textContent = $('p_volume').value;
  });

  $('btnSavePolicy').addEventListener('click', async () => {
    await api.put('/elders/' + $('p_elder').value, {
      volume_level: Number($('p_volume').value),
      speech_rate: $('p_rate').value,
      repeat_times: Number($('p_repeat').value),
      timeout_minutes: Number($('p_timeout').value),
      duplicate_window_minutes: Number($('p_dupwin').value),
      remind_30m: $('p_30').checked ? 1 : 0,
      remind_10m: $('p_10').checked ? 1 : 0,
      remind_3m: $('p_3').checked ? 1 : 0,
    });
    toast('提醒策略已保存');
    await loadAll();
  });

  // ================= 服药记录 =================
  const EV_TYPE = { open: '开箱', take: '取药', close: '关箱', duplicate_refused: '重复拦截', wrong_time_refused: '非时段拦截', timeout: '超时', offline: '离线' };
  const EV_SRC = { device: '设备上报', simulator: '模拟器', manual: '手动' };
  const EV_DOT = { on_time: 'ok', early: 'ok', late: 'warn', missed: 'bad', duplicate: 'bad', abnormal: 'bad', unknown: 'mute' };

  // 本地日期（避免 toISOString 的 UTC 时区偏差）
  function localDate(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function evDate(s) {
    if (!s) return '';
    const d = String(s).slice(0, 10);
    const now = new Date();
    if (d === localDate(now)) return '今天';
    if (d === localDate(new Date(now.getTime() - 86400000))) return '昨天';
    return d.slice(5); // MM-DD
  }

  async function renderEvents() {
    const elderId = $('ev_elder').value || currentElderId;
    const date = $('ev_date').value;
    const q = `?elder_id=${elderId}` + (date ? `&date=${date}` : '') + '&limit=100';
    const list = await api.get('/events' + q);
    if (!list.length) {
      $('eventTable').innerHTML = emptyBlock('&#128197;', '暂无服药记录');
      return;
    }
    $('eventTable').innerHTML = `
      <div class="evlist">${list.map((e) => {
        const dot = EV_DOT[e.result] || 'mute';
        const act = EV_TYPE[e.event_type] || esc(e.event_type);
        const src = EV_SRC[e.source] || esc(e.source);
        const slot = e.slot_no ? '第' + e.slot_no + '格' : '';
        const hm = e.occurred_at ? String(e.occurred_at).slice(11, 16) : '--:--';
        return `
        <div class="evcard">
          <div class="evrail"><span class="evdot ${dot}"></span></div>
          <div class="evtime"><b>${hm}</b><span>${evDate(e.occurred_at)}</span></div>
          <div class="evmain">
            <div class="evtop">
              ${e.time_label ? `<span class="evtag">${esc(e.time_label)}</span>` : ''}
              <span class="evact">${act}</span>
              ${slot ? `<span class="evslot">${slot}</span>` : ''}
            </div>
            <div class="evsub">${[esc(e.elder_name || ''), src].filter(Boolean).join(' · ')}</div>
          </div>
          <div class="evbadge">${resultBadge(e.result)}</div>
        </div>`;
      }).join('')}</div>`;
  }
  $('btnQueryEvents').addEventListener('click', renderEvents);

  // ---------- 导出用药记录单（对应方案书 2.3「就诊带上用药单」） ----------
  async function exportRecord() {
    const elderId = $('ev_elder').value || currentElderId;
    if (!elderId) return toast('请先选择老人', true);
    toast('正在生成用药记录单…');
    try {
      const d = await api.get('/export/record/' + elderId);
      const w = window.open('', '_blank');
      if (!w) return toast('弹窗被拦截，请允许弹窗后重试', true);
      w.document.write(buildRecordHTML(d.elder, d.meds, d.events));
      w.document.close();
    } catch (e) { /* 接口层已 toast */ }
  }

  function buildRecordHTML(elder, meds, events) {
    const RESULT = { on_time: '按时', early: '提前', late: '延迟', missed: '漏服', duplicate: '重复', abnormal: '异常', unknown: '未知' };
    const dateStr = new Date().toLocaleString('zh-CN', { hour12: false });
    const medRows = meds.length
      ? meds.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.spec || '-')}</td><td>${esc(m.category || '-')}</td></tr>`).join('')
      : '<tr><td colspan="3" style="text-align:center;color:#999">暂无在服药品</td></tr>';
    const evRows = events.length
      ? events.map((e) => `
        <tr>
          <td>${fmtTime(e.occurred_at)}</td>
          <td>${esc(e.time_label || '-')}</td>
          <td>${e.slot_no ? '第' + e.slot_no + '格' : '-'}</td>
          <td>${RESULT[e.result] || esc(e.result)}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;color:#999">暂无服药记录</td></tr>';

    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>安心格 · 用药记录单</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#22302d;margin:40px;line-height:1.7}
  h1{font-size:22px;text-align:center;margin-bottom:6px;color:#2F6B63}
  .sub{text-align:center;color:#8a857b;font-size:12px;margin-bottom:26px}
  .block{border:1px solid #e8e2d6;border-radius:10px;padding:16px 20px;margin-bottom:20px}
  .block h3{font-size:14px;margin-bottom:10px;color:#2F6B63}
  .block p{margin:4px 0;font-size:13px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border:1px solid #e8e2d6;padding:8px 10px;text-align:left}
  th{background:#f5f3ee;font-weight:600}
  .foot{margin-top:24px;font-size:11px;color:#a9b0ab;text-align:center}
  @media print{body{margin:10mm}.block{page-break-inside:avoid}}
</style></head><body>
  <h1>安心格 · 用药记录单</h1>
  <div class="sub">生成时间：${dateStr}　·　仅供就诊参考</div>

  <div class="block">
    <h3>老人档案</h3>
    <p>姓名：${esc(elder.name || '-')}　性别：${elder.gender === 'male' ? '男' : elder.gender === 'female' ? '女' : '-'}　年龄：${esc(elder.age || '-')} 岁</p>
    <p>慢病：${esc(elder.chronic_diseases || '无')}</p>
    <p>过敏史：${esc(elder.allergies || '无')}</p>
  </div>

  <div class="block">
    <h3>在服药品清单（${meds.length} 种）</h3>
    <table><thead><tr><th>药品</th><th>规格</th><th>分类</th></tr></thead><tbody>${medRows}</tbody></table>
  </div>

  <div class="block">
    <h3>服药记录（${events.length} 条）</h3>
    <table><thead><tr><th>时间</th><th>时段</th><th>隔间</th><th>判定</th></tr></thead><tbody>${evRows}</tbody></table>
  </div>

  <div class="foot">本记录由「安心格 AnCareBox」生成，不构成医疗建议，请以医生与药师意见为准。</div>
</body></html>`;
  }

  $('btnExportRecord').addEventListener('click', exportRecord);

  // ================= 告警中心 =================
  const ALERT_LABEL = {
    missed: '漏服提醒',
    duplicate: '重复取药',
    night_open: '夜间异常',
    repeat_missed: '连续漏服',
    offline: '设备离线',
    sos: '老人求救',
    stock_low: '药品不足',
    drug_conflict: '用药冲突',
    expiry: '效期预警',
    fault: '设备故障',
  };
  const alertLabel = (t) => ALERT_LABEL[t] || '异常提醒';

  async function renderAlerts() {
    const list = await api.get('/alerts?limit=100');
    // 顶部过滤器：按类型聚合计数
    const cnt = {};
    list.forEach((a) => { cnt[a.alert_type] = (cnt[a.alert_type] || 0) + 1; });
    const allCount = list.length;
    $('afilter').innerHTML =
      `<button class="af ${alertFilter === null ? 'on' : ''}" onclick="setAlertFilter(null)">全部<em>${allCount}</em></button>` +
      Object.entries(cnt).map(([t, n]) =>
        `<button class="af ${alertFilter === t ? 'on' : ''}" onclick="setAlertFilter('${t}')">${esc(alertLabel(t))}<em>${n}</em></button>`).join('');

    const filtered = alertFilter ? list.filter((a) => a.alert_type === alertFilter) : list;
    $('alSummary').textContent = `共 ${allCount} 条告警，未处理 ${list.filter((a) => !a.is_read).length} 条`;
    $('alist').innerHTML = filtered.length ? filtered.map((a) => renderAlertCard(a)).join('')
      : emptyBlock('&#9989;', '该分类下暂无告警');
  }
  window.setAlertFilter = (t) => { alertFilter = t; renderAlerts(); };

  function renderAlertCard(a) {
    const lv = a.level === 'urgent' ? ['hi', '紧急'] : a.level === 'warning' ? ['mid', '警告'] : ['lo', '提示'];
    return `
      <div class="al ${a.is_read ? 'done' : (a.level === 'urgent' ? 'hi' : a.level === 'warning' ? 'mid' : '')}">
        <div class="al-top">
          <span class="al-type">${esc(alertLabel(a.alert_type))}</span>
          <span class="al-lv ${lv[0]}">${lv[1]}</span>
          <span class="al-time">${fmtTime(a.created_at)}</span>
        </div>
        <h4>${esc(a.elder_name || '')}${a.elder_name ? ' · ' : ''}${esc(alertLabel(a.alert_type))}</h4>
        <p>${esc(a.content)}</p>
        <div class="al-foot">
          <span>${a.is_read ? '已处理' : a.sent_to_name ? '已推送给 ' + esc(a.sent_to_name) : '待处理'}</span>
          ${a.is_read ? '' : `<a onclick="handleAlert(${a.id})">标记已处理</a>`}
        </div>
      </div>`;
  }

  window.handleAlert = async (id) => {
    const note = prompt('处理备注（可留空）：', '已电话确认');
    if (note === null) return;
    await api.put('/alerts/' + id + '/handle', { handle_note: note });
    toast('已标记');
    renderAlerts(); renderDashboard();
  };
  $('ackAll').addEventListener('click', async () => {
    await api.put('/alerts/read-all', {});
    toast('已全部标记已处理');
    renderAlerts(); renderDashboard();
  });

  // ================= 语音提醒（录音） =================

  /** 时段显示名：只写「早上」看不出几点，拼成「早上 08:00」 */
  function slotLabel(s) {
    const t = String(s.dose_time || '').slice(0, 5);
    return (s.time_label ? s.time_label + ' ' : '') + t;
  }

  let recSlots = [];              // 录音页当前老人的时段（带 label），供「绑到某一顿」用
  let recSlotsElder = null;
  let recAudio = null;            // 列表试听共用这一个播放器，切下一段时不会叠着播

  async function loadRecSlots(elderId) {
    const key = String(elderId);
    if (recSlotsElder === key) return recSlots;
    const raw = await api.get('/schedules?elder_id=' + key).catch(() => []);
    recSlots = (raw || []).map((s) => Object.assign({}, s, { label: slotLabel(s) }));
    recSlotsElder = key;
    return recSlots;
  }

  /**
   * 列表是否正被用户占用
   * 10 秒轮询会整块重画 #recTable：正在试听会被掐断，拉开的下拉会被收回去。
   * 这两种情况先让路，别跟人抢手。
   */
  function recListBusy() {
    if (recAudio && !recAudio.paused && !recAudio.ended) return true;
    return !!(document.activeElement && document.activeElement.closest('.vbind'));
  }

  async function renderRecordings() {
    const elderId = $('r_elder').value || currentElderId;
    if (!elderId) { $('recTable').innerHTML = emptyBlock('&#127908;', '请先新增老人'); return; }
    if (recListBusy()) return;

    const [list, slots] = await Promise.all([
      api.get('/recordings?elder_id=' + elderId),
      loadRecSlots(elderId),
    ]);

    // 录音表单里那个「绑定时段」下拉和列表共用同一份时段数据。
    // 它原来只在打开「服药计划」页时才被填充，直接进录音页录第一段时是空的。
    const rs = $('r_schedule');
    if (rs && rs.dataset.elder !== String(elderId)) {
      fillSelect(rs, slots, 'id', 'label', '--通用/不限时段--');
      rs.dataset.elder = String(elderId);
    }

    const bound = list.filter((r) => r.schedule_id).length;
    $('vlistSub').textContent = list.length
      ? `共 ${list.length} 段 · ${bound ? bound + ' 段已绑定到具体时段' : '都还没绑定时段'}`
      : '还没有录音';

    // 绑定下拉：一个时段一条，选中这条录音当前绑的那一个
    const slotOpts = (sel) => ['<option value="">通用 · 不限时段</option>']
      .concat(slots.map((s) => `<option value="${s.id}"${Number(sel) === Number(s.id) ? ' selected' : ''}>${esc(s.label)}</option>`))
      .join('');

    $('recTable').innerHTML = list.length ? list.map((r) => `
      <div class="vitem">
        <button class="vplay" data-src="${esc(r.audio_url)}" onclick="playRec(${r.id}, this)" title="试听这段录音">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>
        <div class="vmeta">
          <b>${esc(r.title)}${r.is_birthday_egg ? '<span class="dtag">彩蛋</span>' : ''}</b>
          <small>${esc(r.dialect || '普通话')}${r.duration_sec ? ' · ' + r.duration_sec + ' 秒' : ''} · ${r.schedule_id ? '到点优先播这段' : '通用，没绑定时段才轮到'}</small>
        </div>
        <div class="vacts">
          <select class="vbind" data-prev="${r.schedule_id || ''}" onchange="bindRec(${r.id}, this)" title="这段录音在哪一顿播">${slotOpts(r.schedule_id)}</select>
          <span class="vlink del" onclick="delRec(${r.id})">删除</span>
        </div>
      </div>`).join('') : emptyBlock('&#127908;', '还没有录音');
  }

  /**
   * 试听一段录音
   *
   * 这里原来是「圆形播放钮只管变色、真正出声靠右边一个 150px 宽的 <audio>」——
   * 那个宽度下浏览器会把进度条压没，只剩一个播放键和一个喇叭，看着像个坏控件。
   * 现在由圆钮自己播，整条只留一个播放入口，省下的宽度给标题和绑定下拉。
   */
  window.playRec = (id, btn) => {
    if (!recAudio) {
      recAudio = new Audio();
      recAudio.preload = 'none';
    }
    // 再点一次正在播的那条 = 暂停
    if (recAudio.dataset.id === String(id) && !recAudio.paused) {
      recAudio.pause();
      btn.classList.remove('on');
      return;
    }
    document.querySelectorAll('#recTable .vplay.on').forEach((b) => b.classList.remove('on'));
    recAudio.dataset.id = String(id);
    recAudio.src = btn.dataset.src;
    btn.classList.add('on');
    recAudio.onended = () => btn.classList.remove('on');
    recAudio.onerror = () => {
      btn.classList.remove('on');
      toast('播放失败，请让子女重录', true);
    };
    recAudio.play().catch(() => {
      btn.classList.remove('on');
      toast('播放失败，请让子女重录', true);
    });
  };

  /**
   * 把一段录音绑定到某一顿（选「通用」= 解绑）
   *
   * 一个时段只留一段：后端绑上新的同时，会把原来绑在这一段的那条放回通用，
   * 并在返回体里给一个 unbound 计数。所以要明说「原来那段改为通用」——
   * 不然用户会以为两段都还留着，只是新的不响。
   */
  window.bindRec = async (id, el) => {
    const val = el.value;
    const prev = el.dataset.prev || '';
    el.disabled = true;
    try {
      const saved = await api.put('/recordings/' + id, { schedule_id: val ? Number(val) : null });
      toast(!val ? '已改为通用提醒'
        : (saved && saved.unbound ? '已绑定，原来那段改为通用' : '已绑定，到点就播这一段'));
      await renderRecordings();
    } catch (e) {
      // 请求失败要把下拉恢复原状，不能让界面显示一个没存进去的值
      el.value = prev;
      el.disabled = false;
      await renderRecordings();
    }
  };

  window.delRec = async (id) => {
    await api.del('/recordings/' + id);
    toast('已删除');
    renderRecordings();
  };

  // 换老人：时段和录音都换人，时段缓存作废，表单里已选的时段也要让位
  $('r_elder').addEventListener('change', async () => {
    recSlotsElder = null;
    const rs = $('r_schedule');
    if (rs) { delete rs.dataset.elder; rs.value = ''; }
    await renderRecordings();
  });

  function resetRecUI() {
    window.__audioBase64 = null;
    window.__audioExt = null;
    const p = $('recPlay');
    if (p) { try { p.pause(); } catch (e) {} p.removeAttribute('src'); p.style.display = 'none'; }
    $('btnRecord').disabled = false;
    $('recState').textContent = '未录音';
    $('recActions').style.display = 'none';
    $('btnStop').style.display = '';
    $('btnDeleteRec').style.display = 'none';
    $('btnSaveRec').disabled = false;
  }

  $('btnRecord').addEventListener('click', async () => {
    // 环境检查：getUserMedia 只在安全上下文（https 或 localhost）可用，
    // 内置预览/iframe 沙箱通常拿不到麦克风，需在真实浏览器打开 localhost:3000
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('当前环境不支持录音，请用 Chrome/Edge 打开 http://localhost:3000 再试', true);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // 选择浏览器支持的音频格式（兼容 Chrome/Edge/Safari）
      let mimeType = '';
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
      if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
        for (const t of candidates) {
          if (MediaRecorder.isTypeSupported(t)) { mimeType = t; break; }
        }
      }
      const ext = mimeType.includes('mp4') ? 'm4a' : 'webm';

      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onerror = () => toast('录音出错，请重试', true);
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());   // 释放麦克风
        if (!audioChunks.length) {
          toast('未录到声音，请重试', true);
          resetRecUI();
          return;
        }
        const blob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
        const reader = new FileReader();
        reader.onload = () => {
          $('recPlay').src = URL.createObjectURL(blob);
          $('recPlay').style.display = 'inline-block';
          window.__audioBase64 = reader.result;
          window.__audioExt = ext;
          $('recState').textContent = '录音完成，可试听、保存或删除';
          $('btnStop').style.display = 'none';
          $('btnDeleteRec').style.display = '';
          $('btnSaveRec').disabled = false;
        };
        reader.readAsDataURL(blob);
      };

      mediaRecorder.start();
      $('btnRecord').disabled = true;
      $('recActions').style.display = 'flex';
      $('btnStop').style.display = '';
      $('btnDeleteRec').style.display = 'none';
      $('btnSaveRec').disabled = true;
      $('recState').textContent = '● 正在录音…';
    } catch (e) {
      const msg = (e && e.name === 'NotAllowedError') ? '麦克风权限被拒绝，请在浏览器地址栏允许麦克风权限'
        : (e && e.name === 'NotFoundError') ? '未检测到麦克风设备'
        : (e && e.name === 'NotReadableError') ? '麦克风被其他程序占用'
        : (e && e.message) || '无法访问麦克风';
      toast(msg, true);
    }
  });

  $('btnStop').addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  });

  $('btnDeleteRec').addEventListener('click', () => {
    resetRecUI();
  });

  $('btnSaveRec').addEventListener('click', async () => {
    const title = $('r_title').value.trim();
    const elderId = $('r_elder').value || currentElderId;
    if (!title) return toast('请填写标题', true);
    if (!window.__audioBase64) return toast('请先录音', true);

    const up = await api.post('/recordings/upload', { base64: window.__audioBase64, ext: window.__audioExt || 'webm' });
    await api.post('/recordings', {
      elder_id: Number(elderId),
      schedule_id: $('r_schedule').value ? Number($('r_schedule').value) : null,
      title,
      audio_url: up.url,
      dialect: $('r_dialect').value || null,
    });
    toast('录音已保存');
    $('r_title').value = '';
    resetRecUI();
    renderRecordings();
  });

  $('seeElder').addEventListener('click', () => { window.open('/elder.html', '_blank'); });
  $('seeElderTop').addEventListener('click', () => { window.open('/elder.html', '_blank'); });
  $('toElder').addEventListener('click', () => { window.open('/elder.html', '_blank'); });

  // ================= 老人档案 =================
  function renderElders() {
    if (!elders.length) {
      $('elderList').innerHTML = emptyBlock('&#128100;', '还没有老人档案');
      return;
    }
    $('elderList').innerHTML = elders.map((e) => `
      <div class="fb-elder">
        <span class="avatar">${esc((e.name || '?').slice(0, 1))}</span>
        <div class="tx">
          <b>${esc(e.name)}<em>${e.age ? e.age + ' 岁' : ''}</em></b>
          <small>${esc(e.chronic_diseases || '无慢病记录')}${Number(e.co_users) > 1 ? ` · ${e.co_users}人共用` : ''}</small>
        </div>
        <a class="txtlink" onclick="switchElder(${e.id})">设为当前</a>
        <a class="txtlink danger" onclick="deleteElder(${e.id})">删除</a>
      </div>`).join('');
  }
  window.switchElder = async (id) => {
    currentElderId = id;
    $('planElderSel').value = id;
    toast('已切换');
    await loadSchedules();
    renderDashboard();
    renderRemindToday();
    loadPolicyForm();
  };
  window.deleteElder = async (id) => {
    if (!confirm('删除老人档案会连带删除其服药计划与记录，确定吗？')) return;
    await api.del('/elders/' + id);
    toast('已删除');
    currentElderId = null;
    await loadAll();
  };

  // 新增老人按钮（内联 + 弹窗）
  $('btnAddElderInline').addEventListener('click', () => openModal('elderModal'));
  $('btnAddElder').addEventListener('click', async () => {
    const name = $('e_name').value.trim();
    if (!name) return toast('请填写姓名', true);
    await api.post('/elders', {
      name,
      gender: $('e_gender').value,
      birth_date: $('e_birth').value || null,
      age: $('e_age').value ? Number($('e_age').value) : null,
      hearing_level: $('e_hearing').value,
      vision_level: $('e_vision').value,
      chronic_diseases: $('e_chronic').value || null,
      allergies: $('e_allergy').value || null,
    });
    toast('新增成功');
    closeModal('elderModal');
    $('e_name').value = '';
    await loadAll();
  });

  // ================= 药箱设备 =================
  function renderMedboxes() {
    if (!medboxes.length) {
      $('medboxList').innerHTML = '<div class="hint" style="padding:8px 0">还没有药箱设备</div>';
      return;
    }
    $('medboxList').innerHTML = medboxes.map((b) => `
      <div class="fb-bind-row">
        <span>${esc(b.device_code)}</span>
        <span class="tag ${b.status === 'online' ? 'primary' : ''}">${b.status === 'online' ? '在线' : '离线'}</span>
      </div>`).join('');
  }

  // ================= 家庭成员 =================
  function renderMembers() {
    const cnt = $('famCount');
    if (cnt) cnt.textContent = `${members.length} 位`;
    $('famSub').textContent = `${elders.length} 位老人 · ${members.length} 位照护成员`;
    if (!members.length) {
      $('famGrid').innerHTML = emptyBlock('&#128100;', '暂无成员');
      return;
    }
    const roleTxt = { owner: '主配置人', member: '可配置', viewer: '只读' };
    $('famGrid').innerHTML = members.map((m) => {
      const prefs = (m.alert_prefs || '').split(',').filter(Boolean);
      const alertNames = {
        missed: '漏服', duplicate: '重复取药', night_open: '夜间异常', offline: '设备离线',
        stock_low: '库存不足', drug_conflict: '用药冲突', sos: 'SOS', repeat_missed: '连续漏服',
        expiry: '效期预警', fault: '设备故障',
      };
      return `
        <div class="card mem">
          <div class="mem-h">
            <span class="avatar lg ${m.role === 'owner' ? '' : 'alt'}">${esc((m.real_name || m.username || '?').slice(0, 1))}</span>
            <div class="tx">
              <b>${esc(m.real_name || m.username)}</b>
              <small>@${esc(m.username)} · ${esc(roleTxt[m.role] || m.role)}</small>
            </div>
          </div>
          <div class="mem-perm">
            <span class="pm y"><span class="tick">&#10003;</span>接收告警</span>
            <span class="pm ${m.push_enabled ? 'y' : ''}"><span class="tick">${m.push_enabled ? '&#10003;' : ''}</span>推送</span>
          </div>
          ${prefs.length ? `<div style="font-size:11.5px;color:var(--muted);margin-top:6px">订阅：${prefs.map((p) => esc(alertNames[p] || p)).join('、')}</div>` : ''}
          <div class="mem-foot">
            <span>${m.role === 'owner' ? '家庭创建者' : '照护成员'}</span>
            <a class="txtlink" onclick="openMember(${m.id})">管理</a>
          </div>
        </div>`;
    }).join('') + `
      <div class="card mem invite" onclick="openModal('inviteModal')">
        <b>+ 邀请新成员</b>
        <p>让家人一起查看老人的用药情况</p>
      </div>`;
  }

  // 管理成员弹窗
  let editingMemberId = null;
  window.openMember = (id) => {
    const m = members.find((x) => x.id === id);
    if (!m) return;
    editingMemberId = id;
    $('mmAvatar').textContent = (m.real_name || m.username || '?').slice(0, 1);
    $('mmName').textContent = m.real_name || m.username;
    $('mmMeta').textContent = '@' + m.username;
    document.querySelectorAll('#mmRoles button').forEach((b) => b.classList.toggle('on', b.dataset.r === m.role));
    const prefs = (m.alert_prefs || '').split(',').filter(Boolean);
    document.querySelectorAll('#mmAlerts button').forEach((b) => b.classList.toggle('on', prefs.includes(b.dataset.a)));
    const canRemove = m.role !== 'owner' && meUser && meUser.role === 'owner';
    $('mmRemove').style.display = canRemove ? '' : 'none';
    openModal('mmModal');
  };

  document.querySelectorAll('#mmRoles button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#mmRoles button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
    });
  });
  document.querySelectorAll('#mmAlerts button').forEach((b) => {
    b.addEventListener('click', () => b.classList.toggle('on'));
  });

  $('mmSave').addEventListener('click', async () => {
    const role = (document.querySelector('#mmRoles button.on') || {}).dataset.r;
    const prefs = [...document.querySelectorAll('#mmAlerts button.on')].map((b) => b.dataset.a);
    await api.put('/users/' + editingMemberId, {
      role,
      alert_prefs: prefs.join(','),
    });
    toast('已保存');
    closeModal('mmModal');
    await loadAll();
  });

  $('mmRemove').addEventListener('click', async () => {
    if (!confirm('确定移除该成员？')) return;
    await api.del('/users/' + editingMemberId);
    toast('已移除');
    closeModal('mmModal');
    await loadAll();
  });

  $('inviteBtn').addEventListener('click', () => openModal('inviteModal'));
  $('btnInvite').addEventListener('click', async () => {
    const username = $('u_username').value.trim();
    const password = $('u_password').value;
    if (!username) return toast('请填写账号', true);
    if (!password || password.length < 6) return toast('密码至少 6 位', true);
    await api.post('/users', {
      username,
      password,
      real_name: $('u_realname').value || username,
      role: $('u_role').value,
    });
    toast('已邀请');
    closeModal('inviteModal');
    ['u_username', 'u_password', 'u_realname'].forEach((i) => { $(i).value = ''; });
    await loadAll();
  });

  // ================= 数据管理（导出 / 清空，对应方案书「一键导出与删除」） =================
  $('btnExportData').addEventListener('click', async () => {
    toast('正在导出数据…');
    try {
      const d = await api.get('/export/family-data');
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '安心格_家庭数据_' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(a.href);
      toast('已导出');
    } catch (e) { /* 接口层已 toast */ }
  });

  $('btnDeleteData').addEventListener('click', async () => {
    if (!confirm('确定清空本家庭的全部服药记录与告警吗？\n此操作不可恢复，老人、药品、计划配置会保留。')) return;
    try {
      await api.del('/export/family-data');
      toast('已清空历史数据');
      await loadAll();
    } catch (e) { /* 接口层已 toast */ }
  });

  // ================= 药品（弹窗增删改） =================
  let _recogBarcode = null;   // 拍照识药读到的条码，保存时随药品字段一起入库
  let _editingMedId = null;   // 正在编辑的药品 id；null 表示新增模式

  // 复位弹窗为「新增」默认态（清空字段 + 还原标题/按钮/状态）
  function resetMedForm() {
    ['m_name', 'm_spec', 'm_manu', 'm_appear', 'm_contra', 'm_ingredient'].forEach((i) => { $(i).value = ''; });
    $('m_stock').value = '60';
    $('m_alert').value = '14';
    $('m_unit').value = '片';
    $('m_expiry').value = '';
    $('m_category').value = '';
    _editingMedId = null;
    $('medModalTitle').textContent = '添加药品';
    $('btnAddMed').textContent = '添加到在库清单';
  }

  $('addMedBtn').addEventListener('click', () => { resetMedForm(); resetMedPhotoUI(); openModal('medModal'); });

  // 从弹窗表单读取并提交；新增用 POST、编辑用 PUT。返回是否成功
  async function saveMedicine() {
    const name = $('m_name').value.trim();
    if (!name) { toast('请先填写药名', true); return false; }
    const payload = {
      name, spec: $('m_spec').value || null, manufacturer: $('m_manu').value || null,
      unit: $('m_unit').value || '片',
      active_ingredient: $('m_ingredient').value.trim() || null,
      stock_qty: Number($('m_stock').value || 0),
      stock_alert_qty: Number($('m_alert').value || 7),
      expiry_date: $('m_expiry').value || null,
      category: $('m_category').value || null,
      appearance: $('m_appear').value || null,
      contraindication: $('m_contra').value || null,
    };
    // 仅当拍照识别出条码时才携带；编辑时不带则保留原条码不被清空
    if (_recogBarcode) payload.barcode = _recogBarcode;
    try {
      if (_editingMedId) await api.put('/medicines/' + _editingMedId, payload);
      else await api.post('/medicines', payload);
      return true;
    } catch (e) {
      return false;
    }
  }

  $('btnAddMed').addEventListener('click', async () => {
    const isEdit = !!_editingMedId;
    if (!(await saveMedicine())) return;
    toast(isEdit ? '已保存修改' : '药品已入库');
    closeModal('medModal');
    resetMedForm();
    resetMedPhotoUI();
    await loadAll();
  });

  // 打开「编辑药品」：回填当前字段，切换到编辑模式
  function openEditMed(id) {
    const m = medicines.find((x) => String(x.id) === String(id));
    if (!m) { toast('未找到该药品', true); return; }
    _editingMedId = m.id;
    $('m_name').value = m.name || '';
    $('m_spec').value = m.spec || '';
    $('m_unit').value = m.unit || '片';
    $('m_manu').value = m.manufacturer || '';
    $('m_ingredient').value = m.active_ingredient || '';
    $('m_stock').value = m.stock_qty ?? 0;
    $('m_alert').value = m.stock_alert_qty ?? 7;
    $('m_expiry').value = m.expiry_date ? String(m.expiry_date).slice(0, 10) : '';
    $('m_category').value = m.category || '';
    $('m_appear').value = m.appearance || '';
    $('m_contra').value = m.contraindication || '';
    $('medModalTitle').textContent = '编辑药品';
    $('btnAddMed').textContent = '保存修改';
    resetMedPhotoUI();
    openModal('medModal');
  }

  // 删除药品（二次确认后调用 DELETE 接口）
  async function deleteMed(id) {
    const m = medicines.find((x) => String(x.id) === String(id));
    if (!m) { toast('未找到该药品', true); return; }
    if (!confirm(`确定删除「${m.name}」？若该药已被加入服药计划，需先将其从计划中移除后才能删除。`)) return;
    try {
      await api.del('/medicines/' + m.id);
      toast('已删除');
      await loadAll();
    } catch (e) { /* 接口层已提示 */ }
  }

  // ================= 拍照识药（视觉模型回填表单） =================
  function resetMedPhotoUI() {
    if ($('medPhotoInput')) $('medPhotoInput').value = '';
    _recogBarcode = null;
    const note = $('medRecogNote');
    if (note) { note.style.display = 'none'; note.textContent = ''; }
  }

  $('btnMedPhoto').addEventListener('click', () => $('medPhotoInput').click());

  $('medPhotoInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('图片过大，请压缩后重试（≤8MB）', true); return; }

    const note = $('medRecogNote');
    note.style.display = 'block';
    note.className = 'recog-note';
    note.textContent = '正在识别图片，请稍候…';

    // 压缩到合理尺寸（视觉模型对超大图不友好，也省带宽）
    const dataUrl = await shrinkImage(file, 1280).catch(() => null);
    if (!dataUrl) { note.textContent = '图片读取失败，请重试或手工填写。'; return; }

    try {
      const r = await api.post('/vision/recognize', { image: dataUrl });
      if (r && r.ok && r.medicine) {
        const m = r.medicine;
        if (m.name) $('m_name').value = m.name;
        if (m.spec) $('m_spec').value = m.spec;
        if (m.manufacturer) $('m_manu').value = m.manufacturer;
        if (m.active_ingredient) $('m_ingredient').value = m.active_ingredient;
        if (m.category) {
          const opts = [...$('m_category').options].map((o) => o.value);
          $('m_category').value = opts.includes(m.category) ? m.category : '其他';
        }
        if (m.appearance) $('m_appear').value = m.appearance;
        if (m.contraindication) $('m_contra').value = m.contraindication;
        if (m.expiry_date && /^\d{4}-\d{2}-\d{2}/.test(String(m.expiry_date))) {
          $('m_expiry').value = String(m.expiry_date).slice(0, 10);
        }
        _recogBarcode = m.barcode || null;

        // 拍照即添加：识别到药名就自动入库，省去手动核对保存这步
        if (m.name && m.name.trim()) {
          note.className = 'recog-note ok';
          note.textContent = `已识别「${m.name}」${m.barcode ? `（条码 ${m.barcode}）` : ''}，正在自动入库…`;
          const saved = await saveMedicine();
          if (saved) {
            const wasEdit = !!_editingMedId;
            toast(wasEdit ? '已拍照识别并更新' : '已拍照识别并自动入库');
            closeModal('medModal');
            resetMedForm();
            resetMedPhotoUI();
            await loadAll();
          } else {
            note.className = 'recog-note';
            note.textContent = '已识别信息，但自动入库未成功，请核对后手动保存。';
          }
        } else {
          note.className = 'recog-note';
          note.textContent = '已识别部分字段，但未识别出药名，请核对补充后再保存。';
        }
      } else {
        note.textContent = (r && r.note) || '未识别出药品，请拍得更清晰或手工填写。';
      }
    } catch (err) {
      note.textContent = '识别请求失败，请手工填写药品信息。';
    }
  });

  /** 把图片缩放压缩到 maxEdge 边长以内，返回 jpeg dataURL（降低体积、加速识别） */
  function shrinkImage(file, maxEdge) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        if (width > maxEdge || height > maxEdge) {
          const scale = maxEdge / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
      img.src = url;
    });
  }

  // ================= AI 用药助手 =================
  const INSIGHT_META = {
    missed: { ico: '&#9888;&#65039;', pri: 'warn' },
    adherence_drop: { ico: '&#128201;', pri: 'warn' },
    duplicate: { ico: '&#128308;', pri: 'crit' },
    stock_low: { ico: '&#128230;', pri: 'warn' },
    time_irregular: { ico: '&#128337;', pri: 'info' },
    drug_interaction: { ico: '&#9888;&#65039;', pri: 'crit' },
    expiring: { ico: '&#9200;&#65039;', pri: 'warn' },
    reminder: { ico: '&#9989;', pri: 'info' },
  };

  // 依据字段名（后端 evidence.metric）→ 中文，避免界面出现英文
  const METRIC_LABEL = {
    missed_count: '漏服次数',
    duplicate_count: '重复取药次数',
    stock_qty: '当前库存',
    adherence_recent: '近期按时率',
    adherence_prev: '此前按时率',
    interaction: '涉及药品',
    window_days: '统计天数',
  };

  async function loadInsights() {
    try {
      const d = await api.get('/assistant/insights?days=7');
      const s = d.summary || {};
      const crit = (d.insights || []).filter((i) => i.priority === 'critical').length;

      $('aiSummary').innerHTML = `
        <span class="chip">关注老人 <b>${s.elders ?? 0}</b> 位</span>
        <span class="chip ${s.missedTotal ? 'warn' : ''}">漏服 <b>${s.missedTotal ?? 0}</b></span>
        <span class="chip ${s.duplicateTotal ? 'warn' : ''}">重复 <b>${s.duplicateTotal ?? 0}</b></span>
        <span class="chip ${s.lowStockCount ? 'crit' : ''}">库存不足 <b>${s.lowStockCount ?? 0}</b> 种</span>
        <span class="chip ${crit ? 'crit' : ''}">紧急建议 <b>${crit}</b> 条</span>`;

      const list = d.insights || [];
      $('insightList').innerHTML = list.length
        ? list.map((it) => {
            const meta = INSIGHT_META[it.type] || { ico: '&#128161;', pri: 'info' };
            const pri = it.priority || meta.pri;
            const ev = (it.evidence || []).map((e) => {
              const label = METRIC_LABEL[e.metric] || e.metric;
              if (e.drugs) {
                return `<span class="ev-item">${label}：<b>${esc(e.drugs.join('、'))}</b></span>`;
              }
              let val = e.value;
              if (e.metric === 'adherence_recent' || e.metric === 'adherence_prev') {
                val = Math.round(Number(e.value) * 100) + '%';
              }
              return `<span class="ev-item">${label}：<b>${esc(val)}</b>${e.threshold != null ? ' / 预警线 ' + esc(e.threshold) : ''}</span>`;
            }).join('');
            const reviewed = (it.evidence || []).some((e) => e.reviewed === 'llm');
            const reviewBadge = it.type === 'drug_interaction'
              ? (reviewed
                  ? '<span class="badge accent" style="margin-left:auto">&#129302; AI 已二次研判</span>'
                  : '<span class="badge" style="margin-left:auto">规则初判</span>')
              : '';
            return `
              <div class="insight ${pri}">
                <div class="i-head">
                  <span class="i-ico">${meta.ico}</span>
                  <span class="i-title">${esc(it.title)}</span>
                  ${reviewBadge}
                  <span class="i-time">${ago(it.generatedAt)}</span>
                </div>
                <div class="i-body">${esc(it.body)}</div>
                ${ev ? `<div class="i-evidence">依据：${ev}</div>` : ''}
              </div>`;
          }).join('')
        : emptyBlock('&#129302;', '暂时没有建议，助手会持续盯着数据');
    } catch (e) {
      $('insightList').innerHTML = emptyBlock('&#9888;', '加载建议失败');
    }
  }

  function ago(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    return Math.floor(h / 24) + ' 天前';
  }

  $('btnRefreshInsights').addEventListener('click', async () => {
    toast('正在重新分析…');
    await loadInsights();
  });

  // AI 主动分析：每 60 秒自动刷新一次（总览 AI 建议卡 + AI 助手页主动建议），不随 10 秒轮询调 LLM
  setInterval(() => {
    if (document.hidden) return;
    renderAiCard();
    const av = document.getElementById('view-assistant');
    if (av && av.classList.contains('active')) loadInsights();
  }, 60000);

  function appendMsg(role, text, sources, engine) {
    const log = $('chatLog');
    const div = document.createElement('div');
    div.className = 'chat-msg ' + (role === 'user' ? 'user' : 'ai');
    const srcHtml = (sources && sources.length)
      ? `<div class="src">${sources.map((s) => `<span class="s-chip">${s.type === 'rule' ? '&#128214;' : s.type === 'llm' ? '&#129302;' : '&#128279;'} ${esc(s.label)}</span>`).join('')}</div>`
      : '';
    const engineTag = (role === 'ai' && engine === 'llm')
      ? `<span class="s-chip" style="color:#8B6FC0;border-color:rgba(139,111,192,.4)">&#129302; AI 生成</span>` : '';
    div.innerHTML = `
      <div class="av">${role === 'user' ? '&#128100;' : '&#129302;'}</div>
      <div class="bubble">${esc(text)}${srcHtml}<div class="src" style="margin-top:2px">${engineTag}</div></div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  async function askAssistant() {
    const q = $('chatInput').value.trim();
    if (!q) return toast('请输入问题', true);
    appendMsg('user', q);
    $('chatInput').value = '';
    const bubble = appendStreamBubble();
    try {
      await streamAsk(q, { onDelta: (txt) => bubble.append(txt) });
      bubble.done();
    } catch (e) {
      bubble.fail('抱歉，暂时无法回答这个问题，请稍后再试。');
    }
  }

  /** 建立一个可流式更新的 AI 气泡，返回 { append, done, fail } */
  function appendStreamBubble() {
    const log = $('chatLog');
    const div = document.createElement('div');
    div.className = 'chat-msg ai';
    const av = document.createElement('div');
    av.className = 'av';
    av.innerHTML = '&#129302;';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    div.appendChild(av);
    div.appendChild(bubble);
    log.appendChild(div);
    let acc = '';
    const scrollBottom = () => { log.scrollTop = log.scrollHeight; };
    const render = (tail) => { bubble.innerHTML = esc(acc) + tail; scrollBottom(); };
    return {
      append(txt) { acc += txt; render('<span class="stream-caret">▍</span>'); },
      done() {
        render('<div class="src" style="margin-top:2px"><span class="s-chip" style="color:#8B6FC0;border-color:rgba(139,111,192,.4)">&#129302; AI 生成</span></div>');
      },
      fail(msg) { bubble.innerHTML = esc(msg); scrollBottom(); },
    };
  }

  /** 通过 SSE 调用 /assistant/ask-stream，用浏览器原生 ReadableStream 逐段读取 */
  async function streamAsk(question, handlers) {
    const t = api.getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (t) headers['Authorization'] = 'Bearer ' + t;

    const res = await fetch('/api/assistant/ask-stream', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ question }),
    });

    // 401：静默续期后重放一次
    if (res.status === 401 && t) {
      const ok = await api.tryRefresh();
      if (ok) return streamAsk(question, handlers);
      api.goLogin();
      throw new Error('登录已过期');
    }
    if (!res.ok || !res.body) {
      let msg = '请求失败';
      try { msg = (await res.json()).error || msg; } catch (e) { /* 保留默认 */ }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let errorMsg = '';
    let doneEvent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSSE(chunk);
        if (!ev) continue;
        if (ev.event === 'delta' && ev.data && ev.data.text) {
          handlers.onDelta(ev.data.text);
        } else if (ev.event === 'error') {
          errorMsg = (ev.data && ev.data.error) || '生成失败';
        } else if (ev.event === 'done') {
          doneEvent = true;
        }
      }
    }

    if (errorMsg) throw new Error(errorMsg);
    if (!doneEvent) throw new Error('生成中断，请重试');
  }

  /** 解析一段 SSE 事件块（event: xx / data: {...}） */
  function parseSSE(chunk) {
    let event = 'message';
    let data = '';
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return null;
    let parsed;
    try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
    return { event, data: parsed };
  }

  $('btnAsk').addEventListener('click', askAssistant);
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askAssistant(); }
  });

  // ================= 移动 AI 对话窗口（悬浮球 + 可拖拽面板） =================
  function aiAppend(role, text, tag) {
    const log = $('aiPanelLog');
    const div = document.createElement('div');
    div.className = 'ai-msg ' + (role === 'user' ? 'user' : 'ai');
    div.innerHTML = `<div class="bubble">${esc(text)}${tag ? `<div class="tag">${tag}</div>` : ''}</div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  function aiTyping() {
    const log = $('aiPanelLog');
    const div = document.createElement('div');
    div.className = 'ai-msg ai';
    div.id = 'aiTyping';
    div.innerHTML = `<div class="bubble"><span class="ai-typing"><i></i><i></i><i></i></span></div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }
  function aiUntyping() { const t = $('aiTyping'); if (t) t.remove(); }

  let pendingConfirm = null;

  async function aiSend() {
    const input = $('aiPanelInput');
    const q = input.value.trim();
    if (!q) return;
    aiAppend('user', q);
    input.value = '';
    aiTyping();
    try {
      const r = await api.post('/agent/chat', { message: q });
      aiUntyping();
      const tools = r.actions || [];
      if (r.needsConfirm) {
        pendingConfirm = r.pending || [];
        aiAppend('ai', r.answer || '需要确认', '');
        $('aiConfirmText').textContent = `确认执行 ${pendingConfirm.length} 个删除操作？`;
        $('aiConfirm').style.display = 'flex';
      } else {
        const tag = tools.length
          ? '已自动执行：' + tools.map((a) => a.tool).join('、')
          : (r.engine === 'rule' ? '降级模式（AI 未连接）' : '');
        aiAppend('ai', r.answer || '（无回复）', tag);
        // 写操作后刷新相关视图
        if (tools.some((a) => a.ok && ['create_schedule', 'add_medicine', 'add_elder', 'update_medicine', 'delete_schedule', 'delete_medicine', 'delete_elder'].includes(a.tool))) {
          loadAll();
        }
      }
    } catch (e) {
      aiUntyping();
      aiAppend('ai', '抱歉，出了点问题，请稍后再试。');
    }
  }

  $('aiConfirmYes').addEventListener('click', async () => {
    $('aiConfirm').style.display = 'none';
    const ops = pendingConfirm || [];
    pendingConfirm = null;
    if (!ops.length) return;
    aiTyping();
    try {
      const answers = [];
      for (const op of ops) {
        const r = await api.post('/agent/chat', { message: '确认执行', confirm: { tool: op.tool, args: op.args } });
        answers.push(r.answer || '');
      }
      aiUntyping();
      aiAppend('ai', answers.join('\n') || '已完成', '');
      loadAll();
    } catch (e) {
      aiUntyping();
      aiAppend('ai', '确认执行失败，请稍后再试。');
    }
  });
  $('aiConfirmNo').addEventListener('click', () => {
    $('aiConfirm').style.display = 'none';
    pendingConfirm = null;
    aiAppend('ai', '已取消删除操作。');
  });

  $('aiPanelSend').addEventListener('click', aiSend);
  $('aiPanelInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); aiSend(); }
  });

  // 悬浮球：点击开关面板（拖拽过则不触发点击）
  let fabMoved = false;
  $('aiFab').addEventListener('click', () => {
    if (fabMoved) return;
    const p = $('aiPanel');
    const open = p.style.display === 'none';
    p.style.display = open ? 'flex' : 'none';
    if (open) $('aiPanelInput').focus();
  });
  $('aiPanelClose').addEventListener('click', () => { $('aiPanel').style.display = 'none'; });

  // 通用拖拽：把元素拖到任意位置（fixed 定位）
  function makeDraggable(handle, target) {
    let dragging = false, startX = 0, startY = 0, ox = 0, oy = 0, moved = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY;
      const rect = target.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      target.style.left = (ox + dx) + 'px';
      target.style.top = (oy + dy) + 'px';
      target.style.right = 'auto';
      target.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (dragging && moved && target === $('aiFab')) fabMoved = true;
      dragging = false;
      setTimeout(() => { if (target === $('aiFab')) fabMoved = false; }, 0);
    });
  }
  makeDraggable($('aiFab'), $('aiFab'));
  makeDraggable($('aiPanelHead'), $('aiPanel'));

  // 通知铃铛：点开显示未读告警
  $('bellBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const panel = $('notifPanel');
    if (panel.classList.contains('open')) { panel.classList.remove('open'); return; }
    // 先立即打开面板并显示加载中，避免网络慢时看起来「点了没反应」
    panel.innerHTML = '<div class="nh">通知<span>加载中…</span></div><div class="nrow"><small>正在加载…</small></div>';
    panel.classList.add('open');
    try {
      const list = await api.get('/alerts?limit=8&is_read=0');
      // 查看过通知：记录已看到的最大告警 id，并取消红点
      if (list.length) lastSeenAlertId = Math.max(lastSeenAlertId, Number(list[0].id));
      $('bellDot').style.display = 'none';
      panel.innerHTML = `
        <div class="nh">通知<span>${list.length} 条未读</span></div>
        ${list.length ? list.map((a) => `
          <a class="nrow" data-alert="${a.id}">
            <b>${esc(alertLabel(a.alert_type))}</b>
            <small>${esc(a.content)}</small>
          </a>`).join('') : '<div class="nrow"><small>没有新通知</small></div>'}`;
      // 点击某条通知：跳到告警中心并收起面板
      panel.querySelectorAll('.nrow[data-alert]').forEach((row) => {
        row.addEventListener('click', () => {
          panel.classList.remove('open');
          go('alert');
        });
      });
    } catch (err) {
      panel.innerHTML = '<div class="nh">通知</div><div class="nrow"><small>加载失败，请稍后再试</small></div>';
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.bellwrap')) $('notifPanel').classList.remove('open');
  });

  // ---------- 启动 ----------
  await loadAll();
  startLiveSync();

  // ================= 实时同步 =================
  let lastAlertId = 0;
  let liveBaselineDone = false;
  let lastSeenAlertId = 0;   // 用户已查看的最大告警 id（打开铃铛后更新，用于红点）

  function startLiveSync() {
    liveTick();
    setInterval(liveTick, 10000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) liveTick();
    });
    document.addEventListener('click', function askNotify() {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      document.removeEventListener('click', askNotify);
    });
  }

  /**
   * 轮询时机守卫 —— 判断「这一轮该不该刷新」。
   *
   * 为什么要这层判断：
   *   轮询是静默的，用户不知道它什么时候来。如果正好赶上他在填「新增计划」的表单，
   *   或者在搜索框里打字，一次整块重渲染会把输入内容冲掉 —— 那比不同步更糟。
   *   所以只要界面处于「用户正在操作」的状态，就跳过这一轮，等下次。
   *
   * 手机端有同样的逻辑（public/m/js/app.js 的 syncBlocked），两端保持一致。
   */
  function pollBlocked() {
    if (document.hidden) return true;                        // 标签页在后台，刷新没意义
    if (document.querySelector('.modal.open')) return true;   // 弹窗表单开着
    if (document.querySelector('.sheet.open')) return true;
    const el = document.activeElement;                       // 光标停在输入控件里
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
    return false;
  }

  async function liveTick() {
    if (document.hidden) return;
    try {
      const unread = await api.get('/alerts?limit=10&is_read=0');
      if (unread.length) {
        const newest = unread[0];
        if (liveBaselineDone && Number(newest.id) > lastAlertId) {
          notifyAlert(newest);
        }
        lastAlertId = Math.max(lastAlertId, Number(newest.id));
      }
      liveBaselineDone = true;

      const active = (id) => {
        const el = document.getElementById(id);
        return el && el.classList.contains('active');
      };

      // 按当前激活的页面刷新对应数据（覆盖全部 8 页）
      //
      // 守卫只包住「重渲染」这一段，不 return 整个函数：
      //   告警检测和下面的铃铛红点都只读数据 + 改样式，不会碰用户正在填的内容，
      //   必须照常跑 —— 否则用户开着表单时，紧急告警会连红点都不亮。
      //   真正「把界面重画一遍」的是下面这批渲染调用，只有它们需要在用户操作期间让路。
      if (!pollBlocked()) {
        if (active('view-overview')) await renderDashboard();
        if (active('view-plan')) { loadCompartments(); await loadSchedules(); }
        if (active('view-inventory')) { medicines = await api.get('/medicines'); renderInventory(); }
        if (active('view-remind')) { renderEvents(); renderRemindToday(); }
        if (active('view-alert')) renderAlerts();
        if (active('view-voice')) renderRecordings();
        if (active('view-family')) {
          elders = await api.get('/elders');
          medboxes = await api.get('/medbox');
          members = await api.get('/users');
          renderElders(); renderMedboxes(); renderMembers();
        }
      }
      // view-assistant 由 60 秒定时器负责（调 LLM，不随 10 秒轮询）

      // 更新铃铛红点：只有「用户还没看过」的新告警才亮红点
      const all = await api.get('/alerts?limit=1&is_read=0');
      const bellDot = $('bellDot');
      if (bellDot) {
        const newestId = all.length ? Number(all[0].id) : 0;
        bellDot.style.display = (newestId > lastSeenAlertId) ? 'block' : 'none';
      }
    } catch (e) {
      // 网络抖动，下一轮重试
    }
  }

  function notifyAlert(a) {
    const isSos = a.alert_type === 'sos';
    if (isSos) {
      toast('&#128222; ' + esc(a.content), true);
      beep(3);
    } else if (a.level === 'urgent') {
      toast('&#9888;&#65039; ' + esc(a.content), true);
      beep(2);
    } else {
      toast('&#128276; ' + esc(a.content));
      beep(1);
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(isSos ? '老人求救！' : '智能药箱提醒', { body: a.content, tag: 'mb-' + a.id });
      } catch (e) { /* ignore */ }
    }
    if (document.getElementById('view-alert').classList.contains('active')) renderAlerts();
    renderAlertMini();
  }

  function beep(times) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      for (let i = 0; i < times; i++) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'sine'; o.frequency.value = 880;
        const t = ctx.currentTime + i * 0.35;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        o.start(t); o.stop(t + 0.32);
      }
    } catch (e) { /* ignore */ }
  }
})();
