/**
 * 设备模拟器 —— 比赛演示用
 *
 * 作用：在没有实体药箱的情况下，产生真实的开箱 / 取药 / 漏服 / 重复取药事件流，
 *      让评委看到系统确实是「活」的。
 *
 * 用法：
 *   npm run sim              每 20 秒产生一条事件（持续运行，Ctrl+C 停止）
 *   npm run sim -- --once    只产生一条按时取药
 *   npm run sim -- --miss    只产生一条漏服
 *   npm run sim -- --dup     只产生一条重复取药
 *
 * 鉴权：服务已开启 JWT，模拟器需要先登录拿令牌再上报。
 *      默认使用演示账号，可用环境变量覆盖：
 *        SIM_USERNAME=wang_owner  SIM_PASSWORD=medbox2026  npm run sim
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const INTERVAL_MS = Number(process.env.SIM_INTERVAL || 20000);

const SIM_USER = process.env.SIM_USERNAME || 'wang_owner';
const SIM_PASS = process.env.SIM_PASSWORD || 'medbox2026';

let token = '';

/** 登录拿访问令牌 */
async function login() {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: SIM_USER, password: SIM_PASS }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`登录失败：${d.error || r.status}\n` +
      `  当前使用的账号是 ${SIM_USER}。若账号密码已改，请用环境变量指定：\n` +
      `  SIM_USERNAME=xxx SIM_PASSWORD=yyy npm run sim`);
  }
  token = d.accessToken;
  console.log(`已登录：${d.user.realName || d.user.username}（${d.user.role}）`);
}

function authHeaders() {
  return token ? { Authorization: 'Bearer ' + token } : {};
}

async function get(path) {
  const r = await fetch(BASE + path, { headers: authHeaders() });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${p} -> ${r.status}`);
  return data;
}

/** 产生一条事件 */
async function emit(kind) {
  const boxes = await get('/api/medbox');
  if (!boxes.length) throw new Error('还没有药箱，请先在子女端创建');
  const box = boxes[0];
  if (!box.elder_id) throw new Error('药箱未绑定老人');

  const schedules = await get('/api/schedules?elder_id=' + box.elder_id);
  if (!schedules.length) throw new Error('该老人还没有服药计划');

  const sch = schedules[Math.floor(Math.random() * schedules.length)];
  const slot = sch.slot_no || 1;

  const scenarios = {
    take: { event_type: 'take', dose_qty: 1 },
    miss: { event_type: 'timeout' },
    dup: { event_type: 'duplicate_refused' },
    abnormal: { event_type: 'wrong_time_refused' },
  };

  const pick = kind || ['take', 'take', 'take', 'miss', 'dup'][Math.floor(Math.random() * 5)];
  const payload = { device_code: box.device_code, slot_no: slot, source: 'simulator', ...scenarios[pick] };

  const out = await post('/api/events', payload);
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${t}] ${pick.padEnd(8)} 隔间第${slot}格 -> ${out.event.result}` +
    (out.alert ? `  | 已推送告警：${out.alert.content}` : ''));
  return out;
}

(async function main() {
  const once = args.includes('--once') || args.includes('--miss') || args.includes('--dup');
  const kind = args.includes('--miss') ? 'miss'
    : args.includes('--dup') ? 'dup'
      : args.includes('--once') ? 'take' : null;

  try {
    await get('/api/health');
  } catch (e) {
    console.error('无法连接服务，请先运行 npm start。' + e.message);
    process.exit(1);
  }

  try {
    await login();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (once) {
    await emit(kind);
    return;
  }

  console.log(`设备模拟器已启动，每 ${INTERVAL_MS / 1000} 秒产生一条事件。Ctrl+C 停止。`);
  await emit('take');
  setInterval(async () => {
    try { await emit(); } catch (e) { console.error('产生事件失败：', e.message); }
  }, INTERVAL_MS);
})();
