/**
 * 安心格 · 移动端子女端逻辑
 *
 * 数据来源：与 Web 端完全相同的 /api（同一个 Node 服务、同一个 smart_medbox 库、同一套 JWT）
 * 代码分层：data.js 取数/格式化 → 本文件渲染/交互
 *
 * 页面结构：5 个主 tab（总览/计划/药箱/记录/我的）+ 4 个全屏子页（告警/AI/语音/家庭）
 */
(async function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ==================== 登录守卫 ==================== */
  api.setUnauthorizedHandler(() => {
    api.clearToken();
    location.href = '/m/login.html?from=' + encodeURIComponent(location.pathname);
  });

  async function guard() {
    if (api.getToken()) return true;
    if (await api.tryRefresh().catch(() => false)) return true;
    location.href = '/m/login.html?from=' + encodeURIComponent(location.pathname);
    return false;
  }

  if (!(await guard())) return;

  /* ==================== 通用 UI ==================== */
  function empty(icon, text) {
    return `<div class="empty"><div class="e">${icon}</div><div class="t">${text}</div></div>`;
  }

  function showSkel(id, rows = 3) {
    const el = $(id);
    if (el) el.innerHTML = Array.from({ length: rows }, () => '<div class="skel"></div>').join('');
  }

  /* ---------- 底部弹层 ---------- */
  let sheetOnMount = null;
  let sheetOnCancel = null;
  function openSheet({ title, sub = '', body = '', onMount = null }) {
    $('shTitle').textContent = title;
    $('shSub').textContent = sub;
    $('shSub').style.display = sub ? 'block' : 'none';
    $('shBody').innerHTML = body;
    $('mask').classList.add('on');
    $('sheet').classList.add('on');
    sheetOnMount = onMount;
    sheetOnCancel = null;
    if (onMount) onMount();
  }
  function closeSheet() {
    $('mask').classList.remove('on');
    $('sheet').classList.remove('on');
    sheetOnMount = null;
    const c = sheetOnCancel;
    sheetOnCancel = null;
    if (c) c();
  }
  $('mask').addEventListener('click', closeSheet);

  /**
   * 应用内确认框（返回 Promise<boolean>）
   * 不用原生 confirm 的原因：微信内置浏览器、以及部分预览 webview 会屏蔽
   * window.confirm，用户点了「全部处理」看起来毫无反应。
   */
  function askConfirm({ title, text = '', ok = '确定', cancel = '取消', danger = false }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      openSheet({
        title,
        body: `${text ? `<p style="font-size:13px;line-height:1.75;color:var(--sub);margin-bottom:4px">${text}</p>` : ''}
          <div class="sh-acts">
            <button class="btn-ghost" id="cf_no">${cancel}</button>
            <button class="btn-primary" id="cf_yes"${danger ? ' style="background:var(--bad)"' : ''}>${ok}</button>
          </div>`,
        onMount: () => {
          $('cf_no').addEventListener('click', () => { finish(false); closeSheet(); });
          $('cf_yes').addEventListener('click', () => { finish(true); closeSheet(); });
        },
      });
      // 点遮罩 / 返回 关闭时按取消处理
      sheetOnCancel = () => finish(false);
    });
  }

  /* ---------- 子页 ---------- */
  function openSub(id) {
    $(id).classList.add('on');
    onSubOpen(id);
  }
  function closeSub(id) {
    $(id).classList.remove('on');
    if (id === 'sp-assistant') paintTabs(curTab); // AI 页关闭后，底部高亮回到原来的 tab
  }
  function closeAllSubs() {
    document.querySelectorAll('.subpage.on').forEach((p) => closeSub(p.id));
  }
  document.querySelectorAll('[data-back]').forEach((b) => {
    b.addEventListener('click', () => closeSub(b.closest('.subpage').id));
  });

  /* ---------- tab 切换 ---------- */
  let curTab = 'overview';
  let curSeg = 'plan'; // 「用药」页分段：plan（服药计划）/ his（服药记录）

  /** 底部导航高亮（AI 页没有 data-tab，单独处理） */
  function paintTabs(active) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === active));
    const ai = document.querySelector('.tab-ai');
    if (ai) ai.classList.toggle('on', active === 'ai');
  }

  /** 「用药」页的两段切换 */
  function paintSeg() {
    document.querySelectorAll('#careSeg .seg-b').forEach((b) => b.classList.toggle('on', b.dataset.seg === curSeg));
    $('segPlan').style.display = curSeg === 'plan' ? '' : 'none';
    $('segHis').style.display = curSeg === 'his' ? '' : 'none';
  }
  function switchSeg(name) {
    curSeg = name;
    paintSeg();
    if (name === 'plan') renderPlan();
    else renderHistory();
  }

  function switchTab(name, seg) {
    if (seg) curSeg = seg;
    curTab = name;
    paintTabs(name);
    document.querySelectorAll('#app .view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + name));
    window.scrollTo(0, 0);
    if (name === 'care') switchSeg(curSeg);
    if (name === 'box') renderBox();
    if (name === 'history') renderHistory();
    if (name === 'me') renderMe();
  }
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      closeAllSubs();                       // 从 AI 页直接点别的 tab，也要能过去
      switchTab(t.dataset.tab);
    });
  });
  document.querySelectorAll('[data-go]').forEach((el) => {
    el.addEventListener('click', () => switchTab(el.dataset.go, el.dataset.seg));
  });
  document.querySelectorAll('[data-page]').forEach((el) => {
    el.addEventListener('click', () => openSub('sp-' + el.dataset.page));
  });

  /* 「用药」页分段按钮 */
  document.querySelectorAll('#careSeg .seg-b').forEach((b) => {
    b.addEventListener('click', () => switchSeg(b.dataset.seg));
  });

  /* ==================== 总览 ==================== */
  let dash = null;
  let insights = [];

  /**
   * 加载首页总览
   * @param {boolean} light 轻量模式：跳过 AI 建议
   *
   * 为什么要这个参数：
   *   /assistant/insights 是本地规则引擎（不调大模型，不花钱），但一次要跑 300 行
   *   规则 + 若干次查询，而「建议」这种内容根本不会 15 秒变一次。
   *   轮询走轻量模式，省掉这块开销，也避免 AI 卡片每 15 秒闪一下；
   *   首次加载、用户主动操作（打卡/切老人）才走全量，保证建议是最新的。
   */
  async function loadOverview(light) {
    const e = currentElder();
    if (!e) {
      $('ovHero').innerHTML = `<div class="hero muted"><div class="hl">还没有老人档案</div>
        <div class="ht">先添加一位家人</div>
        <div class="hs">添加老人后，这里会显示下一次该吃谁、吃哪几格。</div></div>`;
      $('ovStats').innerHTML = '';
      $('ovTimeline').innerHTML = empty('📋', '还没有服药计划');
      $('ovFocus').innerHTML = empty('✅', '库存与效期都健康');
      $('ovAlerts').innerHTML = empty('🔔', '暂无未处理告警');
      $('ovAi').innerHTML = '<div class="ai-body">添加老人和药品后，我会开始分析。</div>';
      $('topSub').textContent = '还没有老人档案';
      return;
    }

    // 首屏只等「一定要看到」的两块：服药总览、未读告警。
    // AI 建议单独在下面补 —— 它要跑规则引擎，还可能等大模型返回，
    // 放进 Promise.all 就会把整屏拖成骨架屏（一个慢请求 = 首页看起来挂了）。
    const [d, al] = await Promise.all([
      api.get(`/dashboard/${e.id}?days=7`).catch(() => null),
      api.get('/alerts?limit=2&is_read=0').catch(() => []),
    ]);
    dash = d;

    $('topSub').textContent = `${elderCall(e)} · ${M.medboxes.length ? (M.medboxes[0].status === 'online' ? '在线' : '离线') : '未绑定'}`;
    renderHero();
    renderOvStats();
    renderTimeline('ovTimeline');
    renderFocus();
    renderOvAlerts(al || []);
    renderBell();

    // AI 建议后置填充：回来就渲染，回不来就保留现有卡片，不影响已显示的内容
    if (!light) {
      api.get('/assistant/insights?days=7')
        .then((ins) => {
          insights = (ins && ins.insights) || [];
          renderOvAi();
        })
        .catch(() => { renderOvAi(); });
    }
  }

  function renderHero() {
    const e = currentElder();
    const tl = (dash && dash.timeline) || [];
    const now = tl.find((t) => t.status === 'current');
    const next = now || tl.find((t) => t.status === 'upcoming')
      || tl.slice().reverse().find((t) => t.status !== 'done');
    const target = now || next;

    if (!target) {
      const allDone = tl.length && tl.every((t) => t.status === 'done');
      $('ovHero').innerHTML = `<div class="hero muted">
        <div class="hl">${allDone ? '今天的药都吃完了' : '今天没有安排'}</div>
        <div class="ht">${allDone ? '辛苦了，继续保持' : '还没有服药计划'}</div>
        <div class="hs">${allDone ? `${elderCall(e)} 今天 ${tl.length} 次计划全部完成。` : '到「计划」页添加今天的服药安排。'}</div>
      </div>`;
      return;
    }

    const meds = (target.items || []).map((i) => `${i.medicine_name}`).join('、');
    const total = (target.items || []).reduce((a, i) => a + Number(i.dose_qty || 0), 0);
    const isNow = target.status === 'current';
    $('ovHero').innerHTML = `
      <div class="hero">
        <div class="hrow">
          <div style="min-width:0">
            <div class="hl">${isNow ? '现在该吃药' : '下一次服药'}</div>
            <div class="ht"><b>${esc(elderCall(e))}</b></div>
            <div class="hs">${isNow ? '已进入服药窗口，请按提示取药' : `${hhmm(target.dose_time)} 提醒，请提前准备`}</div>
          </div>
          <div style="text-align:right;flex:none">
            <div style="font-size:30px;font-weight:600;line-height:1;font-family:var(--num)">${hhmm(target.dose_time)}</div>
            <div style="font-size:11px;color:#B9D4CB;margin-top:5px">${esc(target.time_label || '')}</div>
          </div>
        </div>
        <div class="hm">
          ${target.slot_no ? `<span>第 ${target.slot_no} 格</span>` : ''}
          <span>共 ${total || 1} 份</span>
          ${meds ? `<span>${esc(meds)}</span>` : ''}
        </div>
        <button class="hbtn" id="heroTake">✓ 我吃好了</button>
      </div>`;

    const btn = $('heroTake');
    if (btn) {
      btn.addEventListener('click', () => quickTake(target));
    }
  }

  /** 移动端快捷打卡：POST /events（子女令牌需带 device_code） */
  async function quickTake(slot) {
    const box = mainBox();
    if (!box) return toast('还没有绑定药箱，无法记录', true);
    if (!(await askConfirm({
      title: '确认打卡',
      text: `确认「${(currentElder() && currentElder().name) || '老人'}」已经服用 ${hhmm(slot.dose_time)} 的药？`,
      ok: '确认已服',
    }))) return;
    try {
      const r = await api.post('/events', {
        device_code: box.device_code,
        elder_id: currentElder().id,
        slot_no: slot.slot_no || 1,
        event_type: 'take',
        dose_qty: 1,
        source: 'manual',
        schedule_id: slot.id,
      });
      toast('已记录：' + (RESULT_TEXT[(r.event || {}).result] || '完成'));
      await loadOverview();
      renderPlan();
    } catch (e) { /* api 已 toast */ }
  }

  function renderOvStats() {
    const d = dash || {};
    const rate = d.rate != null ? `${d.rate}%` : '—';
    $('ovStats').innerHTML = `
      <div class="cell pri"><div class="v">${d.todayDone || 0}/${d.todayTotal || 0}</div><div class="k">今日已服</div></div>
      <div class="cell ok"><div class="v">${d.streakDays || 0}</div><div class="k">连续按时天</div></div>
      <div class="cell ${d.unreadAlerts ? 'bad' : ''}"><div class="v">${d.unreadAlerts || 0}</div><div class="k">未处理告警</div></div>
      <div class="cell"><div class="v">${rate}</div><div class="k">7 日依从率</div></div>`;
  }

  /** 今日时间线（总览/计划共用） */
  function renderTimeline(targetId) {
    const tl = (dash && dash.timeline) || [];
    if (!tl.length) {
      $(targetId).innerHTML = empty('📋', '今天还没有服药安排');
      return;
    }
    $(targetId).innerHTML = `<div class="tl">${tl.map((t) => {
      const st = SLOT_STATUS[t.status] || SLOT_STATUS.upcoming;
      const meds = (t.items || []).map((i) => `${i.medicine_name} ${i.dose_qty}${i.unit || ''}`).join(' · ');
      return `<div class="tlrow ${t.status}">
        <div class="tlrail"><div class="t">${hhmm(t.dose_time)}</div><div class="d"></div></div>
        <div class="tlmain">
          <div class="m1">${esc(t.time_label || '服药')}${t.slot_no ? ` · 第 ${t.slot_no} 格` : ''}</div>
          <div class="m2">${esc(meds || '未配置药品')}${t.takenAt ? ` · ${relTime(t.takenAt).replace('今天 ', '')} 已服` : ''}</div>
        </div>
        <span class="tlbadge ${st.tone}">${st.text}</span>
      </div>`;
    }).join('')}</div>`;
  }

  /** 需要关注：低库存 + 临期/过期 */
  function renderFocus() {
    const low = (dash && dash.lowStock) || [];
    const exp = M.medicines
      .map((m) => ({ m, risk: expiryRisk(m) }))
      .filter((x) => x.risk);

    const rows = [];
    exp.forEach(({ m, risk }) => {
      const d = daysUntil(m.expiry_date);
      rows.push({
        ico: '🗓️',
        tone: risk === 'expired' ? 'bad' : 'warn',
        name: m.name,
        txt: risk === 'expired' ? `已过期 ${-d} 天，请清理` : `${d} 天后到期`,
        st: risk === 'expired' ? 'bad' : 'warn',
        stText: risk === 'expired' ? '过期' : '临期',
      });
    });
    low.forEach((m) => {
      rows.push({
        ico: '📦', tone: 'warn', name: m.name,
        txt: `库存仅剩 ${m.stock_qty}（阈值 ${m.stock_alert_qty}）`,
        st: 'warn', stText: '不足',
      });
    });

    if (!rows.length) {
      $('ovFocus').innerHTML = empty('✅', '库存与效期都健康');
      return;
    }
    $('ovFocus').innerHTML = rows.slice(0, 5).map((r) => `
      <div class="row">
        <div class="ico ${r.tone}">${r.ico}</div>
        <div class="tx"><b>${esc(r.name)}</b><small>${esc(r.txt)}</small></div>
        <span class="stt ${r.st}">${r.stText}</span>
      </div>`).join('');
  }

  function renderOvAlerts(list) {
    if (!list.length) {
      $('ovAlerts').innerHTML = empty('🔔', '暂无未处理告警');
      return;
    }
    $('ovAlerts').innerHTML = list.map((a) => `
      <div class="row" data-lvl="${a.level || 'info'}">
        <div class="ico ${a.level === 'urgent' ? 'bad' : 'warn'}">${ALERT_ICON[a.alert_type] || '🔔'}</div>
        <div class="tx">
          <b>${esc(a.elder_name || '')} · ${esc(ALERT_TEXT[a.alert_type] || a.alert_type)}</b>
          <small>${esc(a.content || '')}</small>
        </div>
      </div>`).join('');
  }

  function renderOvAi() {
    const top = insights.slice(0, 2);
    if (!top.length) {
      $('ovAi').innerHTML = '<div class="ai-body">目前家庭数据一切正常，暂时没有需要特别提醒的事项。</div>';
      return;
    }
    $('ovAi').innerHTML = `<div class="ai-top">
        <div class="ai-avatar">✦</div>
        <div><b>我发现了 ${insights.length} 件事</b><small>基于近 7 天服药与库存数据</small></div>
      </div>
      <div style="margin-top:8px">${top.map((i) => `
        <div class="ins">
          <div class="ih"><span class="pri-dot ${i.priority || 'info'}"></span><b>${esc(i.title)}</b></div>
          <div class="ib">${esc(i.body)}</div>
        </div>`).join('')}</div>`;
  }

  function renderBell() {
    const n = (dash && dash.unreadAlerts) || 0;
    $('bellDot').style.display = n ? 'block' : 'none';
    const fb = $('fabDot');
    if (fb) {
      fb.style.display = n ? 'block' : 'none';
      fb.textContent = n > 9 ? '9+' : String(n);
    }
  }

  /* ==================== 服药计划 ==================== */
  function renderPlan() {
    const e = currentElder();
    if (!e) {
      $('careSub').textContent = '还没有老人档案';
      $('planList').innerHTML = empty('📋', '请先到「我的 → 家庭成员」添加老人');
      $('planWeek').innerHTML = '';
      $('planCount').textContent = '';
      return;
    }
    const list = schedulesOf(e.id);
    $('careSub').textContent = `${elderCall(e)} · 每天 ${list.length} 次`;
    $('planCount').textContent = `${list.length} 次`;

    // 周图
    const daily = (dash && dash.daily) || [];
    const byDay = {};
    daily.forEach((r) => { byDay[String(r.d).slice(0, 10)] = r; });
    const bars = [];
    for (let i = 6; i >= 0; i--) {
      const dt = new Date(Date.now() - i * 86400000);
      const key = localDateKey(dt);
      const r = byDay[key];
      const pct = r && Number(r.total) ? Math.round((Number(r.taken) / Number(r.total)) * 100) : null;
      const cls = pct === null ? 'no' : pct >= 90 ? 'hi' : pct >= 60 ? 'mid' : 'lo';
      bars.push(`<div class="wd"><div class="vv">${pct === null ? '—' : pct + '%'}</div>
        <div class="bar ${cls}" style="height:${pct === null ? 4 : Math.max(6, pct * 0.5)}px"></div>
        <div class="lb">${dt.getMonth() + 1}/${dt.getDate()}</div></div>`);
    }
    $('planWeek').innerHTML = bars.join('');
    $('weekAvg').textContent = dash && dash.rate != null ? `7 日平均 ${dash.rate}%` : '';

    // 今日安排
    if (!list.length) {
      $('planList').innerHTML = `<div class="card">${empty('📋', '还没有服药计划，点下面按钮添加')}</div>`;
      return;
    }
    $('planList').innerHTML = `<div class="card flat rows">${list.map((s) => {
      const tl = (dash && dash.timeline || []).find((t) => Number(t.id) === Number(s.id));
      const st = tl ? SLOT_STATUS[tl.status] : null;
      const items = (dash && dash.timeline || []).find((t) => Number(t.id) === Number(s.id));
      const meds = (items && items.items || []).map((i) => i.medicine_name).join('、');
      return `<div class="row" data-sch="${s.id}">
        <div class="ico">${s.slot_no || '·'}</div>
        <div class="tx">
          <b>${hhmm(s.dose_time)} ${esc(s.time_label || '')}${s.compartment_label ? ' · ' + esc(s.compartment_label) : ''}</b>
          <small>${esc(meds || '未配置药品')}</small>
        </div>
        ${st ? `<span class="stt ${st.tone}">${st.text}</span>` : '<span class="chev">›</span>'}
      </div>`;
    }).join('')}</div>`;

    // 点击删除
    $('planList').querySelectorAll('[data-sch]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = Number(row.dataset.sch);
        const s = list.find((x) => Number(x.id) === id);
        if (!s) return;
        openSheet({
          title: `删除 ${hhmm(s.dose_time)} 的计划？`,
          sub: `${elderCall(e)} · ${s.time_label || ''}`,
          body: `<p style="font-size:13px;color:var(--sub);line-height:1.7">删除后该时间点不再提醒，已产生的服药记录会保留。</p>
            <div class="sh-acts">
              <button class="btn-ghost" id="shCancel">取消</button>
              <button class="btn-primary" id="shDel" style="background:var(--bad)">确认删除</button>
            </div>`,
          onMount: () => {
            $('shCancel').addEventListener('click', closeSheet);
            $('shDel').addEventListener('click', async () => {
              try {
                await api.del('/schedules/' + id);
                toast('已删除');
                closeSheet();
                await refreshAll();
              } catch (err) { /* 已 toast */ }
            });
          },
        });
      });
    });
  }

  /* ==================== 药箱 ==================== */
  let boxFilter = 'all';

  /**
   * 隔间分装 + 装药清单
   * 对应方案书 6.1.3「为每个时间点指定一个隔间编号，系统生成装药清单
   * （哪个格子放哪几种药、共几片）」——这张单子是防错的第一道关口，
   * 装错格，后面提醒再准也没用。
   */
  function renderSlots() {
    const comps = M.compartments || [];
    if (!comps.length) {
      $('slotSub').textContent = '';
      $('boxSlots').innerHTML = '<p style="font-size:12px;color:var(--muted);margin-top:6px">还没有隔间数据，请先在电脑端绑定药箱设备。</p>';
      $('loadList').innerHTML = empty('📦', '未绑定药箱，暂时没有装药清单');
      return;
    }
    const used = comps.filter((c) => c.schedule_id).length;
    $('slotSub').textContent = `${used}/${comps.length} 格已排药`;

    $('boxSlots').innerHTML = comps.map((c) => {
      const tip = c.meds.length
        ? `${hhmm(c.dose_time)} ${c.elder_name || ''}：${c.meds.map((m) => m.name).join('、')}`
        : '';
      return `<div class="slot ${c.schedule_id ? 'used' : ''}" title="${esc(tip)}">
        <b>${c.slot_no}</b>
        <small>${c.schedule_id ? hhmm(c.dose_time) : '空闲'}</small>
      </div>`;
    }).join('');

    const rows = comps.filter((c) => c.schedule_id).map((c) => {
      const meds = c.meds.map((m) => `${esc(m.name)} ${m.qty}${esc(m.unit || '片')}`).join(' · ');
      return `<div class="row">
        <div class="ico">${c.slot_no}</div>
        <div class="tx">
          <b>第 ${c.slot_no} 格 · ${hhmm(c.dose_time)} ${esc(c.time_label || '')}</b>
          <small>${esc(c.elder_name || '')}${meds ? ' · ' + meds : ' · 未配置药品'}</small>
        </div>
      </div>`;
    });
    $('loadList').innerHTML = rows.length
      ? rows.join('')
      : empty('📋', '还没有把药排进格子');
  }

  function renderBox() {
    const total = M.medicines.length;
    const low = M.medicines.filter(isLowStock).length;
    const expired = M.medicines.filter((m) => expiryRisk(m) === 'expired').length;
    const soon = M.medicines.filter((m) => expiryRisk(m) === 'soon').length;

    const box = mainBox();
    $('boxSub').textContent = box
      ? `${box.device_code} · ${box.status === 'online' ? '在线' : '离线'}${box.elders && box.elders.length ? ` · ${box.elders.length} 位老人共用` : ''}`
      : '还没有绑定药箱设备';

    $('boxStats').innerHTML = `
      <div class="cell pri"><div class="v">${total}</div><div class="k">在库药品</div></div>
      <div class="cell ${low ? 'warn' : ''}"><div class="v">${low}</div><div class="k">库存不足</div></div>
      <div class="cell ${expired ? 'bad' : ''}"><div class="v">${expired}</div><div class="k">已过期</div></div>
      <div class="cell ${soon ? 'warn' : ''}"><div class="v">${soon}</div><div class="k">30 天内到期</div></div>`;

    renderSlots();

    const chips = [
      ['all', '全部'], ['low', '库存不足'], ['expired', '已过期'], ['soon', '临期'],
    ];
    $('boxChips').innerHTML = chips.map(([k, t]) =>
      `<button data-f="${k}" class="${boxFilter === k ? 'on' : ''}">${t}</button>`).join('');
    $('boxChips').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { boxFilter = b.dataset.f; renderBox(); });
    });

    let list = M.medicines.slice();
    if (boxFilter === 'low') list = list.filter(isLowStock);
    if (boxFilter === 'expired') list = list.filter((m) => expiryRisk(m) === 'expired');
    if (boxFilter === 'soon') list = list.filter((m) => expiryRisk(m) === 'soon');
    // 默认按剩余量升序（最该补的排前面）
    if (boxFilter === 'all') list.sort((a, b) => Number(a.stock_qty) - Number(b.stock_qty));

    if (!list.length) {
      $('boxList').innerHTML = empty('💊', boxFilter === 'all' ? '药箱里还没有药品' : '没有符合条件的药品');
      return;
    }

    $('boxList').innerHTML = list.map((m) => {
      const risk = expiryRisk(m);
      const lowS = isLowStock(m);
      const d = daysUntil(m.expiry_date);
      const sub = [
        m.spec || '',
        m.category || '',
        lowS ? `库存 ${m.stock_qty}（阈值 ${m.stock_alert_qty}）` : `剩 ${m.stock_qty} ${m.unit || ''}`,
        m.expiry_date ? (risk === 'expired' ? `已过期 ${-d} 天` : `${md(m.expiry_date)} 到期`) : '',
      ].filter(Boolean).join(' · ');
      const badge = risk === 'expired' ? '<span class="stt bad">过期</span>'
        : risk === 'soon' ? '<span class="stt warn">临期</span>'
          : lowS ? '<span class="stt warn">不足</span>'
            : '<span class="stt ok">正常</span>';
      return `<div class="row" data-med="${m.id}">
        <div class="ico ${risk === 'expired' ? 'bad' : lowS || risk === 'soon' ? 'warn' : ''}">💊</div>
        <div class="tx"><b>${esc(m.name)}</b><small>${esc(sub)}</small></div>
        ${badge}
      </div>`;
    }).join('');

    $('boxList').querySelectorAll('[data-med]').forEach((row) => {
      row.addEventListener('click', () => {
        const m = M.medicines.find((x) => Number(x.id) === Number(row.dataset.med));
        if (m) openMedicineSheet(m);
      });
    });
  }

  /** 编辑/补货单个药品 */
  function openMedicineSheet(m) {
    const d = daysUntil(m.expiry_date);
    openSheet({
      title: m.name,
      sub: `${m.spec || '未填规格'} · ${m.category || '未分类'}`,
      body: `
        <div class="f2">
          <div class="field"><label>当前库存（${esc(m.unit || '片')}）</label><input id="ms_qty" type="number" min="0" value="${m.stock_qty}"></div>
          <div class="field"><label>预警阈值</label><input id="ms_alert" type="number" min="0" value="${m.stock_alert_qty}"></div>
        </div>
        <div class="field"><label>有效期至</label><input id="ms_exp" type="date" value="${m.expiry_date ? String(m.expiry_date).slice(0, 10) : ''}"></div>
        ${d !== null ? `<p style="font-size:12px;color:${d < 0 ? 'var(--bad)' : d <= 30 ? 'var(--warn)' : 'var(--muted)'};margin:-4px 0 10px">
          ${d < 0 ? `已过期 ${-d} 天，建议清理` : d <= 30 ? `距效期还有 ${d} 天` : `距效期还有 ${d} 天`}</p>` : ''}
        ${m.active_ingredient ? `<div class="field"><label>主要成分</label><input value="${esc(m.active_ingredient)}" disabled style="background:#F7F4EE"></div>` : ''}
        ${m.contraindication ? `<p style="font-size:11.5px;color:var(--sub);line-height:1.7;margin-bottom:10px">禁忌：${esc(m.contraindication)}</p>` : ''}
        <div class="sh-acts">
          <button class="btn-ghost" id="ms_cancel">取消</button>
          <button class="btn-primary" id="ms_save">保存</button>
        </div>`,
      onMount: () => {
        $('ms_cancel').addEventListener('click', closeSheet);
        $('ms_save').addEventListener('click', async () => {
          try {
            await api.put('/medicines/' + m.id, {
              stock_qty: Number($('ms_qty').value) || 0,
              stock_alert_qty: Number($('ms_alert').value) || 0,
              expiry_date: $('ms_exp').value || null,
            });
            toast('已更新');
            closeSheet();
            await refreshAll();
          } catch (e) { /* 已 toast */ }
        });
      },
    });
  }

  /* ==================== 记录 ==================== */
  let hisDays = 7;

  async function renderHistory() {
    const e = currentElder();
    if (!e) {
      $('hisSub').textContent = '还没有老人档案';
      $('hisList').innerHTML = empty('🕘', '暂无记录');
      $('hisChips').innerHTML = '';
      return;
    }
    const chips = [[1, '今天'], [7, '近 7 天'], [30, '近 30 天']];
    $('hisChips').innerHTML = chips.map(([d, t]) =>
      `<button data-d="${d}" class="${hisDays === d ? 'on' : ''}">${t}</button>`).join('');
    $('hisChips').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { hisDays = Number(b.dataset.d); renderHistory(); });
    });

    $('careSub').textContent = `${elderCall(e)} · 服药记录`;
    $('hisSub').textContent = `${elderCall(e)} · ${hisDays === 1 ? '今天' : `近 ${hisDays} 天`}`;
    showSkel('hisList', 3);
    const list = await api.get(`/events?elder_id=${e.id}&limit=100`).catch(() => []);

    // 按本地日期做字符串比较（'YYYY-MM-DD' 可直接比大小），避免 toISOString 的 UTC 偏移丢一天
    const startKey = localDateKey(new Date(Date.now() - (hisDays - 1) * 86400000));
    const rows = list.filter((ev) => String(ev.occurred_at || '').slice(0, 10) >= startKey);

    if (!rows.length) {
      $('hisList').innerHTML = empty('🕘', '这段时间还没有服药记录');
      return;
    }
    $('hisList').innerHTML = rows.map((ev) => {
      const tone = RESULT_TONE[ev.result] || 'mute';
      return `<div class="row">
        <div class="ico ${tone === 'bad' ? 'bad' : tone === 'warn' ? 'warn' : ''}">${tone === 'bad' ? '⚠️' : tone === 'ok' ? '✅' : '🕘'}</div>
        <div class="tx"><b>${esc(RESULT_TEXT[ev.result] || ev.result)}</b>
          <small>${relTime(ev.occurred_at)} · ${esc(SOURCE_TEXT[ev.source] || ev.source || '')}${ev.slot_no ? ` · 第 ${ev.slot_no} 格` : ''}</small></div>
        <span class="stt ${tone}">${esc(RESULT_TEXT[ev.result] || '')}</span>
      </div>`;
    }).join('');
  }

  /* ==================== 我的 ==================== */
  function renderMe() {
    const me = M.me || {};
    // /auth/me 返回的是驼峰字段（realName / familyId），兼容一下历史写法
    const name = me.realName || me.real_name || me.username || '家人';
    const roleText = { owner: '主配置人', member: '可配置', viewer: '只读' }[me.role] || '';
    $('meProfile').innerHTML = `<div class="profile">
      <div class="av">${esc(avatarText(name))}</div>
      <div class="nm"><b>${esc(name)}</b><small>${esc(roleText)}${(me.familyId || me.family_id) ? ' · 家庭 #' + (me.familyId || me.family_id) : ''}</small></div>
    </div>`;

    // 老人列表（点击切换当前）
    if (!M.elders.length) {
      $('meElders').innerHTML = empty('👵', '还没有老人档案');
    } else {
      $('meElders').innerHTML = M.elders.map((e) => `
        <div class="row" data-eid="${e.id}">
          <div class="ico">${esc(avatarText(e.name))}</div>
          <div class="tx"><b>${esc(elderCall(e))}</b>
            <small>${[ageText(e), e.chronic_diseases || ''].filter(Boolean).join(' · ') || '暂无档案信息'}</small></div>
          ${Number(e.id) === Number(M.elderId) ? '<span class="stt pri">当前</span>' : '<span class="chev">›</span>'}
        </div>`).join('');
      $('meElders').querySelectorAll('[data-eid]').forEach((row) => {
        row.addEventListener('click', async () => {
          setElder(Number(row.dataset.eid));
          toast('已切换到 ' + (currentElder() || {}).name);
          await refreshAll();
        });
      });
    }
    $('meSwitch').style.display = M.elders.length > 1 ? 'block' : 'none';
    $('meSwitch').onclick = () => {
      if (M.elders.length < 2) return toast('只有一位老人');
      openSheet({
        title: '切换查看的老人',
        body: `<div class="card flat rows">${M.elders.map((e) => `
          <div class="row" data-pick="${e.id}">
            <div class="ico">${esc(avatarText(e.name))}</div>
            <div class="tx"><b>${esc(elderCall(e))}</b><small>${ageText(e) || '—'}</small></div>
            ${Number(e.id) === Number(M.elderId) ? '<span class="stt pri">当前</span>' : ''}
          </div>`).join('')}</div>`,
        onMount: () => {
          $('shBody').querySelectorAll('[data-pick]').forEach((r) => {
            r.addEventListener('click', async () => {
              setElder(Number(r.dataset.pick));
              closeSheet();
              await refreshAll();
            });
          });
        },
      });
    };

    // 家庭成员
    if (!M.members.length) {
      $('meMembers').innerHTML = empty('👨‍👩‍👧', '还没有其他成员');
    } else {
      $('meMembers').innerHTML = M.members.map((u) => `
        <div class="row">
          <div class="ico">${esc(avatarText(u.realName || u.real_name || u.username))}</div>
          <div class="tx"><b>${esc(u.realName || u.real_name || u.username)}</b>
            <small>${({ owner: '主配置人', member: '可配置', viewer: '只读' })[u.role] || u.role}${u.phone ? ' · ' + esc(u.phone) : ''}</small></div>
        </div>`).join('');
    }

    // 功能菜单
    $('meMenu').innerHTML = [
      ['🔔', '告警中心', 'alert'],
      ['✦', 'AI 用药助手', 'assistant'],
      ['🎙️', '语音提醒', 'voice'],
      ['⚙️', '提醒策略', 'policy'],
      ['📄', '用药单与数据', 'data'],
      ['👨‍👩‍👧', '家庭成员', 'family'],
    ].map(([i, t, p]) => `<div class="row" data-menu="${p}">
        <div class="ico">${i}</div><div class="tx"><b>${t}</b></div><span class="chev">›</span>
      </div>`).join('') + `<div class="row" data-menu="logout">
        <div class="ico bad">↩</div><div class="tx"><b style="color:var(--bad)">退出登录</b></div><span class="chev">›</span>
      </div>`;
    $('meMenu').querySelectorAll('[data-menu]').forEach((row) => {
      row.addEventListener('click', () => {
        const p = row.dataset.menu;
        if (p === 'logout') {
          openSheet({
            title: '退出登录？',
            body: `<p style="font-size:13px;color:var(--sub)">退出后需要重新输入账号密码。</p>
              <div class="sh-acts"><button class="btn-ghost" id="lo_c">取消</button>
              <button class="btn-primary" id="lo_y" style="background:var(--bad)">退出</button></div>`,
            onMount: () => {
              $('lo_c').addEventListener('click', closeSheet);
              $('lo_y').addEventListener('click', () => logout());
            },
          });
          return;
        }
        openSub('sp-' + p);
      });
    });
  }

  /* ==================== 子页：提醒策略（方案书 6.1.4） ==================== */
  /**
   * 三段式提醒 + 音量语速 + 判定阈值
   * 这些字段都挂在 elder 上，web 端与移动端共用同一份配置，
   * 改完药箱和老人端立刻按新策略执行。
   */
  function renderPolicy() {
    const e = currentElder();
    if (!e) {
      $('policyBody').innerHTML = empty('👵', '还没有老人档案，先去「家庭成员」添加');
      return;
    }
    const vol = Number(e.volume_level) || 3;
    const rate = e.speech_rate || 'slow';
    $('policyBody').innerHTML = `
      <p style="font-size:12.5px;color:var(--sub);line-height:1.75;margin-bottom:12px">
        正在为 <b style="color:var(--ink)">${esc(elderCall(e))}</b> 设置。保存后药箱与老人端按此执行。
      </p>

      <div class="card">
        <b style="font-size:14px">三段式提醒</b>
        <p class="pf-note">由弱到强，既不打扰也不会漏。老人听力不好时建议三档全开。</p>
        <div class="sw-row">
          <label class="sw"><input type="checkbox" id="pf_30" ${Number(e.remind_30m) ? 'checked' : ''}><i></i><span>提前 30 分 · 慢闪</span></label>
          <label class="sw"><input type="checkbox" id="pf_10" ${Number(e.remind_10m) ? 'checked' : ''}><i></i><span>提前 10 分 · 常亮</span></label>
          <label class="sw"><input type="checkbox" id="pf_3" ${Number(e.remind_3m) ? 'checked' : ''}><i></i><span>提前 3 分 · 高亮+语音</span></label>
        </div>
      </div>

      <div class="card">
        <b style="font-size:14px">声音</b>
        <div class="field" style="margin-top:10px">
          <label>音量 <em class="pval" id="pf_vol_val">${vol}</em> 档</label>
          <input id="pf_vol" type="range" min="1" max="5" step="1" value="${vol}">
        </div>
        <div class="f2">
          <div class="field"><label>语速</label>
            <select id="pf_rate">
              <option value="slow" ${rate === 'slow' ? 'selected' : ''}>慢（推荐）</option>
              <option value="normal" ${rate === 'normal' ? 'selected' : ''}>正常</option>
              <option value="fast" ${rate === 'fast' ? 'selected' : ''}>快</option>
            </select></div>
          <div class="field"><label>重复播报次数</label>
            <input id="pf_repeat" type="number" min="1" max="5" value="${Number(e.repeat_times) || 2}"></div>
        </div>
      </div>

      <div class="card">
        <b style="font-size:14px">判定阈值</b>
        <div class="f2" style="margin-top:10px">
          <div class="field"><label>超时判定(分)</label>
            <input id="pf_timeout" type="number" min="5" max="120" value="${Number(e.timeout_minutes) || 30}"></div>
          <div class="field"><label>重复取药窗口(分)</label>
            <input id="pf_dup" type="number" min="1" max="30" value="${Number(e.duplicate_window_minutes) || 2}"></div>
        </div>
        <p class="pf-note">超过这个时间没取药 → 判为漏服并推送给子女；窗口内再次开同一格 → 判为疑似重复服药并拦截。</p>
      </div>

      <button class="btn-primary" id="btnSavePolicy" style="margin-top:16px">保存策略</button>`;

    $('pf_vol').addEventListener('input', () => { $('pf_vol_val').textContent = $('pf_vol').value; });
    $('btnSavePolicy').addEventListener('click', async () => {
      try {
        await api.put('/elders/' + e.id, {
          volume_level: Number($('pf_vol').value),
          speech_rate: $('pf_rate').value,
          repeat_times: Number($('pf_repeat').value),
          timeout_minutes: Number($('pf_timeout').value),
          duplicate_window_minutes: Number($('pf_dup').value),
          remind_30m: $('pf_30').checked ? 1 : 0,
          remind_10m: $('pf_10').checked ? 1 : 0,
          remind_3m: $('pf_3').checked ? 1 : 0,
        });
        toast('提醒策略已保存');
        await loadAll();
        renderPolicy();
      } catch (err) { /* api 已 toast */ }
    });
  }

  /* ==================== 子页：用药单与数据（方案书「导出用药单 / 一键导出与删除」） ==================== */
  let recordCache = null;

  /** 触发浏览器下载（手机上会落到「下载」目录，可直接转发给医生） */
  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 800);
  }

  function todayStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  /** 表格化的用药单（预览用） */
  function recTableHTML(d) {
    const medRows = (d.meds || []).length
      ? d.meds.map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.spec || '-')}</td><td>${esc(m.category || '-')}</td></tr>`).join('')
      : '<tr><td colspan="3" class="rt-empty">暂无在服药品</td></tr>';
    const evs = (d.events || []).slice(0, 15);
    const evRows = evs.length
      ? evs.map((x) => `<tr><td>${relTime(x.occurred_at)}</td><td>${esc(x.time_label || '-')}</td>
          <td>${x.slot_no ? '第' + x.slot_no + '格' : '-'}</td><td>${esc(RESULT_TEXT[x.result] || x.result)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="rt-empty">暂无服药记录</td></tr>';

    return `
      <div class="recbox">
        <div class="rt">${esc(elderCall(d.elder))} · 用药记录单</div>
        <div class="rs">${elderCall(d.elder)}${d.elder.age ? ' · ' + d.elder.age + ' 岁' : ''}
          ${d.elder.chronic_diseases ? ' · 慢病：' + esc(d.elder.chronic_diseases) : ''}
          ${d.elder.allergies ? ' · 过敏：' + esc(d.elder.allergies) : ''}</div>
        <div class="rsec">在服药品（${(d.meds || []).length}）</div>
        <table class="rtab"><thead><tr><th>药品</th><th>规格</th><th>分类</th></tr></thead><tbody>${medRows}</tbody></table>
        <div class="rsec">最近服药（显示 ${evs.length} 条 / 共 ${(d.events || []).length} 条）</div>
        <table class="rtab"><thead><tr><th>时间</th><th>时段</th><th>隔间</th><th>结果</th></tr></thead><tbody>${evRows}</tbody></table>
        <div class="rf">本单由安心格自动生成，仅供医生参考，不构成诊断或处方建议。</div>
      </div>`;
  }

  /** 独立 HTML（下载后可直接打开或打印） */
  function recDocHTML(d) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>安心格 · 用药记录单 - ${esc(d.elder.name)}</title>
<style>
  body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;color:#22302d;margin:24px;line-height:1.7}
  h1{font-size:19px;text-align:center;color:#2F6B63;margin-bottom:4px}
  .sub{text-align:center;color:#8a857b;font-size:12px;margin-bottom:18px}
  h3{font-size:13px;color:#2F6B63;margin:18px 0 8px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{border:1px solid #e8e2d6;padding:6px 8px;text-align:left}
  th{background:#f5f3ee}
  .foot{margin-top:20px;font-size:11px;color:#a9b0ab;text-align:center}
  @media print{body{margin:10mm}}
</style></head><body>
<h1>安心格 · 用药记录单</h1>
<div class="sub">${esc(elderCall(d.elder))}　生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}</div>
<h3>在服药品（${(d.meds || []).length} 种）</h3>
<table><thead><tr><th>药品</th><th>规格</th><th>分类</th></tr></thead><tbody>
${(d.meds || []).map((m) => `<tr><td>${esc(m.name)}</td><td>${esc(m.spec || '-')}</td><td>${esc(m.category || '-')}</td></tr>`).join('') || '<tr><td colspan="3">暂无</td></tr>'}
</tbody></table>
<h3>服药记录（最近 500 条）</h3>
<table><thead><tr><th>时间</th><th>时段</th><th>隔间</th><th>结果</th></tr></thead><tbody>
${(d.events || []).map((x) => `<tr><td>${String(x.occurred_at).slice(0, 16)}</td><td>${esc(x.time_label || '-')}</td><td>${x.slot_no ? '第' + x.slot_no + '格' : '-'}</td><td>${esc(RESULT_TEXT[x.result] || x.result)}</td></tr>`).join('') || '<tr><td colspan="4">暂无</td></tr>'}
</tbody></table>
<div class="foot">本单由安心格自动生成，仅供医生参考，不构成诊断或处方建议。</div>
</body></html>`;
  }

  async function loadRecord() {
    const e = currentElder();
    if (!e) return;
    $('recPreview').innerHTML = '<p style="font-size:12px;color:var(--muted)">正在生成…</p>';
    try {
      recordCache = await api.get('/export/record/' + e.id);
      $('recPreview').innerHTML = recTableHTML(recordCache) + `
        <div class="sh-acts" style="margin-top:10px">
          <button class="btn-ghost" id="btnSaveRec">保存为文件</button>
          <button class="btn-primary" id="btnPrintRec">打印 / 存 PDF</button>
        </div>`;
      $('btnSaveRec').addEventListener('click', () => {
        downloadFile(`用药记录单_${e.name}_${todayStamp()}.html`, recDocHTML(recordCache), 'text/html;charset=utf-8');
        toast('已保存到下载目录');
      });
      $('btnPrintRec').addEventListener('click', () => {
        const w = window.open('', '_blank');
        if (!w) return toast('弹窗被拦截，请用「保存为文件」', true);
        w.document.write(recDocHTML(recordCache));
        w.document.close();
        setTimeout(() => { try { w.print(); } catch (err) { /* 用户可手动打印 */ } }, 400);
      });
    } catch (err) {
      $('recPreview').innerHTML = '<p style="font-size:12px;color:var(--bad)">生成失败，请稍后重试</p>';
    }
  }

  $('btnExportRecord').addEventListener('click', loadRecord);

  $('btnExportData').addEventListener('click', async () => {
    try {
      const d = await api.get('/export/family-data');
      downloadFile(`安心格数据_${todayStamp()}.json`, JSON.stringify(d, null, 2), 'application/json');
      toast('已导出到下载目录');
    } catch (err) { /* api 已 toast */ }
  });

  $('btnWipeData').addEventListener('click', async () => {
    const ok = await askConfirm({
      title: '清空服药记录与告警？',
      // 文案必须与后端 DELETE /export/family-data 的真实行为一致：
      // 它只删 intake_event 与 alert，老人档案/药品/计划一律保留。
      text: '将删除本家庭的服药记录与告警历史，不可恢复。老人档案、药品与服药计划会保留。建议先「导出全部数据」留一份。',
      ok: '确认清空',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del('/export/family-data');
      toast('家庭数据已删除');
      recordCache = null;
      $('recPreview').innerHTML = '';
      await refreshAll();
    } catch (err) { /* api 已 toast（非主配置人会提示无权限） */ }
  });

  /* ==================== 子页：告警 ==================== */
  let alFilter = 'all';
  let allAlerts = [];

  async function loadAlerts() {
    showSkel('alList', 4);
    allAlerts = await api.get('/alerts?limit=100').catch(() => []);
    renderAlerts();
  }

  function renderAlerts() {
    const chips = [['all', '全部'], ['unread', '未处理'], ['urgent', '紧急'], ['done', '已处理']];
    $('alChips').innerHTML = chips.map(([k, t]) =>
      `<button data-a="${k}" class="${alFilter === k ? 'on' : ''}">${t}</button>`).join('');
    $('alChips').querySelectorAll('button').forEach((b) => {
      b.addEventListener('click', () => { alFilter = b.dataset.a; renderAlerts(); });
    });

    let list = allAlerts;
    if (alFilter === 'unread') list = list.filter((a) => !Number(a.is_read));
    if (alFilter === 'urgent') list = list.filter((a) => a.level === 'urgent' && !Number(a.is_read));
    if (alFilter === 'done') list = list.filter((a) => Number(a.is_read));

    if (!list.length) {
      $('alList').innerHTML = empty('🔔', alFilter === 'all' ? '还没有告警记录' : '没有符合条件的告警');
      syncAckBtn();
      return;
    }
    $('alList').innerHTML = list.map((a) => `
      <div class="row${Number(a.is_read) ? ' gets' : ''}" data-al="${a.id}" data-lvl="${a.level || 'info'}">
        <div class="ico ${a.level === 'urgent' ? 'bad' : a.level === 'warning' ? 'warn' : ''}">${ALERT_ICON[a.alert_type] || '🔔'}</div>
        <div class="tx">
          <b>${esc(ALERT_TEXT[a.alert_type] || a.alert_type)}${a.elder_name ? ' · ' + esc(a.elder_name) : ''}</b>
          <small>${esc(a.content || '')}</small>
          <small style="color:var(--faint)">${relTime(a.created_at)}${Number(a.is_read) ? ' · 已处理' : ''}</small>
          <div class="a-ops">
            ${Number(a.is_read)
              ? '<span class="stt mute">已处理</span>'
              : `<span class="stt ${a.level === 'urgent' ? 'bad' : 'warn'}">${LEVEL_TEXT[a.level] || '待处理'}</span>
                 <button class="mini-btn" data-ack="${a.id}">处理</button>`}
          </div>
        </div>
      </div>`).join('');

    // 行内「处理」：直接标记，不用再点开详情
    $('alList').querySelectorAll('[data-ack]').forEach((b) => {
      b.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        b.disabled = true;
        b.textContent = '…';
        try {
          await api.put(`/alerts/${b.dataset.ack}/handle`, { handle_note: '移动端快捷处理' });
          toast('已处理');
          await loadAlerts();
          await loadOverview();
        } catch (e) {
          b.disabled = false;
          b.textContent = '处理';
        }
      });
    });

    $('alList').querySelectorAll('[data-al]').forEach((row) => {
      row.addEventListener('click', () => {
        const a = allAlerts.find((x) => Number(x.id) === Number(row.dataset.al));
        if (!a) return;
        if (Number(a.is_read)) return toast('该告警已处理');
        // 建议动作 + 一键拨号：方案书 6.3「发现—推送—处理」闭环，
        // 光看到告警没用，得能立刻联系到人。
        const advice = ALERT_ADVICE[a.alert_type];
        const callTo = (M.members || []).find((u) => u.phone);
        const callName = callTo ? (callTo.realName || callTo.real_name || callTo.username) : '';
        openSheet({
          title: ALERT_TEXT[a.alert_type] || a.alert_type,
          sub: `${a.elder_name || ''} · ${relTime(a.created_at)}`,
          body: `<p style="font-size:13px;line-height:1.75;color:var(--sub)">${esc(a.content || '')}</p>
            ${advice ? `<div class="advice"><b>建议动作</b><span>${esc(advice)}</span></div>` : ''}
            <div class="sh-acts" style="flex-wrap:wrap">
              ${callTo ? `<button class="btn-ghost" id="al_call">📞 打给 ${esc(callName)}</button>` : ''}
              <button class="btn-ghost" id="al_c">稍后</button>
              <button class="btn-primary" id="al_y">标记已处理</button>
            </div>`,
          onMount: () => {
            if (callTo) {
              $('al_call').addEventListener('click', () => { location.href = 'tel:' + callTo.phone; });
            }
            $('al_c').addEventListener('click', closeSheet);
            $('al_y').addEventListener('click', async () => {
              try {
                await api.put(`/alerts/${a.id}/handle`, {});
                toast('已处理');
                closeSheet();
                await loadAlerts();
                await loadOverview();
              } catch (e) { /* 已 toast */ }
            });
          },
        });
      });
    });

    syncAckBtn();
  }

  /* 一键全部处理：应用内确认框 + 结果回显（原生 confirm 在部分 webview 里被屏蔽） */
  $('ackAll').addEventListener('click', async () => {
    const unread = allAlerts.filter((a) => !Number(a.is_read)).length;
    if (!unread) return toast('当前没有待处理的告警');
    const ok = await askConfirm({
      title: '全部标为已处理？',
      text: `当前有 ${unread} 条未处理告警。标记后不会删除，仍可在「已处理」里查到。`,
      ok: '全部处理',
    });
    if (!ok) return;

    const btn = $('ackAll');
    btn.disabled = true;
    const old = btn.textContent;
    btn.textContent = '处理中…';
    try {
      const r = await api.put('/alerts/read-all', {});
      toast(`已处理 ${r.affected || 0} 条`);
      await loadAlerts();
      await loadOverview();
    } catch (e) {
      /* api 层已 toast */
    } finally {
      btn.disabled = false;
      btn.textContent = old;
      syncAckBtn();
    }
  });

  /** 「全部处理」按钮的可用状态：没有未处理告警就置灰 */
  function syncAckBtn() {
    const btn = $('ackAll');
    if (!btn) return;
    const unread = allAlerts.filter((a) => !Number(a.is_read)).length;
    btn.disabled = !unread;
    btn.textContent = '全部处理';
  }

  /* ==================== 子页：AI ==================== */
  let pendingConfirm = null;

  async function loadInsights() {
    $('aiHero').textContent = '正在分析近 7 天的服药与库存数据…';
    const r = await api.get('/assistant/insights?days=7').catch(() => ({ insights: [] }));
    insights = (r && r.insights) || [];
    $('aiHero').innerHTML = insights.length
      ? `我分析了家里的用药数据，发现 <span class="hl">${insights.length} 件</span> 值得留意的事。`
      : '目前家里的服药、库存、效期都很正常，没有需要特别提醒的。';
    $('aiCount').textContent = insights.length ? `${insights.length} 条` : '';
    $('aiInsights').innerHTML = insights.length
      ? insights.map((i) => `<div class="ins">
          <div class="ih"><span class="pri-dot ${i.priority || 'info'}"></span><b>${esc(i.title)}</b></div>
          <div class="ib">${esc(i.body)}</div>
        </div>`).join('')
      : empty('✅', '暂无建议');
  }

  function aiAppend(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    $('chatLog').appendChild(div);
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
    return div;
  }

  function aiTyping() {
    const div = document.createElement('div');
    div.className = 'msg ai';
    div.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    $('chatLog').appendChild(div);
    $('chatLog').scrollTop = $('chatLog').scrollHeight;
    return div;
  }

  async function aiSend() {
    const input = $('chatInput');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    input.style.height = 'auto';
    aiAppend('me', q);
    $('btnAsk').disabled = true;
    const t = aiTyping();
    try {
      const r = await api.post('/agent/chat', { message: q });
      t.remove();
      aiAppend('ai', r.answer || '（没有回答）');

      if (r.needsConfirm && r.pending && r.pending.length) {
        pendingConfirm = r.pending;
        $('aiConfirmText').textContent = '需要确认：' + r.pending.map((p) => p.summary).join('；');
        $('aiConfirm').classList.add('on');
      }
      // 写操作执行后刷新数据
      if (r.actions && r.actions.some((a) => a.ok)) await refreshAll();
    } catch (e) {
      t.remove();
      aiAppend('ai', '出错了：' + e.message);
    } finally {
      $('btnAsk').disabled = false;
    }
  }

  $('btnAsk').addEventListener('click', aiSend);
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiSend(); }
  });
  $('chatInput').addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 110) + 'px';
  });

  $('aiConfirmNo').addEventListener('click', () => {
    pendingConfirm = null;
    $('aiConfirm').classList.remove('on');
    aiAppend('sys', '已取消该操作');
  });

  $('aiConfirmYes').addEventListener('click', async () => {
    if (!pendingConfirm || !pendingConfirm.length) return;
    const list = pendingConfirm.slice();
    pendingConfirm = null;
    $('aiConfirm').classList.remove('on');
    $('btnAsk').disabled = true;
    for (const op of list) {
      const t = aiTyping();
      try {
        const r = await api.post('/agent/chat', { message: '确认执行', confirm: { tool: op.tool, args: op.args } });
        t.remove();
        aiAppend('ai', r.answer || '已执行');
      } catch (e) {
        t.remove();
        aiAppend('ai', '执行失败：' + e.message);
      }
    }
    $('btnAsk').disabled = false;
    await refreshAll();
  });

  $('aiRefresh').addEventListener('click', loadInsights);

  /* ==================== 子页：语音提醒 ==================== */
  let mediaRecorder = null;
  let chunks = [];
  let recording = false;
  let recTimer = null;
  let recStart = 0;

  async function loadVoices() {
    const e = currentElder();
    const sel = $('vPlan');
    sel.innerHTML = '<option value="">通用提醒（每顿都放）</option>' +
      ((e ? schedulesOf(e.id) : []).map((s) =>
        `<option value="${s.id}">${hhmm(s.dose_time)} ${s.time_label || ''}</option>`).join(''));

    if (!e) {
      $('vList').innerHTML = empty('🎙️', '请先添加老人');
      $('vCount').textContent = '';
      return;
    }
    const list = await api.get('/recordings?elder_id=' + e.id).catch(() => []);
    $('vCount').textContent = list.length ? `${list.length} 段` : '';
    if (!list.length) {
      $('vList').innerHTML = empty('🎙️', '还没有录音，录一段给老人听');
      return;
    }
    $('vList').innerHTML = list.map((r) => `
      <div class="row" data-rec="${r.id}">
        <div class="ico">${r.enabled ? '🔊' : '🔇'}</div>
        <div class="tx"><b>${esc(r.title || '家人录音')}</b>
          <small>${r.dialect ? esc(r.dialect) + ' · ' : ''}${r.duration_sec ? r.duration_sec + ' 秒 · ' : ''}${r.enabled ? '启用中' : '已停用'}</small></div>
        <button class="btn-mini" data-play="${esc(r.audio_url || '')}">播放</button>
      </div>`).join('');

    $('vList').querySelectorAll('[data-play]').forEach((b) => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const url = b.dataset.play;
        if (!url) return toast('该录音没有音频文件', true);
        new Audio(url).play().catch(() => toast('播放失败', true));
      });
    });
    $('vList').querySelectorAll('[data-rec]').forEach((row) => {
      row.addEventListener('click', () => {
        const r = list.find((x) => Number(x.id) === Number(row.dataset.rec));
        if (!r) return;
        openSheet({
          title: r.title || '家人录音',
          sub: r.dialect || '',
          body: `<div class="sh-acts" style="flex-direction:column">
              <button class="btn-ghost" id="rc_toggle">${r.enabled ? '停用这段录音' : '启用这段录音'}</button>
              <button class="btn-ghost" id="rc_del" style="color:var(--bad);border-color:#EED8D2">删除</button>
            </div>`,
          onMount: () => {
            $('rc_toggle').addEventListener('click', async () => {
              try {
                await api.put('/recordings/' + r.id, { enabled: !r.enabled });
                toast('已更新');
                closeSheet();
                await loadVoices();
              } catch (e) { /* 已 toast */ }
            });
            $('rc_del').addEventListener('click', async () => {
              try {
                await api.del('/recordings/' + r.id);
                toast('已删除');
                closeSheet();
                await loadVoices();
              } catch (e) { /* 已 toast */ }
            });
          },
        });
      });
    });
  }

  $('btnRec').addEventListener('click', async () => {
    if (!recording) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
        mediaRecorder.start();
        recording = true;
        recStart = Date.now();
        $('recBox').classList.add('on');
        $('recHint').textContent = '正在录音，点一下停止';
        recTimer = setInterval(() => {
          const s = Math.floor((Date.now() - recStart) / 1000);
          $('recTime').textContent = `00:${String(s).padStart(2, '0')}`;
        }, 200);
      } catch (e) {
        toast('无法使用麦克风：' + e.message, true);
      }
      return;
    }

    // 停止
    recording = false;
    clearInterval(recTimer);
    $('recBox').classList.remove('on');
    $('recHint').textContent = '已停止，正在保存…';
    const dur = Math.round((Date.now() - recStart) / 1000);

    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      mediaRecorder.stream.getTracks().forEach((t) => t.stop());
      if (blob.size < 1200) {
        $('recHint').textContent = '录得太短了，请重录';
        return;
      }
      const reader = new FileReader();
      reader.onloadend = async () => {
        try {
          const up = await api.post('/recordings/upload', { base64: reader.result, ext: 'webm' });
          window.__voiceUrl = up.url;
          window.__voiceDur = dur;
          $('recHint').textContent = '录好了，点下面按钮保存';
          $('btnSaveVoice').dataset.ready = '1';
          toast('录音已上传，记得点保存');
        } catch (e) {
          $('recHint').textContent = '上传失败，请重试';
        }
      };
      reader.readAsDataURL(blob);
    };
    mediaRecorder.stop();
  });

  $('btnSaveVoice').addEventListener('click', async () => {
    const e = currentElder();
    if (!e) return toast('请先添加老人', true);
    if (!window.__voiceUrl) return toast('请先录音', true);
    const planId = $('vPlan').value;
    const plan = planId ? schedulesOf(e.id).find((s) => Number(s.id) === Number(planId)) : null;
    try {
      await api.post('/recordings', {
        elder_id: e.id,
        schedule_id: planId ? Number(planId) : null,
        title: plan ? `${hhmm(plan.dose_time)} ${plan.time_label || ''}提醒` : '通用服药提醒',
        audio_url: window.__voiceUrl,
        duration_sec: window.__voiceDur || null,
        dialect: $('vDialect').value.trim() || null,
      });
      window.__voiceUrl = null;
      $('btnSaveVoice').dataset.ready = '';
      $('recHint').textContent = '保存成功，可以再录一段';
      $('recTime').textContent = '00:00';
      toast('已保存，到点会播放');
      await loadVoices();
    } catch (e2) { /* 已 toast */ }
  });

  /* ==================== 子页：家庭成员 ==================== */
  function loadFamily() {
    if (!M.elders.length) {
      $('famElder').innerHTML = empty('👵', '还没有老人档案');
    } else {
      $('famElder').innerHTML = M.elders.map((e) => `
        <div class="row">
          <div class="ico">${esc(avatarText(e.name))}</div>
          <div class="tx"><b>${esc(elderCall(e))}</b>
            <small>${[ageText(e), e.chronic_diseases || '', e.allergies ? '过敏：' + e.allergies : ''].filter(Boolean).join(' · ') || '—'}</small></div>
        </div>`).join('');
    }

    const box = mainBox();
    if (!box) {
      $('famDevice').innerHTML = empty('📦', '还没有绑定药箱');
    } else {
      $('famDevice').innerHTML = `
        <div class="row">
          <div class="ico">📦</div>
          <div class="tx"><b>${esc(box.device_code)}</b>
            <small>${box.status === 'online' ? '在线' : '离线'}${box.elders && box.elders.length ? ` · 服务 ${box.elders.length} 位老人` : ''}</small></div>
          <span class="stt ${box.status === 'online' ? 'ok' : 'bad'}">${box.status === 'online' ? '在线' : '离线'}</span>
        </div>`;
    }

    $('famCount').textContent = M.members.length ? `${M.members.length} 人` : '';
    if (!M.members.length) {
      $('famList').innerHTML = empty('👨‍👩‍👧', '还没有其他成员');
    } else {
      $('famList').innerHTML = M.members.map((u) => `
        <div class="row">
          <div class="ico">${esc(avatarText(u.realName || u.real_name || u.username))}</div>
          <div class="tx"><b>${esc(u.realName || u.real_name || u.username)}</b>
            <small>${({ owner: '主配置人', member: '可配置', viewer: '只读' })[u.role] || u.role}</small></div>
          <span class="stt ${u.role === 'owner' ? 'pri' : 'mute'}">${({ owner: '主配置', member: '可配置', viewer: '只读' })[u.role] || u.role}</span>
        </div>`).join('');
    }
  }

  $('btnInvite').addEventListener('click', () => {
    const box = mainBox();
    if (!box) return toast('还没有绑定药箱', true);
    openSheet({
      title: '生成药箱绑定码',
      sub: '让老人端输入这 6 位数字即可使用',
      body: `<p style="font-size:13px;color:var(--sub);line-height:1.7">绑定码 5 分钟内有效，只能在老人端输入一次。</p>
        <div class="sh-acts"><button class="btn-ghost" id="bc_c">关闭</button>
        <button class="btn-primary" id="bc_go">生成绑定码</button></div>
        <div id="bc_out" style="margin-top:14px"></div>`,
      onMount: () => {
        $('bc_c').addEventListener('click', closeSheet);
        $('bc_go').addEventListener('click', async () => {
          try {
            const r = await api.post('/auth/bind-code', { medbox_id: Number(box.id) });
            $('bc_out').innerHTML = `<div style="text-align:center;padding:14px;background:var(--tint);border-radius:12px">
              <div style="font-size:30px;font-weight:600;letter-spacing:8px;color:var(--primary);font-family:var(--num)">${r.bindCode}</div>
              <div style="font-size:11.5px;color:var(--sub);margin-top:6px">5 分钟内有效</div></div>`;
          } catch (e) { /* 已 toast */ }
        });
      },
    });
  });

  /* ==================== 新增计划 ==================== */
  $('btnAddPlan').addEventListener('click', () => {
    const e = currentElder();
    if (!e) return toast('请先添加老人', true);
    if (!M.medicines.length) return toast('请先在「药箱」添加药品', true);

    openSheet({
      title: '新增服药计划',
      sub: `${elderCall(e)} · 一个时间点 + 要吃的药`,
      body: `
        <div class="f2">
          <div class="field"><label>服药时间</label><input id="np_time" type="time" value="08:00"></div>
          <div class="field"><label>时段</label>
            <select id="np_label">
              <option>早上</option><option>中午</option><option>下午</option><option>晚上</option><option>睡前</option>
            </select></div>
        </div>
        <div class="field"><label>放第几格（药箱隔间）</label>
          <select id="np_comp">
            <option value="">暂不指定</option>
            ${M.compartments.map((c) => {
              const used = c.schedule_id
                ? `${hhmm(c.dose_time)} ${c.time_label || ''} ${c.elder_name || ''} 已占用`.replace(/\s+/g, ' ')
                : '空闲';
              return `<option value="${c.id}" ${c.schedule_id ? 'disabled' : ''}>第 ${c.slot_no} 格（${esc(used)}）</option>`;
            }).join('')}
          </select>
          <small style="display:block;font-size:11px;color:var(--faint);margin-top:5px">
            绑好隔间后，到点只会解锁这一次该吃的那一格；不指定则视为不联动物理药箱。
          </small>
        </div>
        <div class="f2">
          <div class="field"><label>提前提醒(分钟)</label><input id="np_before" type="number" value="10"></div>
          <div class="field"><label>超时判定(分钟)</label><input id="np_after" type="number" value="30"></div>
        </div>
        <div class="field"><label>选择药品（可多选）</label>
          <div class="chips" id="np_meds" style="flex-wrap:wrap;overflow:visible">
            ${M.medicines.map((m) => `<button type="button" data-mid="${m.id}">${esc(m.name)}</button>`).join('')}
          </div>
        </div>
        <div class="sh-acts"><button class="btn-ghost" id="np_cancel">取消</button>
        <button class="btn-primary" id="np_save">保存计划</button></div>`,
      onMount: () => {
        const picked = new Set();
        // 默认选中第一个空闲隔间，子女少点一次（真到装药时也知道该放哪格）
        const free = M.compartments.find((c) => !c.schedule_id);
        if (free) $('np_comp').value = String(free.id);
        $('np_meds').querySelectorAll('button').forEach((b) => {
          b.addEventListener('click', () => {
            const id = Number(b.dataset.mid);
            if (picked.has(id)) { picked.delete(id); b.classList.remove('on'); }
            else { picked.add(id); b.classList.add('on'); }
          });
        });
        $('np_cancel').addEventListener('click', closeSheet);
        $('np_save').addEventListener('click', async () => {
          const time = $('np_time').value;
          if (!time) return toast('请选择时间', true);
          if (!picked.size) return toast('至少选一种药', true);
          try {
            await api.post('/schedules', {
              elder_id: e.id,
              dose_time: time + ':00',
              time_label: $('np_label').value,
              compartment_id: $('np_comp').value ? Number($('np_comp').value) : null,
              window_before_min: Number($('np_before').value) || 10,
              window_after_min: Number($('np_after').value) || 30,
              items: [...picked].map((mid) => ({ medicine_id: mid, dose_qty: 1 })),
            });
            toast('计划已创建');
            closeSheet();
            await refreshAll();
            switchTab('care', 'plan');
          } catch (err) { /* 已 toast */ }
        });
      },
    });
  });

  /* ==================== 新增药品（含拍照识药） ==================== */
  $('btnAddMed').addEventListener('click', () => {
    openSheet({
      title: '添加药品',
      sub: '可以拍照让 AI 自动填写',
      body: `
        <input type="file" id="mv_file" accept="image/*" capture="environment" style="display:none">
        <button class="btn-ghost" id="mv_photo" style="margin-bottom:12px">📷 拍照识药（AI 自动填写）</button>
        <div id="mv_note" style="display:none;font-size:11.5px;line-height:1.6;margin-bottom:10px;padding:8px 11px;border-radius:9px;background:#FFF6E5;border:1px solid #F0DFBC;color:#8a6d3b"></div>
        <div class="field"><label>药品名称 *</label><input id="mv_name" placeholder="如 苯磺酸氨氯地平片"></div>
        <div class="f2">
          <div class="field"><label>规格</label><input id="mv_spec" placeholder="5mg×28片"></div>
          <div class="field"><label>单位</label><input id="mv_unit" value="片"></div>
        </div>
        <div class="f2">
          <div class="field"><label>库存</label><input id="mv_qty" type="number" value="0"></div>
          <div class="field"><label>预警阈值</label><input id="mv_alert" type="number" value="7"></div>
        </div>
        <div class="f2">
          <div class="field"><label>有效期至</label><input id="mv_exp" type="date"></div>
          <div class="field"><label>分类</label>
            <select id="mv_cat">
              <option value="">未分类</option><option>降压</option><option>降糖</option><option>调脂</option>
              <option>心血管</option><option>抗菌</option><option>解热镇痛</option><option>营养补充</option><option>其他</option>
            </select></div>
        </div>
        <div class="field"><label>主要成分（逗号分隔）</label><input id="mv_ing" placeholder="用于相互作用检测"></div>
        <div class="sh-acts"><button class="btn-ghost" id="mv_cancel">取消</button>
        <button class="btn-primary" id="mv_save">保存</button></div>`,
      onMount: () => {
        const note = $('mv_note');
        const setNote = (txt, ok) => {
          note.style.display = 'block';
          note.textContent = txt;
          note.style.background = ok ? '#EAF5EE' : '#FFF6E5';
          note.style.borderColor = ok ? '#CBE4D3' : '#F0DFBC';
          note.style.color = ok ? '#2F6B63' : '#8a6d3b';
        };

        $('mv_cancel').addEventListener('click', closeSheet);
        $('mv_photo').addEventListener('click', () => $('mv_file').click());

        $('mv_file').addEventListener('change', async (ev) => {
          const f = ev.target.files && ev.target.files[0];
          if (!f) return;
          if (f.size > 8 * 1024 * 1024) return toast('图片过大（≤8MB）', true);
          setNote('正在识别，请稍候…', true);
          try {
            const dataUrl = await shrinkImage(f, 1280);
            const r = await api.post('/vision/recognize', { image: dataUrl });
            if (r && r.ok && r.medicine) {
              const m = r.medicine;
              if (m.name) $('mv_name').value = m.name;
              if (m.spec) $('mv_spec').value = m.spec;
              if (m.active_ingredient) $('mv_ing').value = m.active_ingredient;
              if (m.category) {
                const opt = [...$('mv_cat').options].find((o) => o.text === m.category);
                if (opt) $('mv_cat').value = opt.value;
              }
              if (m.expiry_date && /^\d{4}-\d{2}-\d{2}$/.test(m.expiry_date)) $('mv_exp').value = m.expiry_date;
              setNote('AI 已填写，请核对后再保存。', true);
            } else {
              setNote((r && r.note) || '没能识别，请手工填写', false);
            }
          } catch (e) {
            setNote('识别失败，请手工填写', false);
          }
        });

        $('mv_save').addEventListener('click', async () => {
          const name = $('mv_name').value.trim();
          if (!name) return toast('请填写药品名称', true);
          try {
            await api.post('/medicines', {
              name,
              spec: $('mv_spec').value.trim() || null,
              unit: $('mv_unit').value.trim() || '片',
              stock_qty: Number($('mv_qty').value) || 0,
              stock_alert_qty: Number($('mv_alert').value) || 7,
              expiry_date: $('mv_exp').value || null,
              category: $('mv_cat').value || null,
              active_ingredient: $('mv_ing').value.trim() || null,
            });
            toast('已添加');
            closeSheet();
            await refreshAll();
          } catch (e) { /* 已 toast */ }
        });
      },
    });
  });

  /** 前端压缩图片，避免上传过大 base64 */
  function shrinkImage(file, maxSize) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  /* ==================== 子页生命周期 ==================== */
  function onSubOpen(id) {
    if (id === 'sp-alert') loadAlerts();
    if (id === 'sp-assistant') { paintTabs('ai'); loadInsights(); } // AI 页 = 底部导航的一项
    if (id === 'sp-voice') loadVoices();
    if (id === 'sp-policy') renderPolicy();
    if (id === 'sp-family') loadFamily();
  }

  /* ==================== 顶栏按钮 ==================== */
  $('btnBell').addEventListener('click', () => openSub('sp-alert'));
  $('btnToElder').addEventListener('click', () => {
    location.href = '/m/elder.html';
  });

  /* ==================================================================
     AI 入口
     · 导航栏正中心「AI 用药助手」→ 完整助手页（主动建议 + 问答）
     · 悬浮球（可拖动）→ 随手问气泡，不离开当前页就能问一句
     ================================================================== */
  $('btnAiTab').addEventListener('click', () => {
    const sp = $('sp-assistant');
    if (sp.classList.contains('on')) {   // 再点一次就退回原来那页
      closeSub('sp-assistant');
      paintTabs(curTab);
      return;
    }
    togglePop(false);
    openSub('sp-assistant');
    paintTabs('ai');           // 底部中间的 AI 项高亮
  });

  const fab = $('aiFab');
  const aiPop = $('aiPop');
  const FAB_KEY = 'm_ai_fab';

  /* ---------- 气泡开合 ---------- */
  /** 软键盘弹起时占掉的高度（视觉视口和布局视口的差） */
  function kbOffset() {
    const vv = window.visualViewport;
    if (!vv) return 0;
    return Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  }
  function placePop() {
    const r = fab.getBoundingClientRect();
    const kb = kbOffset();
    aiPop.style.left = 'auto';
    aiPop.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
    const h = aiPop.offsetHeight || 320;
    const want = window.innerHeight - r.top + 10;            // 贴在球上方
    const maxB = Math.max(12, window.innerHeight - h - 8);    // 别顶出屏幕
    const bottom = Math.max(kb + 10, Math.min(want, maxB));   // 但一定要在键盘上方
    aiPop.style.bottom = bottom + 'px';
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
      if (aiPop.classList.contains('on')) placePop();
    });
  }
  function togglePop(force) {
    const on = force === undefined ? !aiPop.classList.contains('on') : !!force;
    if (on) { placePop(); aiPop.classList.add('on'); setTimeout(() => $('apInput').focus(), 180); }
    else { aiPop.classList.remove('on'); $('apCfm').classList.remove('on'); apPending = null; }
  }
  $('apClose').addEventListener('click', () => togglePop(false));
  $('apMore').addEventListener('click', () => {
    togglePop(false);
    openSub('sp-assistant');
  });
  document.addEventListener('pointerdown', (e) => {
    if (!aiPop.classList.contains('on')) return;
    if (aiPop.contains(e.target) || fab.contains(e.target)) return;
    togglePop(false);
  });

  /* ---------- 拖动（桌面上看是手机框架，手机上就是随手挪） ---------- */
  let fabPos = { x: 0, y: 0 };
  function paintFab() { fab.style.transform = `translate(${fabPos.x}px,${fabPos.y}px)`; }
  function setFabPos(x, y) {
    const keep = fab.style.transform;
    fab.style.transform = 'translate(0,0)';
    const base = fab.getBoundingClientRect();
    fab.style.transform = keep || '';
    const app = $('app').getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minX = Math.max(app.left, 0) + 6 - base.left;
    const maxX = Math.min(app.right, vw) - 6 - base.right;
    const minY = 8 - base.top;
    const maxY = vh - 8 - base.bottom;
    fabPos.x = Math.min(Math.max(x, minX), Math.max(minX, maxX));
    fabPos.y = Math.min(Math.max(y, minY), Math.max(minY, maxY));
    paintFab();
  }
  (function restoreFab() {
    try {
      const p = JSON.parse(localStorage.getItem(FAB_KEY) || 'null');
      if (p && typeof p.x === 'number') {
        fabPos = { x: p.x, y: p.y };
        fab.style.animation = 'none';
        paintFab();
      }
    } catch (e) { /* 忽略 */ }
  })();

  fab.addEventListener('pointerdown', (e) => {
    if (e.button && e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY, px: fabPos.x, py: fabPos.y };
    let moved = false;
    fab.classList.add('dragging');
    try { fab.setPointerCapture(e.pointerId); } catch (err) { /* 老浏览器忽略 */ }

    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!moved && Math.abs(dx) + Math.abs(dy) > 5) moved = true;
      if (!moved) return;
      if (aiPop.classList.contains('on')) togglePop(false);
      setFabPos(start.px + dx, start.py + dy);
    };
    const up = () => {
      fab.removeEventListener('pointermove', move);
      fab.removeEventListener('pointerup', up);
      fab.removeEventListener('pointercancel', up);
      fab.classList.remove('dragging');
      if (moved) { try { localStorage.setItem(FAB_KEY, JSON.stringify(fabPos)); } catch (err) { /* 忽略 */ } }
      else togglePop();
    };
    fab.addEventListener('pointermove', move);
    fab.addEventListener('pointerup', up);
    fab.addEventListener('pointercancel', up);
  });

  /* ---------- 随手问 ---------- */
  let apPending = null;
  let apBusy = false;

  function apAppend(role, text) {
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.textContent = text;
    $('apLog').appendChild(d);
    $('apLog').scrollTop = $('apLog').scrollHeight;
    return d;
  }
  function apTyping() {
    const d = document.createElement('div');
    d.className = 'msg ai';
    d.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    $('apLog').appendChild(d);
    $('apLog').scrollTop = $('apLog').scrollHeight;
    return d;
  }

  async function apSend() {
    if (apBusy) return;
    const q = $('apInput').value.trim();
    if (!q) return;
    $('apInput').value = '';
    apAppend('me', q);
    apBusy = true;
    $('apSend').disabled = true;
    const t = apTyping();
    try {
      const r = await api.post('/agent/chat', { message: q });
      t.remove();
      apAppend('ai', r.answer || '（没有回答）');
      if (r.needsConfirm && r.pending && r.pending.length) {
        apPending = r.pending;
        $('apCfmText').textContent = '需要确认：' + r.pending.map((p) => p.summary).join('；');
        $('apCfm').classList.add('on');
        placePop();
      }
      if (r.actions && r.actions.some((a) => a.ok)) await refreshAll();
    } catch (e) {
      t.remove();
      apAppend('ai', '出错了：' + e.message);
    } finally {
      apBusy = false;
      $('apSend').disabled = false;
    }
  }

  $('apSend').addEventListener('click', apSend);
  $('apInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apSend(); }
  });
  $('apNo').addEventListener('click', () => {
    apPending = null;
    $('apCfm').classList.remove('on');
    apAppend('sys', '已取消该操作');
    placePop();
  });
  $('apYes').addEventListener('click', async () => {
    if (!apPending || !apPending.length) return;
    const list = apPending.slice();
    apPending = null;
    $('apCfm').classList.remove('on');
    placePop();
    for (const op of list) {
      const t = apTyping();
      try {
        const r = await api.post('/agent/chat', { message: '确认执行', confirm: { tool: op.tool, args: op.args } });
        t.remove();
        apAppend('ai', r.answer || '已执行');
      } catch (e) {
        t.remove();
        apAppend('ai', '执行失败：' + e.message);
      }
    }
    await refreshAll();
  });

  /* ==================== 启动 ==================== */
  async function refreshAll() {
    await loadAll();
    await loadOverview();
    if (curTab === 'care') switchSeg(curSeg);
    if (curTab === 'box') renderBox();
    if (curTab === 'me') renderMe();
  }

  try {
    showSkel('ovTimeline', 3);
    await loadAll();
    await loadOverview();
    renderPlan();
  } catch (e) {
    toast('加载失败：' + e.message, true);
  }

  /* ==================== 两端自动同步（轻量轮询） ==================== */
  /**
   * 手机端和网页端读写的本来就是同一个 MySQL，但浏览器不会自己知道「对面刚改了数据」。
   * 没有 WebSocket 的前提下，最省事的做法就是定时回来问一次。
   *
   * 为什么叫「轻量」—— 三条约束：
   *   1. 不走 refreshAll()（那是 7 个接口的全量），只拉当前 tab 真正显示的那几个：
   *      首页 3 个、用药 3 个、药箱 2 个、我的 3 个。
   *   2. 用户正在操作时绝不打扰 —— 弹层打开、子页打开、输入框聚焦、页面切到后台，
   *      这一轮直接跳过。轮询是静默的，用户不知道它什么时候来，
   *      一次重渲染把正在填的内容冲掉，比不同步更糟。
   *   3. 失败静默重试：网络抖一下就弹 toast 会显得很吵，下一轮自然补上。
   */
  const SYNC_MS = 15000;
  let syncBusy = false;

  function syncBlocked() {
    if (document.hidden) return true;                            // 页面在后台
    if (document.querySelector('.subpage.on')) return true;      // 子页（含 AI 页）开着
    if (document.querySelector('.sheet.on')) return true;        // 底部弹层开着
    const el = document.activeElement;                           // 光标在输入框里
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
    return false;
  }

  /** 只刷新「当前这一屏」需要的数据 */
  async function syncCurrentTab() {
    const e = currentElder();
    if (!e) return;                       // 还没有老人档案，没什么可同步的

    if (curTab === 'overview') {
      // 首页信息密度最高（今日进度 / 依从率 / 下次该吃 / 告警），整体重拉最省事；
      // 传 true 走轻量模式跳过 AI 建议 —— 那块 15 秒刷一次既没必要也浪费
      await loadOverview(true);
      return;
    }

    if (curTab === 'care') {
      // 计划列表用 M.schedules + dash（周图与打卡状态都在 dash 里），两个都得更新
      const [sch, med, d] = await Promise.all([
        api.get('/schedules').catch(() => null),
        api.get('/medicines').catch(() => null),
        api.get(`/dashboard/${e.id}?days=7`).catch(() => null),
      ]);
      if (sch) M.schedules = sch;
      if (med) M.medicines = med;
      if (d) dash = d;
      if (curSeg === 'plan') renderPlan();
      else await renderHistory();         // 记录页自己会去拉 /events
      return;
    }

    if (curTab === 'box') {
      const [med, boxes] = await Promise.all([
        api.get('/medicines').catch(() => null),
        api.get('/medbox').catch(() => null),
      ]);
      if (med) M.medicines = med;
      if (boxes) M.medboxes = boxes;
      renderBox();
      return;
    }

    if (curTab === 'me') {
      const [me, elders, members] = await Promise.all([
        api.get('/auth/me').catch(() => null),
        api.get('/elders').catch(() => null),
        api.get('/users').catch(() => null),
      ]);
      if (me) M.me = me;
      if (elders) M.elders = elders;
      if (members) M.members = members;
      renderMe();
    }
  }

  async function quietSync() {
    if (syncBusy || syncBlocked() || !api.getToken()) return;
    syncBusy = true;                       // 防止上一轮还没回来又发起一轮（弱网下会堆请求）
    try {
      await syncCurrentTab();
      renderBell();                        // 未处理告警红点，任何页面都该及时更新
    } catch (err) {
      /* 服务重启、网络抖动：这一轮放弃，15 秒后自动重试 */
    } finally {
      syncBusy = false;
    }
  }

  setInterval(quietSync, SYNC_MS);

  // 从后台切回来（切回微信、解锁屏幕）立刻对齐一次，不用干等 15 秒
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) quietSync();
  });
})();
