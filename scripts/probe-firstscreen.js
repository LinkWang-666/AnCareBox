/**
 * 首屏 + 老人端绑定 · 全链路探针
 * -------------------------------------------------------------
 * 用途：页面「报红」时，先用这个脚本判断到底是后端坏了，还是浏览器里有脏令牌。
 *
 * 为什么有这个脚本：
 *   页面上的红色提示条来自 public/js/api.js —— 只要任意一个接口返回非 2xx，
 *   它就会 toast 一条红字。所以「报红」不等于程序崩溃，而是「某个接口报错了」。
 *   手工点页面看不到是哪个接口，这个脚本把首屏链路全打一遍，报错就现形。
 *
 * 为什么绑定码要从 README.md 里读：
 *   绑定码每次跑 seed-auth / init-db 都会重新签发（每个药箱只有一个有效码），
 *   写死在脚本里第二天就过期了，反而误导人。
 *
 * 用法：
 *   1. 先启动服务（双击根目录的 双击启动Web应用.bat）
 *   2. node scripts/probe-firstscreen.js
 *
 * 退出码：0 = 全链路正常；1 = 有异常
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3000);
const USER = process.argv[2] || 'wang_owner';
const PASS = process.argv[3] || 'medbox2026';

// 子女端 index.html 首屏实际调用顺序（与 public/js/child.js 的 loadAll() 一致）
const CHAIN = [
  ['GET', '/auth/me'],
  ['GET', '/elders'],
  ['GET', '/medicines'],
  ['GET', '/medbox'],
  ['GET', '/schedules'],
  ['GET', '/dashboard/__EID__?days=7'],
];

let token = '';

async function call(method, urlPath, body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await fetch(BASE + '/api' + urlPath, opt);
  let data;
  try { data = await res.json(); } catch (e) { data = {}; }
  return { status: res.status, data };
}

/** 从 README.md（3.4 节）的表格里抓出当前有效的绑定码 */
function readBindCodes() {
  const file = path.join(__dirname, '..', 'README.md');
  if (!fs.existsSync(file)) return [];
  const md = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /\|\s*(MB-[\w-]+)\s*\|\s*(\d{6})\s*\|/g;
  let m;
  while ((m = re.exec(md)) !== null) out.push({ box: m[1], code: m[2] });
  return out;
}

(async () => {
  console.log('=== 第 1 段：子女端首屏 ===\n');

  const lg = await call('POST', '/auth/login', { username: USER, password: PASS });
  if (lg.status !== 200) {
    console.log(`[FATAL] 登录就失败了 HTTP ${lg.status}`);
    console.log('       服务端返回：', JSON.stringify(lg.data));
    process.exitCode = 1;
    return;
  }
  token = lg.data.accessToken;
  const u = lg.data.user || {};
  console.log(`[ OK ] 登录成功  user=${u.username}  role=${u.role}\n`);

  const el = await call('GET', '/elders');
  let eid = '__EID__';
  if (el.status === 200 && Array.isArray(el.data) && el.data.length) {
    eid = el.data[0].id;
    console.log(`       老人 ${el.data.length} 位，取第一位 id=${eid}\n`);
  }

  let bad = 0;
  for (const [m, p] of CHAIN) {
    const urlPath = p.replace('__EID__', eid);
    const r = await call(m, urlPath);
    const ok = r.status >= 200 && r.status < 300;
    if (!ok) bad++;
    console.log(`  ${ok ? '[ OK ]' : '[FAIL]'} ${m.padEnd(4)} ${urlPath.padEnd(26)} HTTP ${r.status}`);
    if (!ok) console.log(`         -> ${JSON.stringify(r.data).slice(0, 200)}`);
  }

  console.log('\n=== 第 2 段：老人端绑定 ===\n');

  const codes = readBindCodes();
  if (!codes.length) {
    console.log('  [WARN] README.md 里没读到绑定码，跳过（跑一下 npm run seed-auth 会重新生成）');
  }

  for (const { box, code } of codes) {
    // 老人端没有账号密码，是拿绑定码换令牌，所以这里不带 Authorization
    token = '';
    const r = await call('POST', '/auth/device-bind', { code });
    if (r.status !== 200) {
      // 绑定码是【一次性的】：本脚本自己之前测过、或页面上刚绑定成功，
      // 都会让它作废。这属于预期行为，不能算故障，否则会误导排查方向。
      const usedUp = /无效或已过期/.test(r.data.error || '');
      if (usedUp) {
        console.log(`  [预期] ${box}  绑定码 ${code}  ->  已被用过（一次性，正常现象）`);
        console.log(`         要重测请在子女端「隔间管理 → 生成绑定码」，或重跑 npm run seed-auth`);
      } else {
        bad++;
        console.log(`  [FAIL] ${box}  绑定码 ${code}  ->  HTTP ${r.status}`);
        console.log(`         -> ${JSON.stringify(r.data).slice(0, 200)}`);
      }
      continue;
    }
    console.log(`  [ OK ] ${box}  绑定码 ${code}  ->  绑定成功，老人=${(r.data.elder || {}).name || '未知'}`);

    token = r.data.accessToken;
    const today = await call('GET', '/events/today');
    const okToday = today.status >= 200 && today.status < 300;
    if (!okToday) bad++;
    console.log(`  ${okToday ? '[ OK ]' : '[FAIL]'}         读取今日计划  HTTP ${today.status}`);
    if (!okToday) console.log(`         -> ${JSON.stringify(today.data).slice(0, 200)}`);
  }

  console.log('');
  if (bad === 0) {
    console.log('结论：全链路正常，页面不应该报红。');
    console.log('     如果浏览器里还是红字 —— 那是浏览器存了旧令牌，请重新登录一次。');
  } else {
    console.log(`结论：发现 ${bad} 处异常，上面标 [FAIL] 的就是页面报红的直接原因。`);
  }
  process.exitCode = bad === 0 ? 0 : 1;
})();
