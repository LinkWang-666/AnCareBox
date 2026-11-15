/**
 * 前端运行检测：用 CDP 真实加载子女端 / 老人端 / 手机端，
 * 收集 console 错误、未捕获异常、失败的网络请求，并检查关键区域是否渲染出内容。
 * 用法：node _audit/fe.js
 * 前置：Chrome 以 --remote-debugging-port=9222 启动；服务在 3000 端口。
 */
const fs = require('fs');
const path = require('path');

const APP = 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const target = await (await fetch('http://127.0.0.1:9222/json/new?' + encodeURIComponent('about:blank'), { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  let id = 0; const pend = new Map(); const events = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
    else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || '') };
    return r.result && r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const report = [];
  const PUSH = (page, errs) => report.push({ page, errs });

  function collectSince(mark) {
    const out = [];
    for (const ev of events.slice(mark)) {
      if (ev.method === 'Runtime.exceptionThrown') {
        const d = ev.params.exceptionDetails;
        out.push('异常: ' + (d.exception && d.exception.description || d.text));
      } else if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
        out.push('console.error: ' + ev.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
      } else if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
        const t = ev.params.entry;
        if (!/favicon/i.test(t.text || '')) out.push('日志: ' + (t.text || '').slice(0, 200) + ' ' + (t.url || ''));
      } else if (ev.method === 'Network.loadingFailed') {
        if (ev.params.errorText !== 'net::ERR_ABORTED') out.push('请求失败: ' + ev.params.errorText);
      }
    }
    return out;
  }

  // ---------- 子女端 ----------
  console.log('=== 子女端 index.html ===');
  await send('Page.navigate', { url: APP + '/login.html' });
  await sleep(900);
  const tok = await evaluate(`(async () => {
    const r = await fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({username:'wangxm', password:'medbox2026'})});
    const d = await r.json();
    if (d.accessToken) localStorage.setItem('mb_token', d.accessToken);
    return d.accessToken ? 'ok' : JSON.stringify(d);
  })()`);
  console.log('  登录：', tok);

  let mark = events.length;
  await send('Page.navigate', { url: APP + '/index.html' });
  await sleep(3500);
  let errs = collectSince(mark);
  const childState = await evaluate(`(() => {
    const pick = (id) => { const el = document.getElementById(id); return el ? (el.innerText || '').replace(/\\s+/g,' ').trim().slice(0,60) : '(无此元素)'; };
    return {
      title: document.title,
      ovDone: pick('ovDone'), ovRate: pick('ovRate'), nextDose: pick('nextDose'),
      toast: pick('toast'),
      cards: document.querySelectorAll('.card').length,
    };
  })()`);
  console.log('  页面状态：', JSON.stringify(childState));
  console.log('  错误数：', errs.length); errs.forEach((e) => console.log('    - ' + e));
  await send('Page.captureScreenshot', { format: 'png' }).then((s) =>
    fs.writeFileSync(path.join(__dirname, 'shot_index.png'), Buffer.from(s.data, 'base64')));
  PUSH('/index.html', errs);

  // ---------- 生成绑定码 → 换设备令牌 ----------
  const dev = await evaluate(`(async () => {
    const t = localStorage.getItem('mb_token');
    const h = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t };
    const boxes = await (await fetch('/api/medbox', { headers: h })).json();
    if (!boxes.length) return 'no medbox';
    const r = await (await fetch('/api/auth/bind-code', { method:'POST', headers:h, body: JSON.stringify({medbox_id: boxes[0].id}) })).json();
    const b = await (await fetch('/api/auth/device-bind', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({code: r.bindCode}) })).json();
    if (b.accessToken) { localStorage.setItem('mb_device_token', b.accessToken); return 'ok'; }
    return JSON.stringify(b);
  })()`);
  console.log('\n=== 老人端（设备令牌）===');
  console.log('  绑定：', dev);

  // ---------- 老人端 PC ----------
  mark = events.length;
  await send('Page.navigate', { url: APP + '/elder.html' });
  await sleep(3500);
  errs = collectSince(mark);
  const elderState = await evaluate(`(() => {
    const b = document.body.innerText.replace(/\\s+/g,' ').trim();
    return { title: document.title, len: b.length, head: b.slice(0, 120) };
  })()`);
  console.log('  页面：', JSON.stringify(elderState));
  console.log('  错误数：', errs.length); errs.forEach((e) => console.log('    - ' + e));
  await send('Page.captureScreenshot', { format: 'png' }).then((s) =>
    fs.writeFileSync(path.join(__dirname, 'shot_elder.png'), Buffer.from(s.data, 'base64')));
  PUSH('/elder.html', errs);

  // ---------- 手机端 ----------
  console.log('\n=== 手机端 /m/ ===');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  mark = events.length;
  await send('Page.navigate', { url: APP + '/m/index.html' });
  await sleep(3500);
  errs = collectSince(mark);
  const mState = await evaluate(`(() => {
    const b = document.body.innerText.replace(/\\s+/g,' ').trim();
    return { title: document.title, len: b.length, head: b.slice(0, 120) };
  })()`);
  console.log('  页面：', JSON.stringify(mState));
  console.log('  错误数：', errs.length); errs.forEach((e) => console.log('    - ' + e));
  await send('Page.captureScreenshot', { format: 'png' }).then((s) =>
    fs.writeFileSync(path.join(__dirname, 'shot_m.png'), Buffer.from(s.data, 'base64')));
  PUSH('/m/index.html', errs);

  mark = events.length;
  await send('Page.navigate', { url: APP + '/m/elder.html' });
  await sleep(3000);
  errs = collectSince(mark);
  const mElder = await evaluate(`(() => ({ title: document.title, len: document.body.innerText.replace(/\\s+/g,' ').trim().length }))()`);
  console.log('  /m/elder.html：', JSON.stringify(mElder), ' 错误数：', errs.length);
  errs.forEach((e) => console.log('    - ' + e));
  PUSH('/m/elder.html', errs);

  console.log('\n=== 汇总 ===');
  const total = report.reduce((a, r) => a + r.errs.length, 0);
  console.log(`共 ${total} 条前端错误`);
  ws.close();
  process.exit(0);
})().catch((e) => { console.error('脚本异常：', e); process.exit(2); });
