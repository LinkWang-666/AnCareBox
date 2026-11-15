/**
 * 老人端逻辑 —— 设计原则：零学习成本（对照 Ardot 设计稿第 3 页）
 *   1. 打开页面就告诉老人「现在该吃第几格」，大字 + 8 格网格高亮，不需要任何选择操作
 *   2. 有子女录音就放录音，没有就用浏览器语音合成兜底；播报文字同时显示在语音条上
 *   3. 只有三个可操作物：我吃好了（隐藏在任务卡内）/ 我不舒服 / 打卡圆点（只展示）
 *
 * 关于登录：
 *   老人不记密码，也不该有密码。首次打开输入子女给的 6 位绑定码，
 *   换回一张长期设备令牌（存在本地），之后自动生效。
 *   令牌与子女端分开存放（mb_device_token），同浏览器两边互不干扰。
 */
(async function () {
  'use strict';

  // 关键：老人端用独立的令牌键，避免和子女端互相顶掉
  api.setTokenKey('mb_device_token');

  const $ = (id) => document.getElementById(id);
  let current = null;
  let me = null;
  // 一箱多老人共用：当前使用者（null = 主老人）。切换后所有提醒状态重置。
  let selectedElderId = null;

  // ---------- 播报控制 ----------
  // 为什么需要这一组状态：
  //   load() 每 60 秒自动跑一次，如果每次都 announce()，
  //   老人就会被反反复复催着吃药，非常打扰。
  //   所以按「顿」来管理：同一顿只提醒一次；吃完就彻底安静；
  //   等下一顿（服务端返回另一条计划）到来了，才重新开始提醒。
  let announcedKey = null;   // 已经提醒过的那一顿
  let finishedKey = null;    // 已经按过「我吃好了」的那一顿
  let firstLoad = true;      // 刚打开页面不打扰，静默入场

  /** 当前这一顿的唯一标识（带上使用者 id：共用时不同老人的顿次互不干扰） */
  function remindKey(data) {
    if (!data || !data.schedule) return 'none';
    const s = data.schedule;
    return String(data.elderId || '') + '|' + String(s.id || '') + '|' + String(s.time_label || s.slot_no || '');
  }

  /** 立刻安静：同时停掉语音合成和子女录音 */
  function stopSound() {
    try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
    const p = $('player');
    if (p) { try { p.pause(); } catch (e) { /* 忽略 */ } }
  }

  /** 是否显示「我吃好了」按钮 */
  function showTake(on) {
    const b = $('btnTake');
    if (b) b.style.display = on ? '' : 'none';
  }

  /** 回到绑定页（令牌过期或被解绑时） */
  function showBind() {
    api.clearToken();
    $('mainWrap').style.display = 'none';
    $('mainHead').style.display = 'none';
    $('bindWrap').style.display = 'block';
  }
  api.setUnauthorizedHandler(showBind);

  /** 时钟 + 日期（对照设计稿右上角大时钟） */
  function tick() {
    const d = new Date();
    $('clock').textContent =
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const week = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
    $('dateLine').textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
  }
  tick();
  setInterval(tick, 10000);

  /** 浏览器语音合成兜底（无录音时使用） */
  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.85;   // 老人语速放慢
    u.volume = 1;
    window.speechSynthesis.speak(u);
  }

  /** 播报：优先子女录音，其次语音合成 */
  function announce(data) {
    if (data.recording && data.recording.audio_url) {
      const p = $('player');
      p.src = data.recording.audio_url;
      p.play().catch(() => speak(fallbackText(data)));
      return;
    }
    speak(fallbackText(data));
  }

  function fallbackText(data) {
    if (!data.schedule) return '现在不是服药时间，请注意休息。';
    const slot = data.schedule.slot_no ? `吃第 ${data.schedule.slot_no} 格的药。` : '';
    const meds = (data.items || []).map((i) => `${i.medicine_name} ${i.dose_qty}${i.unit}`).join('，');
    return `${slot}现在是${data.now}，该吃${data.schedule.time_label || ''}的药了。${meds}。请全部取出，用温水送服。`;
  }

  /** 问候语：李奶奶/李爷爷，早上好（按性别称呼） */
  function greetLine(data) {
    const name = data && data.elderName ? data.elderName.replace(/(\S)$/g, '$1') : '';
    const gender = data && data.gender;
    let call = name || '您好';
    if (name) call = name + (gender === 'male' ? '爷爷' : gender === 'female' ? '奶奶' : '');
    const hour = new Date().getHours();
    const hello = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
    return `${call}，${hello}`;
  }

  /** 渲染「吃第 N 格的药」主任务卡 + 8 格网格 + 语音条 */
  function renderNow(data) {
    const box = $('nowBox');
    const s = data.schedule;
    const slot = s ? s.slot_no : 0;
    const ready = data.inWindow !== false;   // 是否处于可服药窗口（后端判定）

    // 8 格网格：以计划绑定的格号为基础，至少画 8 格（设计稿是 8 格药箱）
    const cells = [];
    const total = Math.max(8, slot || 0);
    for (let i = 1; i <= total; i++) {
      const cls = i === slot ? ' now' : '';
      cells.push(`<div class="cell${cls}">${i}${i === slot ? '<small>请开这格</small>' : ''}</div>`);
    }

    if (s && (data.items || []).length) {
      const meds = data.items.map((i) => `${esc(i.medicine_name)} ${i.dose_qty}${esc(i.unit)}`).join(' · ');
      const pieces = data.items.reduce((a, i) => a + Number(i.dose_qty || 0), 0);
      const timeTxt = String(s.dose_time).slice(0, 5);
      const voiceTxt = data.recording
        ? `正在播放${esc(data.recording.dialect || '子女')}的录音提醒`
        : fallbackText(data);

      // 已到服药窗口：主任务态（吃第 N 格的药 + 我吃好了）
      // 未到窗口：下一顿预告态（不显示完成按钮，也不播报）
      box.style.display = 'block';
      box.innerHTML = `
        <div class="ecard">
          ${ready
            ? '<span class="enow-badge">&#128274; 现在该吃药了</span>'
            : `<span class="enow-badge" style="background:#8a857b">&#9200; 下一顿 ${timeTxt}</span>`}
          <div class="etitle">${ready ? `吃第 ${slot || '-'} 格的药` : `第 ${slot || '-'} 格 · ${timeTxt}`}</div>
          <div class="esub">${esc(s.time_label || '')}的药 · 共 ${pieces} ${esc((data.items[0] || {}).unit || '片')}</div>
          <div class="emeds">${meds}</div>
          <div class="egrid">${cells.join('')}</div>
          <div class="voice-line"><span class="spk">&#128266;</span><span>${ready ? voiceTxt : '到点了我会提醒您，请先歇一会儿。'}</span></div>
          ${ready ? `
          <button class="sos-card" id="btnTake" style="margin-top:24px;background:linear-gradient(180deg,#3e8e5a,#2e7d50);animation:none">
            <span class="big">&#10003; 我吃好了</span>
          </button>` : ''}
        </div>`;
      if (ready) bindTakeBtn();
    } else {
      box.style.display = 'none';
    }
  }

  /** 判定结果 → 中文（取值与 server/services/intake.js 的 result 一致） */
  const RESULT_TEXT = {
    on_time: '按时', early: '提前', late: '延迟',
    missed: '漏服', duplicate: '重复', abnormal: '异常', unknown: '未知',
  };

  /** 「我吃好了」按钮在任务卡内动态生成，每次渲染后要重新绑定 */
  function bindTakeBtn() {
    const b = $('btnTake');
    if (!b) return;
    b.addEventListener('click', async () => {
      try {
        // 不需要传 device_code：后端会从设备令牌里取，防止冒名上报
        const r = await api.post('/events', {
          slot_no: current && current.schedule && current.schedule.slot_no
            ? current.schedule.slot_no : 1,
          event_type: 'take',
          dose_qty: 1,
          source: 'manual',
        });
        stopSound();
        const result = (r.event && r.event.result) || 'on_time';
        // 判定结果直接决定说什么：判成重复取药时必须播报拦截话术，
        // 不能一律说「祝您健康」——那等于默许老人把第二遍药吃下去。
        if (result === 'duplicate') {
          speak('这个药已经吃过了，请不要重复服用。');
          toast('这个药已经吃过了，请不要重复服用', true);
        } else if (result === 'abnormal') {
          speak('现在不是这个药的服用时间，请先休息。');
          toast('不在服药时段，已记录', true);
        } else {
          finishedKey = remindKey(current);
          speak('已经记录，祝您健康。');
          toast('已记录：' + RESULT_TEXT[result]);
        }
        await load();
      } catch (e) { /* 已 toast */ }
    });
  }

  /** 今日打卡：早/中/晚圆点（按全天计划的时段标签） */
  function renderDots(data) {
    const slots = data.daySlots || [];
    const doneIds = data.doneSlotIds || [];
    const currentId = data.schedule ? data.schedule.id : null;
    if (!slots.length) {
      $('dayDots').innerHTML = '<span style="font-size:24px;color:#8a857b">今天没有安排</span>';
      return;
    }
    $('dayDots').innerHTML = slots.map((s) => {
      const done = doneIds.includes(Number(s.id));
      const now = currentId === Number(s.id) && !done;
      return `
        <div class="slot ${done ? 'done' : ''}${now ? ' now' : ''}">
          <i></i>${esc(s.time_label || String(s.dose_time).slice(0, 5))}
        </div>`;
    }).join('');
  }

  /** 共用模式的使用者切换条：关联老人 >1 时显示 */
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
        // 换人了：提醒状态全部重置，新使用者静默入场
        announcedKey = null;
        finishedKey = null;
        firstLoad = true;
        stopSound();
        speak('好的，现在查看另一位老人的用药。');
        load();
      });
    });
  }

  /** 加载并渲染今日状态（老人身份由令牌决定，不靠 URL 参数） */
  async function load() {
    try {
      const url = selectedElderId ? `/events/today?elder_id=${selectedElderId}` : '/events/today';
      const data = await api.get(url);
      current = data;

      const key = remindKey(data);
      const hasMed = data.schedule && (data.items || []).length;
      const eaten = key === finishedKey; // 这一顿已经按下过「我吃好了」

      $('greetLine').textContent = greetLine(data);
      renderNow(data);
      renderDots(data);
      renderWhoBar(data);

      // 吃完之后：换成「已经吃好了」区块。
      // 「我不舒服」是求救通道，任何时候都必须留在页面上，不能被收起。
      const hint = $('doneHint');
      if (hint) hint.style.display = eaten ? 'block' : 'none';

      // ---------- 播报时机 ----------
      // 只有「新的一顿到来了且已进入服药窗口」才提醒一次；首次打开页面保持安静。
      if (hasMed && !eaten && data.inWindow !== false) {
        if (firstLoad) {
          announcedKey = key;        // 静默入场：记下来，当作已经提醒过
        } else if (key !== announcedKey) {
          announcedKey = key;
          announce(data);            // 下一顿到点了，才播报
        }
      }
      firstLoad = false;
    } catch (e) {
      $('dayDots').innerHTML = '<span style="font-size:24px;color:#c0563f">加载失败，请检查网络</span>';
    }
  }

  // ==================== 绑定 ====================
  $('btnBind').addEventListener('click', async () => {
    const code = $('bindCode').value.trim();
    if (!/^\d{6}$/.test(code)) return toast('请输入 6 位数字绑定码', true);

    try {
      // credentials: 'include' 必须写。
      // 服务端除了发令牌，还要在响应里种一张 httpOnly  Cookie（长期凭证），
      // 之后清理浏览器存储就靠它自动恢复 —— 少了这一行，浏览器不会把它存下来。
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

      // 复用统一的入场函数：它内部已经包含了轮询，避免重复启动多个定时器
      let info = null;
      try { info = await api.get('/auth/me'); } catch (e) { /* 拿不到身份也先让页面可用 */ }
      await enterMain(info);
    } catch (e) {
      toast('网络异常，请重试', true);
    }
  });

  // ==================== 我不舒服 ====================
  $('btnSos').addEventListener('click', async () => {
    if (!confirm('确定要通知子女吗？')) return;
    try {
      // 一箱多老人：带上当前使用者是谁，子女端才知道求救的是哪一位
      await api.post('/sos', {
        elder_id: (current && current.elderId) || selectedElderId || undefined,
      });
      speak('已经通知子女，请坐下休息。');
      toast('子女已收到通知，请坐下休息');
    } catch (e) { /* 已 toast */ }
  });

  // ==================== 启动 ====================
  // 三级递进，目的是尽量不让老人动手：
  //   第 1 级：本地有设备令牌 → 直接用，联网确认一次身份
  //   第 2 级：本地没有（清过浏览器数据），但浏览器里那张长期凭证 Cookie 还在
  //           → 静默换回一张新令牌，老人全程无感知
  //   第 3 级：都没有 → 才要求输入绑定码
  let started = false;

  // ---- 第 1 级：本地令牌可用 ----
  if (api.getToken() && api.tokenType() === 'device') {
    try {
      const info = await api.get('/auth/me');
      if (info && info.type === 'device') {
        started = await enterMain(info);
      } else {
        api.clearToken(); // 身份不对，清掉后走第 2 级
      }
    } catch (e) { /* 令牌可能已失效，交给下一级尝试恢复 */ }
  } else if (api.getToken()) {
    // 存的不是设备令牌（多半是子女端串过来的），清掉再试
    api.clearToken();
  }

  // ---- 第 2 级：靠 Cookie 静默恢复 ----
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

  // ---- 第 3 级：确实没有绑定记录，回到绑定页 ----
  if (!started) {
    api.clearToken();
    showBind();
  }

  /** 进入主界面并开始轮询（抽出来给上面三级复用） */
  async function enterMain(info) {
    me = info;
    $('bindWrap').style.display = 'none';
    $('mainWrap').style.display = 'block';
    $('mainHead').style.display = 'flex';
    await load();
    // 15 秒轮询一次：比以前的 60 秒更快，子女改了计划、到点了都很快反映到屏幕上。
    // 为什么不用 WebSocket/SSE：见子女端 liveTick 的注释 —— 无依赖、够实时、好维护。
    setInterval(load, 15000);
    // 平板从休眠/后台切回来时立刻刷新，不让老人对着旧信息等十几秒
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) load();
    });
    return true;
  }
})();
