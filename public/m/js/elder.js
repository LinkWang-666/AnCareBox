/**
 * 安心格 · 移动端老人端逻辑
 *
 * 设计原则（零学习成本）：
 *   1. 打开就告诉老人「现在该吃第几格」，大字 + 8 格高亮，不需要任何选择
 *   2. 有子女录音就放录音，没有就用浏览器语音合成兜底
 *   3. 只有三个可操作物：我吃好了 / 我不舒服 / 打卡圆点（只展示）
 *
 * 登录：老人不记密码。首次输入子女给的 6 位绑定码，换回长期设备令牌，
 * 之后自动生效；令牌与子女端分开存放（mb_device_token），同机互不干扰。
 */
(async function () {
  'use strict';

  // 老人端用独立令牌键，避免与子女端互相顶掉
  api.setTokenKey('mb_device_token');

  const $ = (id) => document.getElementById(id);
  let current = null;
  let me = null;
  let selectedElderId = null;

  // 播报控制：同一顿只提醒一次；吃完彻底安静；下一顿才重新提醒
  let announcedKey = null;
  let finishedKey = null;
  let firstLoad = true;

  function remindKey(data) {
    if (!data || !data.schedule) return 'none';
    const s = data.schedule;
    return String(data.elderId || '') + '|' + String(s.id || '') + '|' + String(s.time_label || s.slot_no || '');
  }

  function stopSound() {
    try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    const p = $('player');
    if (p) { try { p.pause(); } catch (e) { /* 忽略 */ } }
  }

  function showBind() {
    api.clearToken();
    $('mainWrap').style.display = 'none';
    $('mainHead').style.display = 'none';
    $('whoBar').style.display = 'none';
    $('bindWrap').style.display = 'block';
  }
  api.setUnauthorizedHandler(showBind);

  /* ---------- 时钟 ---------- */
  function tick() {
    const d = new Date();
    $('clock').textContent =
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
    $('dateLine').textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
  }
  tick();
  setInterval(tick, 10000);

  /* ---------- 语音 ---------- */
  function speak(text) {
    // 播报只是锦上添花：任何一步失败都不能拦住后面的 UI 逻辑（比如 SOS 的二次确认）
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 0.85;
      u.volume = 1;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 没有可用语音时静默跳过 */ }
  }

  function fallbackText(data) {
    if (!data || !data.schedule) return '现在不是服药时间，请注意休息。';
    const slot = data.schedule.slot_no ? `吃第 ${data.schedule.slot_no} 格的药。` : '';
    const meds = (data.items || []).map((i) => `${i.medicine_name} ${i.dose_qty}${i.unit || ''}`).join('，');
    return `${slot}现在是${data.now}，该吃${data.schedule.time_label || ''}的药了。${meds}。请全部取出，用温水送服。`;
  }

  function announce(data) {
    if (data.recording && data.recording.audio_url) {
      const p = $('player');
      p.src = data.recording.audio_url;
      p.play().catch(() => speak(fallbackText(data)));
      return;
    }
    speak(fallbackText(data));
  }

  function greetLine(data) {
    const name = data && data.elderName ? data.elderName : '';
    const gender = data && data.gender;
    let call = name || '您好';
    if (name) call = name + (gender === 'male' ? '爷爷' : gender === 'female' ? '奶奶' : '');
    const hour = new Date().getHours();
    const hello = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
    return `${call}，${hello}`;
  }

  /** 副标题：一眼说清「现在该干嘛」 */
  function subLine(data) {
    if (!data) return '';
    if (!data.schedule) return '今天没有安排，好好休息';
    if (!data.inWindow) {
      return `今天还有 ${Math.max(0, (data.todayTotal || 0) - (data.todayDone || 0))} 次没吃`;
    }
    const slot = data.schedule.slot_no ? `第 ${data.schedule.slot_no} 格` : '';
    return `现在该吃 ${slot} 的药`;
  }

  /* ---------- 主任务卡 ---------- */
  function renderNow(data) {
    const box = $('nowBox');
    const s = data.schedule;
    const slot = s ? s.slot_no : 0;
    const ready = data.inWindow !== false;

    const cells = [];
    const total = Math.max(8, slot || 0);
    for (let i = 1; i <= total; i++) {
      const cls = i === slot ? ' now' : '';
      cells.push(`<div class="cell${cls}">${i}${i === slot ? '<small>开这格</small>' : ''}</div>`);
    }

    if (s && (data.items || []).length) {
      const meds = data.items.map((i) => `${esc(i.medicine_name)} ${i.dose_qty}${esc(i.unit || '')}`).join(' · ');
      const pieces = data.items.reduce((a, i) => a + Number(i.dose_qty || 0), 0);
      const timeTxt = String(s.dose_time).slice(0, 5);

      box.style.display = 'block';
      box.innerHTML = `
        <div class="ecard">
          ${ready
            ? '<span class="enow-badge">🔔 现在该吃药了</span>'
            : `<span class="enow-badge" style="background:#8a857b">⏰ 下一顿 ${timeTxt}</span>`}
          <div class="etitle">${ready ? `吃第 ${slot || '-'} 格的药` : `第 ${slot || '-'} 格 · ${timeTxt}`}</div>
          <div class="esub">${esc(s.time_label || '')}的药 · 共 ${pieces} ${esc((data.items[0] || {}).unit || '片')}</div>
          <div class="emeds">${meds}</div>
          <div class="egrid">${cells.join('')}</div>
          <div class="voice-line"><span class="spk">🔊</span><span>${
            ready
              ? (data.recording ? `正在播放${esc(data.recording.dialect || '子女')}的录音提醒` : fallbackText(data))
              : '到点了我会提醒您，请先歇一会儿。'
          }</span></div>
          ${ready ? `<button class="sos-card take" id="btnTake" style="margin-top:18px">
            <span class="big">✓ 我吃好了</span>
          </button>` : ''}
        </div>`;
      if (ready) bindTakeBtn();
    } else {
      box.style.display = 'none';
    }
  }

  function bindTakeBtn() {
    const b = $('btnTake');
    if (!b) return;
    b.addEventListener('click', async () => {
      try {
        // 不传 device_code：后端从设备令牌里取，防止冒名上报
        const r = await api.post('/events', {
          slot_no: current && current.schedule && current.schedule.slot_no ? current.schedule.slot_no : 1,
          event_type: 'take',
          dose_qty: 1,
          source: 'manual',
        });
        stopSound();
        const result = (r.event && r.event.result) || 'on_time';
        // 判成重复取药必须播报拦截话术（方案书 2.5），不能一律「祝您健康」
        if (result === 'duplicate') {
          speak('这个药已经吃过了，请不要重复服用。');
          toast('这个药已经吃过了，请不要重复服用', true);
        } else if (result === 'abnormal') {
          speak('现在不是这个药的服用时间，请先休息。');
          toast('不在服药时段，已记录', true);
        } else {
          finishedKey = remindKey(current);
          speak('已经记录，祝您健康。');
          toast('已记录：' + (RESULT_TEXT[result] || result));
        }
        await load();
      } catch (e) { /* api 已提示 */ }
    });
  }

  /* ---------- 今日打卡 ---------- */
  function renderDots(data) {
    const slots = data.daySlots || [];
    const doneIds = data.doneSlotIds || [];
    const currentId = data.schedule ? data.schedule.id : null;
    if (!slots.length) {
      $('dayDots').innerHTML = '<span style="font-size:22px;color:#8a857b">今天没有安排</span>';
      return;
    }
    $('dayDots').innerHTML = slots.map((s) => {
      const done = doneIds.includes(Number(s.id));
      const now = Number(currentId) === Number(s.id) && !done;
      return `<div class="slot ${done ? 'done' : ''}${now ? ' now' : ''}">
        <i></i>${esc(s.time_label || String(s.dose_time).slice(0, 5))}
      </div>`;
    }).join('');
  }

  /* ---------- 共用模式切换 ---------- */
  function renderWhoBar(data) {
    const bar = $('whoBar');
    const elders = data && data.elders;
    if (!elders || elders.length < 2) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    bar.innerHTML =
      '<span class="who-label">现在是谁用药：</span>' +
      elders.map((e) => `
        <button class="who-btn${Number(e.id) === Number(data.elderId) ? ' on' : ''}" data-eid="${e.id}">
          ${esc(e.name)}${e.gender === 'male' ? '爷爷' : e.gender === 'female' ? '奶奶' : ''}
        </button>`).join('');
    bar.querySelectorAll('.who-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.eid);
        if (id === Number(current && current.elderId)) return;
        selectedElderId = id;
        announcedKey = null;
        finishedKey = null;
        firstLoad = true;
        stopSound();
        speak('好的，现在查看另一位老人的用药。');
        load();
      });
    });
  }

  /* ---------- 家人录音 ---------- */
  async function renderVoices(data) {
    const box = $('voiceBox');
    const eid = (data && data.elderId) || null;
    if (!eid) { box.style.display = 'none'; return; }
    const list = await api.get('/recordings?elder_id=' + eid).catch(() => []);
    const usable = (list || []).filter((r) => r.enabled && r.audio_url);
    if (!usable.length) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    // 绑定了时段的录音，在标题下面标出是哪一顿 —— 老人一眼就知道哪段是早上吃的药，
    // 不用逐条点开听。只加一行小字，不增加任何新操作。
    const slotName = {};
    ((data && data.daySlots) || []).forEach((s) => {
      slotName[Number(s.id)] = s.time_label || String(s.dose_time || '').slice(0, 5);
    });
    $('voiceList').innerHTML = usable.map((r) => `
      <button class="vitem" data-url="${esc(r.audio_url)}">
        <span class="pi">▶</span>
        <span>${esc(r.title || '家人录音')}
          <small>${esc(r.dialect || '')}${r.duration_sec ? ' · ' + r.duration_sec + ' 秒' : ''}${r.schedule_id && slotName[r.schedule_id] ? ' · ' + esc(slotName[r.schedule_id]) : ''}</small>
        </span>
      </button>`).join('');
    $('voiceList').querySelectorAll('[data-url]').forEach((b) => {
      b.addEventListener('click', () => {
        const p = $('player');
        p.src = b.dataset.url;
        p.play().catch(() => toast('播放失败，请让子女重录', true));
      });
    });
  }

  /* ---------- 加载 ---------- */
  async function load() {
    try {
      const url = selectedElderId ? `/events/today?elder_id=${selectedElderId}` : '/events/today';
      const data = await api.get(url);
      current = data;

      const key = remindKey(data);
      const hasMed = data.schedule && (data.items || []).length;
      const eaten = key === finishedKey;

      $('greetLine').textContent = greetLine(data);
      $('subLine').textContent = subLine(data);
      renderNow(data);
      renderDots(data);
      renderWhoBar(data);
      renderVoices(data);

      const hint = $('doneHint');
      if (hint) hint.style.display = eaten ? 'block' : 'none';

      // 只有「新的一顿到点且进入窗口」才播报一次；首次打开静默入场
      if (hasMed && !eaten && data.inWindow !== false) {
        if (firstLoad) {
          announcedKey = key;
        } else if (key !== announcedKey) {
          announcedKey = key;
          announce(data);
        }
      }
      firstLoad = false;
    } catch (e) {
      $('subLine').textContent = '加载失败，请检查网络';
    }
  }

  /* ==================== 绑定 ==================== */
  $('btnBind').addEventListener('click', async () => {
    const code = $('bindCode').value.trim();
    if (!/^\d{6}$/.test(code)) return toast('请输入 6 位数字绑定码', true);

    try {
      // credentials:'include' 必须写：服务端要在响应里种 httpOnly Cookie（长期凭证），
      // 之后清理浏览器存储就靠它自动恢复
      const res = await fetch('/api/auth/device-bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code }),
      });
      const d = await res.json();
      if (!res.ok) return toast(d.error || '绑定失败', true);

      api.setToken(d.accessToken);
      toast('绑定成功');
      speak('绑定成功，现在可以正常使用了。');

      let info = null;
      try { info = await api.get('/auth/me'); } catch (e) { /* 拿不到身份也先可用 */ }
      await enterMain(info);
    } catch (e) {
      toast('网络异常，请重试', true);
    }
  });

  /* ==================== 我不舒服 ==================== */
  /* 不用原生 confirm：一来老人看不懂弹窗，二来部分 webview 会屏蔽；
     改成「按一下变成再按一下」的二次确认，误触 6 秒后自动复原。 */
  const sosBtn = $('btnSos');
  const sosBig = sosBtn.querySelector('.big');
  const sosHint = sosBtn.querySelector('.hint');
  let sosTimer = null;

  function sosReset() {
    if (sosTimer) { clearTimeout(sosTimer); sosTimer = null; }
    sosBtn.classList.remove('armed');
    sosBig.textContent = '我不舒服';
    sosHint.textContent = '按一下，马上通知子女';
  }

  sosBtn.addEventListener('click', async () => {
    if (!sosBtn.classList.contains('armed')) {
      sosBtn.classList.add('armed');
      sosBig.textContent = '再按一下';
      sosHint.textContent = '再按一下就通知子女';
      speak('再按一下，就会通知子女。');
      sosTimer = setTimeout(sosReset, 6000);
      return;
    }
    sosReset();
    try {
      await api.post('/sos', {
        elder_id: (current && current.elderId) || selectedElderId || undefined,
      });
      speak('已经通知子女，请坐下休息。');
      toast('子女已收到通知，请坐下休息');
    } catch (e) { /* 已提示 */ }
  });

  /* ==================== 启动：三级递进 ==================== */
  let started = false;

  // 第 1 级：本地设备令牌
  if (api.getToken() && api.tokenType() === 'device') {
    try {
      const info = await api.get('/auth/me');
      if (info && info.type === 'device') started = await enterMain(info);
      else api.clearToken();
    } catch (e) { /* 交给下一级 */ }
  } else if (api.getToken()) {
    api.clearToken(); // 存的不是设备令牌
  }

  // 第 2 级：靠 httpOnly Cookie 静默恢复
  if (!started && !api.getToken()) {
    const restored = await api.tryDeviceRefresh();
    if (restored) {
      try {
        const info = await api.get('/auth/me');
        if (info && info.type === 'device') {
          started = await enterMain(info);
          toast('已自动恢复登录');
        }
      } catch (e) { /* 恢复失败按未登录处理 */ }
    }
  }

  // 第 3 级：确实没绑定记录
  if (!started) {
    api.clearToken();
    showBind();
  }

  async function enterMain(info) {
    me = info;
    $('bindWrap').style.display = 'none';
    $('mainWrap').style.display = 'block';
    $('mainHead').style.display = 'flex';
    await load();
    // 15 秒轮询：子女改了计划、到点了都能很快反映到屏幕上
    setInterval(load, 15000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) load();
    });
    return true;
  }
})();
