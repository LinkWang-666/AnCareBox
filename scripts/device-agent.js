/**
 * 药箱设备替身（device agent）—— 实物还没接电脑时，用它替真机跑一遍完整对接流程
 *
 * 它做的事和固件一模一样：
 *   子女端生成绑定码 → 设备换令牌 → 握手 → 心跳 → 拉任务 → 拉配置 →
 *   上报格位状态 → 上报事件（单条 + 离线批量补传）→ 取指令并回执 →
 *   报故障 → 查固件 → 取录音 → 按 SOS
 *
 * 用法：
 *   npm run device                 走一遍完整流程（每项都打勾，有断言）
 *   npm run device -- --loop       常驻，每 30 秒一次心跳（模拟待机中的真机）
 *   npm run device -- --sos        额外触发一次 SOS 求助（会在告警中心留一条紧急告警）
 *   npm run device -- --verbose    打印每个接口的完整响应报文
 *
 * 换账号：USER_NAME=xxx USER_PASS=yyy npm run device
 *
 * 设计说明：
 *   一个「真机替身」比一堆文档更能证明接口是通的 —— 它跑不过，说明接口有问题。
 *   所以这个脚本里每一步都有断言，任何一项不符合预期都会以非 0 退出码结束。
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const USER_NAME = process.env.USER_NAME || process.env.SIM_USERNAME || 'wang_owner';
const USER_PASS = process.env.USER_PASS || process.env.SIM_PASSWORD || 'medbox2026';
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_INTERVAL || 30000);

const args = process.argv.slice(2);
const OPT = {
  loop: args.includes('--loop'),
  sos: args.includes('--sos'),
  verbose: args.includes('--verbose'),
};

let pass = 0;
let fail = 0;

function ok(name, detail) {
  pass++;
  console.log(`  ✓ ${name}${detail ? '：' + detail : ''}`);
}
function bad(name, detail) {
  fail++;
  console.log(`  ✗ ${name}${detail ? '：' + detail : ''}`);
}
function check(cond, name, detail) {
  if (cond) ok(name, detail); else bad(name, detail);
  return cond;
}
function group(title) {
  console.log(`\n=== ${title} ===`);
}

// ==================== HTTP ====================
let token = '';          // 当前使用的令牌（会在子女令牌与设备令牌之间切换）
let deviceToken = '';    // 设备令牌，绑定后长期保存
let configVersion = '';  // 最近一次拿到的配置指纹，心跳时上报给云端比对

async function call(method, p, body, useToken = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (useToken && token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { data = null; }
  if (OPT.verbose) {
    console.log(`    → ${method} ${p} ${r.status}`);
    console.log('      ' + JSON.stringify(data).slice(0, 900));
  }
  return { status: r.status, ok: r.ok, data };
}

// ==================== 流程 ====================
async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  console.log('==================================================');
  console.log('  药箱设备替身 · 完整对接流程');
  console.log(`  服务地址：${BASE}`);
  console.log('==================================================');

  // ---- 0. 子女端：登录并生成绑定码 ----
  group('0. 子女端生成绑定码（真机上由老人/药箱屏幕输入）');
  let r = await call('POST', '/api/auth/login', { username: USER_NAME, password: USER_PASS }, false);
  if (!r.ok) {
    bad('子女端登录', r.data && r.data.error);
    console.log('\n请确认服务已启动、演示账号密码正确（见 DEMO_ACCOUNTS.md）');
    process.exit(1);
  }
  const userToken = r.data.accessToken;
  ok('子女端登录', USER_NAME);

  token = userToken;
  r = await call('GET', '/api/medbox');
  const boxes = Array.isArray(r.data) ? r.data : [];
  if (!boxes.length) {
    bad('读取药箱列表', '没有药箱，请先在子女端创建一台');
    process.exit(1);
  }
  const box = boxes[0];
  ok('读取药箱列表', `${boxes.length} 台，使用 ${box.device_code}（id=${box.id}）`);

  r = await call('POST', '/api/auth/bind-code', { medbox_id: box.id });
  if (!check(r.ok && r.data.bindCode, '生成 6 位绑定码', r.data && (r.data.bindCode || r.data.error))) {
    process.exit(1);
  }
  const bindCode = r.data.bindCode;

  // ---- 1. 设备换令牌 ----
  group('1. 设备用绑定码换长期令牌');
  r = await call('POST', '/api/auth/device-bind', { code: bindCode }, false);
  if (!check(r.ok && r.data.accessToken, '换取设备令牌', r.data && (r.data.accessToken ? '已签发' : r.data.error))) {
    process.exit(1);
  }
  token = r.data.accessToken;
  deviceToken = r.data.accessToken;

  // 设备令牌不该被当成网页身份用：拿它去导出家庭数据应被拒
  const asUser = await call('GET', '/api/export/family-data');
  check(asUser.status === 403, '设备令牌不能导出家庭数据（越权防护）', `HTTP ${asUser.status}`);

  // ---- 2. 握手 ----
  group('2. 上电握手 handshake');
  r = await call('POST', '/api/device/handshake', {
    api_version: 'v1',
    hardware_model: 'MB-8L',
    firmware_version: '1.0.0',
    boot_at: new Date().toISOString(),
    battery: 86,
    charging: 0,
    rssi: -57,
    uptime_sec: 3,
    temperature: 27.4,
    capabilities: { lock: true, buzzer: true, speaker: true, screen: false, scale: true, door_sensor: true },
  });
  const hs = r.data || {};
  check(r.ok && hs.ok, '握手成功');
  check(!!hs.server_time, '返回服务器时间（对时）', hs.server_time);
  check(!!hs.config_version, '返回配置指纹', hs.config_version);
  check(Array.isArray(hs.today_tasks), '返回今日任务单', `${(hs.today_tasks || []).length} 条`);
  check(hs.config && Array.isArray(hs.config.slots), '返回全量配置（含格位映射）');
  check(Array.isArray(hs.commands), '返回积压指令（首次为空）', `${(hs.commands || []).length} 条`);
  const cfgVersion = hs.config_version;

  // ---- 3. 对时 ----
  group('3. 单独对时 /api/device/time');
  r = await call('GET', '/api/device/time');
  check(r.ok && !!r.data.server_epoch_ms, '返回服务器时间戳', r.data && r.data.server_time);
  const skew = Math.abs(Date.now() - Number(r.data.server_epoch_ms || 0));
  check(skew < 60000, '时钟偏差在 1 分钟内', `${skew} ms`);

  // ---- 4. 心跳 ----
  group('4. 心跳 heartbeat（真机每 60 秒一次）');
  r = await call('POST', '/api/device/heartbeat', {
    battery: 85, charging: 0, rssi: -58, uptime_sec: 63, door_open: 0,
    config_version: cfgVersion,
  });
  const hb = r.data || {};
  check(r.ok && hb.ok, '心跳成功');
  check(hb.config_changed === false, '配置未变时 config_changed=false（省一次全量拉取）');
  check(hb.next_task === null || typeof hb.next_task === 'object', '返回下一顿任务',
    hb.next_task ? `${hb.next_task.elder_name} ${hb.next_task.dose_time} 第${hb.next_task.slot_no}格` : '今天已无待办');

  // 故意上报一个错的配置版本，应该被告知需要重拉
  r = await call('POST', '/api/device/heartbeat', { config_version: 'stale-000000' });
  check(r.ok && r.data.config_changed === true, '配置指纹不一致时 config_changed=true', '设备会立刻重拉配置');

  // ---- 5. 任务单 ----
  group('5. 当日任务单 /api/device/tasks');
  r = await call('GET', '/api/device/tasks');
  const tasks = (r.data && r.data.tasks) || [];
  check(r.ok && Array.isArray(tasks), '取到任务单', `${tasks.length} 条`);
  if (tasks.length) {
    const t = tasks[0];
    check(!!t.task_id && !!t.dose_time && !!t.window, '任务含时间窗', `${t.dose_time} 窗口 ${t.window.start}~${t.window.end}`);
    check(Array.isArray(t.reminders) && t.reminders.length > 0, '任务含提醒时刻表',
      t.reminders.map((x) => `${x.at}/${x.mode}`).join(' '));
    check(!!t.speech && !!t.speech.text, '任务含播报文案', String(t.speech.text).slice(0, 40) + '…');
    check('status' in t && 'overdue' in t, '任务含完成状态', `status=${t.status} overdue=${t.overdue}`);
  }
  // 越界日期应被拒
  r = await call('GET', '/api/device/tasks?date=2020-01-01');
  check(r.status === 400, '超出 7 天的历史日期被拒', `HTTP ${r.status}`);

  // ---- 6. 全量配置 ----
  group('6. 全量配置 /api/device/config');
  r = await call('GET', '/api/device/config');
  const cfg = r.data || {};
  check(r.ok && cfg.config_version, '配置含指纹', cfg.config_version);
  check(Array.isArray(cfg.elders) && cfg.elders.length > 0, '配置含老人与提醒策略',
    (cfg.elders || []).map((e) => e.name).join('、'));
  check(Array.isArray(cfg.slots) && cfg.slots.length > 0, '配置含格位', `${(cfg.slots || []).length} 格`);
  check(Array.isArray(cfg.schedules), '配置含计划', `${(cfg.schedules || []).length} 条`);
  check(cfg.policy && cfg.policy.heartbeat_interval_sec, '配置含设备行为参数', `心跳建议 ${cfg.policy.heartbeat_interval_sec}s`);
  if (cfg.elders && cfg.elders[0]) {
    const rem = cfg.elders[0].reminder || {};
    check('volume_level' in rem && 'repeat_times' in rem, '提醒策略完整下发',
      `音量${rem.volume_level} 语速${rem.speech_rate} 重复${rem.repeat_times}次 超时${rem.timeout_minutes}分`);
  }
  configVersion = cfg.config_version;

  // ---- 7. 格位状态 ----
  group('7. 格位状态上报 /api/device/slots');
  const slotCount = (cfg.slots || []).length || 7;
  const payloadSlots = [];
  for (let i = 1; i <= Math.min(slotCount, 3); i++) {
    payloadSlots.push({ slot_no: i, stock_ratio: 100 - i * 20, is_empty: false, sensor_ok: true, is_locked: true });
  }
  r = await call('POST', '/api/device/slots', { slots: payloadSlots });
  check(r.ok && r.data.accepted === payloadSlots.length, '格位状态全部接收', `${r.data && r.data.accepted} 格`);
  // 不存在的格位应被逐条拒绝而不是整批 500
  r = await call('POST', '/api/device/slots', { slots: [{ slot_no: 99, stock_ratio: 10 }] });
  check(r.status === 200 && (r.data.rejected || []).length === 1, '不存在的格位被逐条拒绝', '整批不报 500');
  // 非法入参
  r = await call('POST', '/api/device/slots', { slots: 'oops' });
  check(r.status === 400, 'slots 非数组返回 400', `HTTP ${r.status}`);

  // ---- 8. 设备自检 ----
  group('8. 设备自检 /api/device/status');
  r = await call('POST', '/api/device/status', { battery: 84, rssi: -60, temperature: 28.1, door_open: 0, firmware_version: '1.0.0' });
  check(r.ok && r.data.status && Number(r.data.status.battery) === 84, '遥测落库并回显',
    `电量 ${r.data && r.data.status && r.data.status.battery}%`);
  // 越界值必须被收敛，而不是原样写库
  r = await call('POST', '/api/device/status', { battery: 300, rssi: -999, temperature: 999 });
  check(r.ok && Number(r.data.status.battery) === 100, '电量 300% 被收敛到 100', `battery=${r.data && r.data.status && r.data.status.battery}`);

  // ---- 9. 事件上报（单条） ----
  group('9. 事件上报 /api/device/events');
  const today = new Date();
  const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  // 每次跑用不同的号：这个脚本是可以反复执行的，断言不能依赖「今天第一次跑」
  const RUN = Date.now().toString(36);
  const cid = `agent-${ymd}-${RUN}-open`;
  r = await call('POST', '/api/device/events', {
    slot_no: 1, event_type: 'open', dose_qty: 1,
    occurred_at: new Date().toISOString(),
    client_event_id: cid,
  });
  check(r.ok && r.data.event && r.data.event.id, '事件入库并给出判定', `result=${r.data && r.data.event && r.data.event.result}`);

  // ---- 10. 离线批量补传 + 幂等 ----
  group('10. 离线补传与幂等 /api/device/events/batch');
  const batch = [
    { client_event_id: cid, slot_no: 1, event_type: 'take', dose_qty: 1, occurred_at: new Date().toISOString() },
    { client_event_id: `agent-${ymd}-${RUN}-close`, slot_no: 1, event_type: 'close', occurred_at: new Date().toISOString() },
    { client_event_id: `agent-${ymd}-${RUN}-bad`, slot_no: 1, event_type: '不存在的类型', occurred_at: new Date().toISOString() },
  ];
  r = await call('POST', '/api/device/events/batch', { events: batch });
  const br = r.data || {};
  check(r.ok, '批量接口整体成功');
  check(br.duplicated === 1, '已入过库的同号事件被判重', `duplicated=${br.duplicated}`);
  check(br.accepted === 1, '新事件正常入库', `accepted=${br.accepted}`);
  check(br.failed === 1, '坏事件只失败它自己，不拖垮整批', `failed=${br.failed}`);
  // 再补传一次：全部应判重，不新增任何流水
  r = await call('POST', '/api/device/events/batch', { events: batch.slice(0, 2) });
  check(r.ok && r.data.accepted === 0 && r.data.duplicated === 2, '重复补传零新增（幂等生效）',
    `accepted=${r.data && r.data.accepted} duplicated=${r.data && r.data.duplicated}`);
  r = await call('POST', '/api/device/events/batch', { events: [] });
  check(r.ok && r.data.accepted === 0, '空数组安全返回');

  // ---- 11. 指令下发与回执 ----
  group('11. 远程指令：子女下发 → 设备取走 → 回执');
  token = userToken;
  r = await call('POST', `/api/medbox/${box.id}/commands`, {
    command: 'ring',
    params: { seconds: 5 },
    ttl_min: 10,
  });
  check(r.ok && r.data.command && r.data.command.id, '子女端下发响铃指令', `command_id=${r.data && r.data.command && r.data.command.id}`);
  const cmdId = r.data && r.data.command && r.data.command.id;

  // 越权：开一个不属于本箱的格
  r = await call('POST', `/api/medbox/${box.id}/commands`, { command: 'unlock', params: { slot_no: 999 } });
  check(r.status === 400, '不存在的格位不能远程解锁（防隔空开别人格子）', `HTTP ${r.status}`);
  r = await call('POST', `/api/medbox/${box.id}/commands`, { command: 'speak' });
  check(r.status === 400, 'speak 不带文案被拒', `HTTP ${r.status}`);
  r = await call('POST', `/api/medbox/${box.id}/commands`, { command: 'launch_rocket' });
  check(r.status === 400, '不支持的指令被拒', `HTTP ${r.status}`);

  token = deviceToken;   // 切回设备令牌
  r = await call('GET', '/api/device/commands');
  const cmds = (r.data && r.data.commands) || [];
  check(r.ok && cmds.some((c) => Number(c.command_id) === Number(cmdId)), '设备取到待执行指令', `${cmds.length} 条`);
  // 再取一次：已被取走的不应重复出现
  r = await call('GET', '/api/device/commands');
  check(r.ok && !(r.data.commands || []).some((c) => Number(c.command_id) === Number(cmdId)), '取走后不重复下发（防重复响铃）');

  r = await call('POST', `/api/device/commands/${cmdId}/ack`, { status: 'done', message: '响铃 5 秒完成' });
  check(r.ok && r.data.command.status === 'done', '指令回执成功', r.data && r.data.command && r.data.command.result_msg);
  r = await call('POST', `/api/device/commands/${cmdId}/ack`, { status: 'done' });
  check(r.ok, '重复回执幂等，不报错');

  // ---- 12. 故障上报 ----
  group('12. 设备故障上报 /api/device/fault');
  r = await call('POST', '/api/device/fault', { code: 'LOCK_JAMMED', message: '第 3 格锁舌卡住，无法弹开' });
  check(r.ok && r.data.code === 'LOCK_JAMMED', '故障已记录并通知子女', `alertId=${r.data && r.data.alertId}`);
  r = await call('POST', '/api/device/fault', { code: 'LOCK_JAMMED' });
  check(r.ok && r.data.alertId === null, '同类故障 30 分钟内不重复告警', r.data && r.data.message);
  r = await call('POST', '/api/device/fault', {});
  check(r.status === 400, '不带故障码返回 400', `HTTP ${r.status}`);

  // ---- 13. OTA ----
  group('13. 固件检查 /api/device/firmware');
  r = await call('GET', '/api/device/firmware');
  check(r.ok && r.data.current === '1.0.0', '返回当前固件版本', r.data && r.data.current);
  check(r.ok && 'need_update' in r.data && r.data.latest === null, '无固件包时安全返回（接口已留好）',
    r.data && r.data.message);

  // ---- 14. 录音 ----
  group('14. 方言录音下发 /api/device/recordings');
  r = await call('GET', '/api/device/recordings');
  check(r.ok && Array.isArray(r.data), '取到录音清单', `${(r.data || []).length} 条`);
  if ((r.data || []).length) {
    const rec = r.data[0];
    check(/^https?:\/\//.test(rec.audio_url), '音频地址是绝对 URL（设备可直接下载）', rec.audio_url);
  }

  // ---- 14.5 诊断日志 ----
  group('14.5 设备日志 /api/device/logs');
  r = await call('POST', '/api/device/logs', {
    logs: [
      { level: 'info', event: 'BOOT', message: '上电启动，固件 1.0.0', context: { uptime: 0 } },
      { level: 'warn', event: 'WIFI_WEAK', message: 'WiFi 信号 -78dBm，可能影响上报' },
      { level: 'error', event: 'LOCK_FAIL', message: '第 3 格锁舌卡住一次，重试后成功' },
      { level: 'info', message: '' },   // 空正文应被跳过而不是报错
    ],
  });
  check(r.ok && r.data.accepted === 3, '日志入库（空正文被跳过）', `accepted=${r.data && r.data.accepted} skipped=${r.data && r.data.skipped}`);
  check(r.ok && r.data.keep_days === 7, '日志保留策略生效', `${r.data && r.data.keep_days} 天`);
  r = await call('GET', '/api/device/logs?limit=5');
  check(r.ok && Array.isArray(r.data) && r.data.length >= 3, '日志可回读（设备崩溃后可自查）', `${(r.data || []).length} 条`);
  r = await call('POST', '/api/device/logs', { logs: 'oops' });
  check(r.status === 400, 'logs 非数组返回 400', `HTTP ${r.status}`);
  const tooMany = Array.from({ length: 101 }, () => ({ level: 'info', message: 'x' }));
  r = await call('POST', '/api/device/logs', { logs: tooMany });
  check(r.status === 400, '一次超过 100 条被拒（防死循环刷爆库）', `HTTP ${r.status}`);

  // ---- 15. SOS ----
  if (OPT.sos) {
    group('15. SOS 求助 /api/device/sos');
    r = await call('POST', '/api/device/sos', {});
    check(r.ok && r.data.alertId, 'SOS 已通知子女', `alertId=${r.data && r.data.alertId}`);
    check(r.data && r.data.command_queued === true, '同时给现场排了一条安抚播报', '优先级 1');
    r = await call('GET', '/api/device/commands');
    check(r.ok && (r.data.commands || []).some((c) => c.command === 'speak' && c.priority === 1),
      '现场安抚播报指令已进入队列');
  } else {
    group('15. SOS 求助（本次跳过，加 --sos 可触发）');
  }

  // ---- 16. 越权收尾 ----
  group('16. 越权与鉴权边界');
  const noToken = await fetch(BASE + '/api/device/handshake', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check(noToken.status === 401, '无令牌调用设备接口返回 401', `HTTP ${noToken.status}`);

  token = userToken;
  const asChild = await call('POST', '/api/device/handshake', {});
  check(asChild.status === 403, '子女端令牌不能冒充设备', `HTTP ${asChild.status}`);

  token = '';
  r = await call('GET', '/api/device/bind', undefined, false);
  check(r.ok && r.data.code === 'USE_AUTH_DEVICE_BIND', '绑定指路接口给出正确入口', '/api/auth/device-bind');

  // ---- 收尾 ----
  console.log('\n==================================================');
  console.log(`  通过 ${pass} / 失败 ${fail}`);
  console.log('==================================================');
  if (fail > 0) process.exit(1);
}

async function loop() {
  console.log('--------------------------------------------------');
  console.log(`  进入常驻心跳模式，每 ${HEARTBEAT_MS / 1000} 秒一次，Ctrl+C 停止`);
  console.log('--------------------------------------------------');
  for (;;) {
    try {
      const r = await call('POST', '/api/device/heartbeat', {
        battery: 80, rssi: -60, uptime_sec: Math.floor(process.uptime()),
        config_version: configVersion || undefined,
      });
      const d = r.data || {};
      const next = d.next_task ? `${d.next_task.dose_time} ${d.next_task.elder_name} 第${d.next_task.slot_no}格` : '无待办';
      console.log(`[${new Date().toLocaleTimeString()}] 心跳 ok  下一顿 ${next}` +
        (d.config_changed ? '  ⚠ 配置有变，需重拉' : '') +
        (d.pending_commands && d.pending_commands.length ? `  指令 ${d.pending_commands.length} 条` : ''));
      for (const c of d.pending_commands || []) {
        console.log(`   → 执行指令 ${c.command} ${JSON.stringify(c.params || {})}`);
        await call('POST', `/api/device/commands/${c.command_id}/ack`, { status: 'done', message: '模拟器执行完成' });
      }
    } catch (e) {
      console.log(`[${new Date().toLocaleTimeString()}] 心跳失败：${e.message}`);
    }
    await sleep(HEARTBEAT_MS);
  }
}

// 进入 main
(async () => {
  await main();
  if (OPT.loop) await loop();
})().catch((e) => {
  console.error('\n执行失败：', e.message);
  process.exit(1);
});
