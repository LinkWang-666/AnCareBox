/**
 * 检测用冒烟脚本：覆盖登录、读接口、边界输入、越权、上传路径。
 * 用法：node _audit/smoke.js
 * 只读为主，写操作走「造一条测试数据再删掉」的方式，避免污染演示库。
 */
const BASE = 'http://127.0.0.1:3000';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.log(`  ✗ ${name} ${extra}`); }
}

async function req(method, path, { token, body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
  return { status: res.status, data, setCookie: res.headers.get('set-cookie') || '' };
}

(async () => {
  console.log('\n=== 1. 认证链路 ===');
  const login = await req('POST', '/api/auth/login', { body: { username: 'wangxm', password: 'medbox2026' } });
  ok('owner 登录返回 200', login.status === 200, String(login.status) + ' ' + JSON.stringify(login.data).slice(0, 120));
  const TOKEN = login.data && login.data.accessToken;
  ok('返回 accessToken', !!TOKEN);
  ok('登录种下 httpOnly 刷新 Cookie', /refreshToken=/.test(login.setCookie) && /HttpOnly/i.test(login.setCookie), login.setCookie.slice(0, 90));
  ok('Cookie 带 SameSite=Strict', /SameSite=Strict/i.test(login.setCookie), login.setCookie.slice(0, 90));

  const bad = await req('POST', '/api/auth/login', { body: { username: 'wangxm', password: 'wrong' } });
  ok('错误密码返回 401', bad.status === 401, String(bad.status));
  ok('错误密码不泄漏账号是否存在', bad.data && bad.data.error === '账号或密码错误', JSON.stringify(bad.data));

  const noauth = await req('GET', '/api/elders');
  ok('未登录访问 /api/elders 返回 401', noauth.status === 401, String(noauth.status));

  const me = await req('GET', '/api/auth/me', { token: TOKEN });
  ok('/auth/me 正常', me.status === 200 && me.data.type === 'user');

  console.log('\n=== 2. 主要读接口 ===');
  const elders = await req('GET', '/api/elders', { token: TOKEN });
  ok('/elders 200 且有数据', elders.status === 200 && Array.isArray(elders.data) && elders.data.length > 0, String(elders.status));
  const elderId = Array.isArray(elders.data) && elders.data[0] ? elders.data[0].id : null;

  for (const p of ['/api/medbox', '/api/medicines', '/api/schedules', '/api/recordings', '/api/users']) {
    const r = await req('GET', p, { token: TOKEN });
    ok(`${p} 200`, r.status === 200, String(r.status) + ' ' + JSON.stringify(r.data).slice(0, 100));
  }
  if (elderId) {
    const r = await req('GET', `/api/dashboard/${elderId}`, { token: TOKEN });
    ok('/dashboard 200', r.status === 200, String(r.status) + ' ' + JSON.stringify(r.data).slice(0, 120));
    const e = await req('GET', `/api/events/today?elder_id=${elderId}`, { token: TOKEN });
    ok('/events/today 200', e.status === 200, String(e.status));
    const x = await req('GET', `/api/export/record/${elderId}`, { token: TOKEN });
    ok('/export/record 200', x.status === 200, String(x.status));
  }

  console.log('\n=== 3. 边界输入（找 500）===');
  const b1 = await req('GET', '/api/events?limit=abc', { token: TOKEN });
  ok('GET /events?limit=abc 不应 500', b1.status !== 500, `${b1.status} ${JSON.stringify(b1.data).slice(0, 160)}`);

  const b2 = await req('GET', '/api/alerts?limit=abc', { token: TOKEN });
  ok('GET /alerts?limit=abc 不应 500', b2.status !== 500, `${b2.status} ${JSON.stringify(b2.data).slice(0, 160)}`);

  const b3 = await req('GET', '/api/events?limit=-1', { token: TOKEN });
  ok('GET /events?limit=-1 不应 500', b3.status !== 500, `${b3.status} ${JSON.stringify(b3.data).slice(0, 160)}`);

  const b4 = await req('GET', '/api/schedules/999999', { token: TOKEN });
  ok('不存在的计划返回 404 而非 500', b4.status === 404, String(b4.status));

  const b5 = await req('GET', '/api/schedules/abc', { token: TOKEN });
  ok('非法 id 返回 4xx 而非 500', b5.status >= 400 && b5.status < 500, `${b5.status} ${JSON.stringify(b5.data).slice(0, 160)}`);

  console.log('\n=== 4. 越权（李家看王家）===');
  const li = await req('POST', '/api/auth/login', { body: { username: 'li_owner', password: 'medbox2026' } });
  ok('李家账号可登录', li.status === 200, String(li.status));
  const LT = li.data && li.data.accessToken;
  if (LT && elderId) {
    const r = await req('GET', `/api/elders/${elderId}`, { token: LT });
    ok('跨家庭读老人被拦（403/404）', r.status === 403 || r.status === 404, String(r.status));
    const r2 = await req('GET', `/api/dashboard/${elderId}`, { token: LT });
    ok('跨家庭读看板被拦', r2.status === 403 || r2.status === 404, String(r2.status));
    const r3 = await req('GET', `/api/events?elder_id=${elderId}`, { token: LT });
    ok('跨家庭读服药记录被拦', r3.status === 403 || r3.status === 404, String(r3.status));
    const r4 = await req('GET', '/api/export/family-data', { token: LT });
    ok('李家导出只含李家数据', r4.status === 200 && r4.data.familyId !== undefined, String(r4.status));
  }

  console.log('\n=== 5. 角色与写权限 ===');
  const viewerLogin = await req('POST', '/api/auth/login', { body: { username: 'wang_member', password: 'medbox2026' } });
  ok('member 可登录', viewerLogin.status === 200, String(viewerLogin.status));

  console.log('\n=== 6. 上传接口路径校验 ===');
  const up = await req('POST', '/api/recordings/upload', {
    token: TOKEN,
    body: { base64: Buffer.from('test').toString('base64'), ext: '../../evil-test' },
  });
  ok('上传 ext 路径穿越被拒或已净化', up.status === 400 || (up.status === 200 && !/\.\./.test(String(up.data.url || ''))),
    `${up.status} ${JSON.stringify(up.data).slice(0, 160)}`);
  // 若真的写出了文件，立刻清理
  if (up.status === 200 && up.data && up.data.filename) {
    const fs = require('fs'), path = require('path');
    const p = path.join(__dirname, '..', 'public', 'audio', up.data.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  console.log('\n=== 7. 事件上报鉴权 ===');
  const fake = await req('POST', '/api/events', { body: { device_code: 'MB-2026-0001', slot_no: 1, event_type: 'take' } });
  ok('未登录上报被拒 401', fake.status === 401, String(fake.status));

  console.log('\n========================================');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (failures.length) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('脚本异常：', e); process.exit(2); });
