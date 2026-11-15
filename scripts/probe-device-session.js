/**
 * 端到端验证：设备令牌的服务端持久化与「清了浏览器也能自愈」
 *
 * 模拟的真实场景：
 *   老人在家清理了浏览器数据 -> localStorage 里的令牌没了
 *   以前：直接失联，必须等子女来重新生成绑定码
 *   现在：凭 httpOnly Cookie 自动换回令牌，老人毫无察觉
 *
 * 用法：先确保服务在跑，然后 node scripts/probe-device-session.js
 */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const DEMO = path.join(__dirname, '..', 'DEMO_ACCOUNTS.md');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
}

// 这个文件模拟「浏览器」：设备令牌存这里，清空它就等于老人清了浏览器数据
let localStorage = {};
let deviceCookie = '';   // httpOnly Cookie，浏览器替我们保管，JS 碰不到
let lastCookieHeader = ''; // 完整的 Set-Cookie 原串，用来核对 HttpOnly 标记

function grabCookie(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    if (c.startsWith('deviceRefresh=')) {
      deviceCookie = c.split(';')[0];
      lastCookieHeader = c;
    }
  }
}

async function call(method, apiPath, body, token, withCookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (withCookie && deviceCookie) headers['Cookie'] = deviceCookie;
  const opt = { method, headers };
  // 注意：body 用 undefined 表示「不带请求体」。
  // 传 null 会被序列化成字符串 "null"，服务端 express.json() 解析失败 —— 这个坑踩过一次。
  if (body !== undefined && method !== 'GET') opt.body = JSON.stringify(body);
  const res = await fetch(BASE + '/api' + apiPath, opt);
  grabCookie(res);
  const raw = await res.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = { _raw: raw.slice(0, 200) }; }
  return { status: res.status, data };
}

(async function main() {
  console.log('==================================================');
  console.log('  设备会话持久化 · 端到端验证');
  console.log('==================================================');

  // ---------- 0. 前置：签发一份干净的绑定码 ----------
  // 绑定码是一次性的，脚本失败时会提前 return、来不及走末尾的恢复步骤，
  // 下一轮再跑就会拿着已经作废的码去绑定，白折腾一轮。这里先自签一份。
  console.log('0. 签发新鲜绑定码');
  {
    const { spawnSync } = require('child_process');
    const seed = spawnSync(process.execPath, [path.join(__dirname, 'seed-auth.js')], { stdio: 'pipe' });
    if (seed.status !== 0) {
      console.log('  seed-auth 执行失败：' + String(seed.stderr).slice(0, 200));
      return;
    }
  }

  let code = null;
  const md = fs.readFileSync(DEMO, 'utf8');
  const m = md.match(/\|\s*(MB-2026-\d+)\s*\|\s*(\d{6})\s*\|/);
  if (m) code = m[2];
  if (!code) { console.log('  读不到绑定码，请检查 DEMO_ACCOUNTS.md'); return; }
  const boxCode = m[1];
  console.log(`  药箱 ${boxCode}，绑定码 ${code}\n`);

  const lg = await call('POST', '/auth/login', { username: 'wang_owner', password: 'medbox2026' });
  if (lg.status !== 200) {
    console.log('  子女端登录失败，请确认账号密码与服务状态');
    console.log('  ' + JSON.stringify(lg.data));
    return;
  }
  const parentToken = lg.data.accessToken;
  console.log('1. 子女端登录');
  ok('登录成功并取得令牌', lg.status === 200 && !!parentToken);

  // ---------- 1. 绑定，检查服务端有没有种 Cookie ----------
  console.log('\n2. 老人端输入绑定码');
  deviceCookie = '';
  const bind = await call('POST', '/auth/device-bind', { code }, null, false);
  ok('绑定成功', bind.status === 200, JSON.stringify(bind.data));
  if (bind.status !== 200) return;

  const token = bind.data.accessToken;
  localStorage['mb_device_token'] = token;   // 模拟浏览器把令牌存起来

  const jti = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).jti;
  ok('令牌带 jti（可被服务端精确吊销）', !!jti, String(jti));
  ok('服务端种下了凭证 Cookie', !!deviceCookie, deviceCookie ? deviceCookie.slice(0, 26) + '...' : '没有收到');
  ok('Cookie 带 HttpOnly 标记（XSS 偷不走）', /HttpOnly/i.test(lastCookieHeader), lastCookieHeader);
  ok('Cookie 带 SameSite=Strict', /SameSite=Strict/i.test(lastCookieHeader), lastCookieHeader);

  // 直接查库，确认会话确实落到了服务端
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  });
  const [[row]] = await conn.query('SELECT * FROM device_session WHERE token_jti = ?', [jti]);
  ok('服务端已持久化这条会话', !!row);
  if (row) {
    ok('会话未过期（expires_at 在未来）', new Date(row.expires_at) > new Date(), String(row.expires_at));
  }

  // ---------- 2. 绑定后能正常用 ----------
  console.log('\n3. 正常使用（清理之前）');
  const ev1 = await call('POST', '/events', { slot_no: 1, event_type: 'take', dose_qty: 1, source: 'manual' }, token);
  ok('上报「我已吃药」成功', ev1.status === 200, JSON.stringify(ev1.data));

  // ---------- 3. 关键一步：清空浏览器数据 ----------
  console.log('\n4. 模拟用户清理浏览器数据');
  localStorage = {};                                  // localStorage 全没了
  ok('localStorage 已被清空', !localStorage['mb_device_token']);
  ok('但 httpOnly Cookie 还在（浏览器清 localStorage 不连带删 Cookie）', !!deviceCookie);

  // 没有令牌直接调业务接口，应当被拒
  const evNo = await call('POST', '/events', { slot_no: 1, event_type: 'take', dose_qty: 1, source: 'manual' }, null, true);
  ok('没有令牌时业务接口确实拒绝访问', evNo.status === 401, String(evNo.status));

  // ---------- 4. 静默恢复 ----------
  console.log('\n5. 页面自动用 Cookie 换回令牌（老人无感知）');
  const ref = await call('POST', '/auth/device-refresh', undefined, null, true);
  ok('静默恢复成功', ref.status === 200,
    `HTTP ${ref.status} ${JSON.stringify(ref.data)}  Cookie=${deviceCookie ? deviceCookie.slice(0, 24) + '...' : '无'}`);
  if (ref.status === 200) {
    const newToken = ref.data.accessToken;
    const newJti = JSON.parse(Buffer.from(newToken.split('.')[1], 'base64url').toString()).jti;
    ok('恢复后仍是同一个会话（未重复插数据）', newJti === jti, `${jti} -> ${newJti}`);

    const ev2 = await call('POST', '/events', { slot_no: 1, event_type: 'take', dose_qty: 1, source: 'manual' }, newToken);
    ok('恢复后的令牌能正常上报吃药', ev2.status === 200, JSON.stringify(ev2.data));

    // 服务端应已更新最后在线时间
    const [[row2]] = await conn.query('SELECT * FROM device_session WHERE token_jti = ?', [jti]);
    ok('最后在线时间已记录（可用于离线告警）', !!row2.last_seen_at, String(row2.last_seen_at));
  }

  // ---------- 5. 子女查看在线设备 ----------
  console.log('\n6. 子女端查看绑定了哪些设备');
  const [[ids]] = await conn.query('SELECT id FROM medbox WHERE device_code = ?', [boxCode]);
  const sess = await call('GET', `/auth/device-sessions?medbox_id=${ids.id}`, null, parentToken, false);
  ok('能查到设备会话列表', sess.status === 200 && (sess.data.sessions || []).length > 0,
    JSON.stringify(sess.data).slice(0, 150));

  // ---------- 6. 解绑后必须彻底失效 ----------
  console.log('\n7. 子女端解绑药箱');
  const unbind = await call('POST', '/auth/device-unbind', { medbox_id: ids.id }, parentToken, false);
  ok('解绑成功', unbind.status === 200, JSON.stringify(unbind.data));
  if (unbind.status === 200) {
    const after = await call('POST', '/auth/device-refresh', undefined, null, true);
    ok('解绑后再想靠 Cookie 恢复 → 被拒绝', after.status === 401, `${after.status} ${JSON.stringify(after.data)}`);

    const [[row3]] = await conn.query('SELECT * FROM device_session WHERE token_jti = ?', [jti]);
    ok('会话记录已被标记吊销', !!row3 && !!row3.revoked_at, row3 && row3.revoke_reason);

    const old = await call('POST', '/events', { slot_no: 1, event_type: 'take', dose_qty: 1, source: 'manual' },
      ref.data.accessToken);
    ok('旧令牌同样立即失效', old.status === 401, String(old.status));
  }

  await conn.end();

  // ---------- 收尾：重签绑定码，恢复演示环境 ----------
  console.log('\n8. 恢复演示环境');
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'seed-auth.js')], { stdio: 'pipe' });
  ok('已重新签发绑定码', r.status === 0, String(r.stderr).slice(0, 120));

  console.log('--------------------------------------------------');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('==================================================');
  process.exitCode = fail ? 1 : 0;
})();
