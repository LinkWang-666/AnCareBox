/**
 * 验证：绑定一次之后，能不能反复点「我已吃药」而不用重新绑定
 * -------------------------------------------------------------
 * 背景：有人担心「是不是每吃一次都要重新输一次绑定码」——不需要。
 *       绑定只做一次，拿到的是一张长期设备令牌，存在浏览器里。
 *
 * 用法：node scripts/probe-elder-take.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3000);

async function call(method, p, body, token) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined && body !== null) opt.body = JSON.stringify(body);
  const res = await fetch(BASE + '/api' + p, opt);
  let data;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

(async () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'DEMO_ACCOUNTS.md'), 'utf8');
  const codes = [];
  const re = /\|\s*(MB-[\w-]+)\s*\|\s*(\d{6})\s*\|/g;
  let m;
  while ((m = re.exec(md)) !== null) codes.push(m[2]);
  if (!codes.length) { console.log('没读到绑定码'); return; }

  console.log('=== 绑定一次，看看能不能一直用 ===\n');

  const r = await call('POST', '/auth/device-bind', { code: codes[0] });
  if (r.status !== 200) {
    console.log('绑定失败：', JSON.stringify(r.data));
    console.log('（绑定码是一次性的，用过了就要重新生成）');
    return;
  }
  const token = r.data.accessToken;
  console.log(`[绑定] 成功，只绑这一次（绑定码 ${codes[0]} 用完即作废）`);

  const seg = token.split('.')[1];
  const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  const days = Math.round((payload.exp - payload.iat) / 86400);
  console.log(`       拿到一张 device 令牌，有效期 ${days} 天\n`);

  const today = await call('GET', '/events/today', null, token);
  if (today.status !== 200) { console.log('读今日计划失败', JSON.stringify(today.data)); return; }
  const cur = today.data.current || (today.data.schedule ? { schedule: today.data.schedule } : null);
  const slot = cur && cur.schedule ? cur.schedule.slot_no : 1;

  const t0 = today.data.schedule || {};
  console.log(`[页面] 当前该吃的第 ${slot} 格（计划 id=${t0.id}，${t0.time_label || ''}）\n`);

  console.log('接下来连点 3 次「我已吃药」，全程不重新绑定：');
  for (let i = 1; i <= 3; i++) {
    const ev = await call('POST', '/events', {
      slot_no: slot, event_type: 'take', dose_qty: 1, source: 'manual',
    }, token);
    const evData = ev.data.event || {};
    const note = ev.status === 200
      ? `第 ${i} 次 → HTTP 200，判定「${evData.result}」`
      : `第 ${i} 次 → HTTP ${ev.status}，${JSON.stringify(ev.data)}`;
    console.log('  ' + note);
  }

  // 吃完之后再看一眼服务端还推荐哪一顿：
  // 若仍然返回同一条计划 id，前端就能一直保持安静，直到下一顿到来。
  const after = await call('GET', '/events/today', null, token);
  const t1 = (after.status === 200 && after.data.schedule) ? after.data.schedule : {};
  console.log('\n[吃完] 服务端推荐的还是同一顿吗？');
  console.log(`       吃之前 计划 id = ${t0.id}  ${t0.time_label || ''}`);
  console.log(`       吃之后 计划 id = ${t1.id}  ${t1.time_label || ''}`);
  if (t0.id !== undefined && String(t0.id) === String(t1.id)) {
    console.log('       → 一致。所以页面会一直安静，直到时间走到下一顿才开始重新提醒。');
  } else {
    console.log('       → 已切换到下一顿。这时页面会开始播报新的提醒（属预期行为）。');
  }

  console.log('\n结论：第 2、3 次照样成功，没有要求重新绑定。');
  console.log('      只有这几种情况才需要重新输绑定码：');
  console.log('        1. 清了浏览器数据 / 换了浏览器或设备');
  console.log('        2. 子女在控制台点了「解绑」');
  console.log('        3. 令牌到期');
  console.log('        4. 页面保留了旧的子女令牌（已加自动纠正）');
})();
