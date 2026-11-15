/**
 * 设备域服务 —— 药箱硬件对接的全部业务逻辑
 *
 * 为什么单独一层：
 *   硬件侧要的东西和网页侧完全不一样。网页要「一个页面一次请求刚好够用的数据」，
 *   硬件要的是「一次拿到能离线跑一整天的全部配置 + 一条能直接执行的指令队列」。
 *   把这些拼装逻辑放进路由里，路由会变成几百行的巨型 SQL 拼装现场。
 *
 * 这一层提供的能力：
 *   handshake      上电握手：认身份、收能力集、对时、给配置版本
 *   heartbeat      心跳：刷在线状态、回收遥测、取指令、给下一顿任务
 *   buildConfig    全量配置快照（老人策略 / 格位映射 / 计划 / 药品 / 录音）
 *   buildTasks     当天任务单（几点、哪一格、播什么、超时怎么判）
 *   pullCommands   取待执行指令（取走即标记 sent，防止重复执行）
 *   ackCommand     指令回执
 *   reportSlots    格位状态（余量 / 空 / 传感器故障）
 *   reportFault    故障上报 → 生成 fault 告警通知子女
 */
const crypto = require('crypto');
const { query, queryOne, exec } = require('../db');
const { badRequest, notFound, forbidden } = require('./http');

// ==================== 小工具 ====================

const p2 = (n) => String(n).padStart(2, '0');

/** Date → 'YYYY-MM-DD HH:mm:ss'（本地时区，绝不能用 toISOString） */
function toMysqlDatetime(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
         `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** Date → 'YYYY-MM-DD'（本地时区） */
function toDateStr(d) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** 'HH:MM:SS' → 当天第几分钟；非法返回 0 */
function timeToMin(t) {
  const [h, m] = String(t || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 分钟数 → 'HH:MM'，跨天按 24 小时回绕（凌晨 3 点的「提前 30 分钟」不能变成 -1:30） */
function minToTime(min) {
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${p2(Math.floor(v / 60))}:${p2(v % 60)}`;
}

/** 'HH:MM:SS' → 'HH:MM' */
function hhmm(t) {
  return String(t || '').slice(0, 5);
}

/** 把 0/1、'0'、'true'、true 统一成布尔；null 保持 null（表示「设备没报」） */
function triBool(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return null;
}

/**
 * 数值收敛：设备上报的遥测是不能直接信的。
 * 电量报 300、信号报 'abc'、温度报 999 都出现过（固件 bug 或报文错位），
 * 直接写库会让看板显示「电量 300%」这种一眼假的数据。
 */
function clampNum(v, min, max, integer = true) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const x = Math.min(max, Math.max(min, n));
  return integer ? Math.trunc(x) : Math.round(x * 10) / 10;
}

// ==================== 药箱上下文 ====================

/** 这台药箱关联的全部老人（含提醒策略） */
async function boxElders(box) {
  const rows = await query(
    `SELECT e.*, me.is_primary
       FROM medbox_elder me
       JOIN elder e ON e.id = me.elder_id
      WHERE me.medbox_id = ?
      ORDER BY me.is_primary DESC, e.id`,
    [box.id]
  );
  if (rows.length) return rows;
  // 兼容只有 medbox.elder_id、还没写关联表的老数据
  if (box.elder_id) {
    const one = await queryOne('SELECT *, 1 AS is_primary FROM elder WHERE id = ?', [box.elder_id]);
    if (one) return [one];
  }
  return [];
}

/** 这台药箱的格位，以及每格当前被哪条计划占用 */
async function boxSlots(box) {
  return query(
    `SELECT c.*, s.id AS schedule_id, s.dose_time, s.time_label, s.elder_id
       FROM compartment c
       LEFT JOIN schedule s ON s.compartment_id = c.id AND s.status = 'active'
      WHERE c.medbox_id = ?
      ORDER BY c.slot_no`,
    [box.id]
  );
}

/** 老人对外披露的提醒策略（下发给设备执行，不含任何隐私字段） */
function reminderPolicy(elder) {
  return {
    remind_30m: !!elder.remind_30m,
    remind_10m: !!elder.remind_10m,
    remind_3m: !!elder.remind_3m,
    volume_level: Number(elder.volume_level || 3),   // 1-5
    speech_rate: elder.speech_rate || 'slow',        // slow / normal / fast
    repeat_times: Number(elder.repeat_times || 2),
    timeout_minutes: Number(elder.timeout_minutes || 30),
    duplicate_window_minutes: Number(elder.duplicate_window_minutes || 2),
    hearing_level: elder.hearing_level || 'normal',
    vision_level: elder.vision_level || 'normal',
  };
}

/**
 * 配置指纹
 *
 * 为什么不用「配置版本号 +1」：
 *   那要求每一处改动配置的接口都记得去 +1（老人、计划、格位、药品、录音、策略……），
 *   漏一处设备就永远收不到更新，而且这种漏在测试里极难发现。
 *   改成「把影响设备行为的配置拼起来算摘要」：任何一处变了摘要必变，
 *   不需要谁记得维护，天然不会漏。
 *   代价是每次心跳多几条小查询 —— 对一台每分钟心跳一次的设备完全可以接受。
 */
async function configSignature(box, elders, slots) {
  const schIds = slots.filter((s) => s.schedule_id).map((s) => s.schedule_id);
  const items = schIds.length
    ? await query(
      `SELECT si.schedule_id, si.medicine_id, si.dose_qty, m.name, m.unit
         FROM schedule_item si JOIN medicine m ON m.id = si.medicine_id
        WHERE si.schedule_id IN (${schIds.map(() => '?').join(',')})
        ORDER BY si.schedule_id, si.medicine_id`, schIds)
    : [];
  const recs = elders.length
    ? await query(
      `SELECT id, elder_id, schedule_id, audio_url, play_order, enabled
         FROM recording WHERE elder_id IN (${elders.map(() => '?').join(',')})
        ORDER BY elder_id, id`, elders.map((e) => e.id))
    : [];
  const payload = JSON.stringify({
    v: 1,
    box: [box.id, box.compartment_count, box.hardware_model || ''],
    elders: elders.map((e) => [e.id, e.name, e.status, reminderPolicy(e)]),
    slots: slots.map((s) => [s.id, s.slot_no, s.label, s.is_locked, s.schedule_id, s.dose_time, s.time_label]),
    items: items.map((i) => [i.schedule_id, i.medicine_id, String(i.dose_qty), i.unit]),
    recs: recs.map((r) => [r.id, r.schedule_id, r.audio_url, r.play_order, r.enabled]),
  });
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

// ==================== 播报内容 ====================

/**
 * 拼一条能直接念出来的用药提示。
 *
 * 为什么服务端拼好再下发，而不是让设备自己拼：
 *   设备侧固件一旦发出去就很难改。播报话术是产品文案，会经常调
 *   （比如加方言、改称谓、加免责声明），把文案留在云端，改完立刻生效，
 *   不用给几千台药箱刷固件。
 */
function speechText(elder, schedule, items) {
  const who = elder.name || '您';
  const label = schedule.time_label ? `${schedule.time_label}的` : '';
  const slot = schedule.slot_no ? `请打开第 ${schedule.slot_no} 格。` : '';
  const list = items.length
    ? items.map((i) => `${i.name} ${Number(i.dose_qty)} ${i.unit || '片'}`).join('，') + '。'
    : '';
  return `${who}，${label}药该吃了。${slot}${list}吃完记得关好箱门。`;
}

/** 取这一顿该播的录音：先找绑定到本时段的，没有才退通用录音（与老人端同口径） */
async function pickRecording(elderId, scheduleId) {
  return queryOne(
    `SELECT * FROM recording WHERE elder_id = ? AND enabled = 1
       AND (schedule_id = ? OR schedule_id IS NULL)
     ORDER BY schedule_id IS NULL, play_order, id LIMIT 1`,
    [elderId, scheduleId]
  );
}

// ==================== 任务单 ====================

/**
 * 生成某一天的任务单
 *
 * 一张任务 = 「几点、开哪一格、念什么、几点算超时」。
 * 设备拿到这张单子就能离线跑一整天：不需要到点再来问云端，
 * 断网也不会漏提醒 —— 这是药箱这类设备能不能用的分水岭。
 */
async function buildTasks(box, dateStr, baseUrl) {
  const elders = await boxElders(box);
  if (!elders.length) return [];
  const slots = await boxSlots(box);

  const elderIds = elders.map((e) => e.id);
  const schRows = await query(
    `SELECT s.*, c.slot_no, c.label AS compartment_label
       FROM schedule s
       LEFT JOIN compartment c ON c.id = s.compartment_id
      WHERE s.elder_id IN (${elderIds.map(() => '?').join(',')})
        AND s.status = 'active'
      ORDER BY s.dose_time, s.id`,
    elderIds
  );
  if (!schRows.length) return [];

  const schIds = schRows.map((s) => s.id);
  const items = await query(
    `SELECT si.schedule_id, si.medicine_id, si.dose_qty, si.note,
            m.name, m.unit, m.appearance
       FROM schedule_item si JOIN medicine m ON m.id = si.medicine_id
      WHERE si.schedule_id IN (${schIds.map(() => '?').join(',')})
      ORDER BY si.schedule_id, m.name`,
    schIds
  );

  // 当天已有的服药流水：任务单要带上「这条已经做完了」，设备才不会重复提醒
  const evRows = await query(
    `SELECT schedule_id, result, MAX(occurred_at) AS at
       FROM intake_event
      WHERE medbox_id = ? AND schedule_id IS NOT NULL AND DATE(occurred_at) = ?
      GROUP BY schedule_id, result`,
    [box.id, dateStr]
  );
  const taken = {};      // schedule_id -> 最近一次「吃了」的时间
  const missed = {};     // schedule_id -> 判定漏服
  const refused = {};    // schedule_id -> 重复取药被拦
  for (const r of evRows) {
    const sid = Number(r.schedule_id);
    if (['on_time', 'early', 'late'].includes(r.result)) taken[sid] = r.at;
    else if (r.result === 'missed') missed[sid] = r.at;
    else if (r.result === 'duplicate') refused[sid] = r.at;
  }

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const isToday = dateStr === toDateStr(now);

  const out = [];
  for (const s of schRows) {
    const elder = elders.find((e) => e.id === Number(s.elder_id));
    if (!elder) continue;
    const pol = reminderPolicy(elder);
    const mine = items.filter((i) => Number(i.schedule_id) === Number(s.id));
    const base = timeToMin(s.dose_time);
    const before = Number(s.window_before_min ?? 10);
    const after = Number(s.window_after_min ?? 30);
    const rec = await pickRecording(elder.id, s.id);

    // 提醒时刻表：只下发老人实际开启的那几档
    const reminders = [];
    if (pol.remind_30m) reminders.push({ lead_min: 30, at: minToTime(base - 30), mode: 'slow_blink' });
    if (pol.remind_10m) reminders.push({ lead_min: 10, at: minToTime(base - 10), mode: 'steady_light' });
    if (pol.remind_3m) reminders.push({ lead_min: 3, at: minToTime(base - 3), mode: 'beep_and_speak' });
    reminders.push({ lead_min: 0, at: minToTime(base), mode: 'unlock_and_speak' });

    const sid = Number(s.id);
    let status = 'pending';
    if (taken[sid]) status = 'done';
    else if (refused[sid]) status = 'refused';
    else if (missed[sid]) status = 'missed';

    out.push({
      task_id: `S${sid}-${dateStr}`,
      date: dateStr,
      schedule_id: sid,
      elder_id: Number(elder.id),
      elder_name: elder.name,
      time_label: s.time_label || '',
      dose_time: hhmm(s.dose_time),
      window: { before_min: before, after_min: after, start: minToTime(base - before), end: minToTime(base + after) },
      slot_no: s.slot_no || null,
      compartment_id: s.compartment_id || null,
      compartment_label: s.compartment_label || null,
      unlock: true,
      items: mine.map((i) => ({
        medicine_id: Number(i.medicine_id),
        name: i.name,
        unit: i.unit,
        dose_qty: Number(i.dose_qty),
        appearance: i.appearance || null,
        note: i.note || null,
      })),
      reminders,
      timeout: { at: minToTime(base + pol.timeout_minutes), minutes: pol.timeout_minutes },
      speech: {
        text: speechText({ ...elder, name: elder.name }, { ...s, slot_no: s.slot_no }, mine),
        rate: pol.speech_rate,
        volume: pol.volume_level,
        repeat: pol.repeat_times,
        audio_url: rec ? absoluteUrl(baseUrl, rec.audio_url) : null,
        audio_id: rec ? Number(rec.id) : null,
      },
      status,                                        // pending / done / missed / refused
      result_at: taken[sid] || missed[sid] || refused[sid] || null,
      overdue: status === 'pending' && isToday && nowMin > base + after,
    });
  }
  return out;
}

/** 相对路径补成绝对地址：设备不是浏览器，没有「当前页面」可以参照 */
function absoluteUrl(baseUrl, url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseUrl) return url;
  return baseUrl.replace(/\/+$/, '') + '/' + String(url).replace(/^\/+/, '');
}

// ==================== 全量配置快照 ====================

/**
 * 设备要「一次拿全、离线可用」的配置
 *
 * 与网页接口的区别：这里把所有外键都摊平成 slot_no、elder_name 这种
 * 设备能直接用的值，不让固件自己去 JOIN。
 */
async function buildConfig(box, baseUrl) {
  const elders = await boxElders(box);
  const slots = await boxSlots(box);
  const signature = await configSignature(box, elders, slots);

  const elderIds = elders.map((e) => e.id);
  const schedules = elderIds.length
    ? await query(
      `SELECT s.*, c.slot_no FROM schedule s
         LEFT JOIN compartment c ON c.id = s.compartment_id
        WHERE s.elder_id IN (${elderIds.map(() => '?').join(',')})
        ORDER BY s.dose_time, s.id`, elderIds)
    : [];
  const medicines = elderIds.length
    ? await query(
      `SELECT DISTINCT m.* FROM medicine m
         JOIN schedule_item si ON si.medicine_id = m.id
         JOIN schedule s ON s.id = si.schedule_id
        WHERE s.elder_id IN (${elderIds.map(() => '?').join(',')})
        ORDER BY m.name`, elderIds)
    : [];
  const recordings = elderIds.length
    ? await query(
      `SELECT id, elder_id, schedule_id, title, audio_url, duration_sec, dialect, play_order
         FROM recording WHERE elder_id IN (${elderIds.map(() => '?').join(',')}) AND enabled = 1
        ORDER BY elder_id, play_order, id`, elderIds)
    : [];

  const status = await queryOne('SELECT * FROM device_status WHERE medbox_id = ?', [box.id]);

  return {
    api_version: 'v1',
    config_version: signature,
    server_time: toMysqlDatetime(new Date()),
    timezone: process.env.DEVICE_TIMEZONE || 'Asia/Shanghai',
    // 设备行为的总参数：固件里不要写死这些值，一律读这里
    policy: {
      offline_timeout_min: 5,        // 超过这么久没心跳判离线
      heartbeat_interval_sec: 60,    // 建议心跳间隔
      command_poll_interval_sec: 15, // 建议指令轮询间隔
      config_poll_interval_sec: 300, // 建议配置比对间隔
      max_batch_events: 50,          // 一次补传最多几条
      max_event_backfill_days: 30,   // 补传最多回溯几天（与后端校验一致）
    },
    device: {
      medbox_id: Number(box.id),
      device_code: box.device_code,
      hardware_model: box.hardware_model || null,
      firmware_version: box.firmware_version || null,
      compartment_count: Number(box.compartment_count || 0),
      status: box.status,
      last_seen_at: status ? status.last_seen_at : box.last_heartbeat_at,
    },
    elders: elders.map((e) => ({
      elder_id: Number(e.id),
      name: e.name,
      gender: e.gender,
      is_primary: !!e.is_primary,
      reminder: reminderPolicy(e),
      sos_contact_user_id: e.sos_contact_user_id || null,
    })),
    slots: slots.map((s) => ({
      compartment_id: Number(s.id),
      slot_no: Number(s.slot_no),
      label: s.label,
      is_locked: !!s.is_locked,
      elder_id: s.elder_id ? Number(s.elder_id) : null,
      schedule_id: s.schedule_id ? Number(s.schedule_id) : null,
      stock_ratio: s.stock_ratio,      // null = 该格没装传感器 / 还没上报
      is_empty: triBool(s.is_empty),
      sensor_ok: triBool(s.sensor_ok),
      reported_at: s.reported_at || null,
    })),
    schedules: schedules.map((s) => ({
      schedule_id: Number(s.id),
      elder_id: Number(s.elder_id),
      dose_time: hhmm(s.dose_time),
      time_label: s.time_label || '',
      slot_no: s.slot_no || null,
      window: {
        before_min: Number(s.window_before_min ?? 10),
        after_min: Number(s.window_after_min ?? 30),
      },
      status: s.status,
    })),
    medicines: medicines.map((m) => ({
      medicine_id: Number(m.id),
      name: m.name,
      unit: m.unit,
      appearance: m.appearance || null,
      category: m.category || null,
      stock_qty: Number(m.stock_qty || 0),
      expiry_date: m.expiry_date || null,
    })),
    recordings: recordings.map((r) => ({
      recording_id: Number(r.id),
      elder_id: Number(r.elder_id),
      schedule_id: r.schedule_id ? Number(r.schedule_id) : null,
      title: r.title,
      dialect: r.dialect || null,
      duration_sec: r.duration_sec || null,
      audio_url: absoluteUrl(baseUrl, r.audio_url),
    })),
  };
}

// ==================== 在线状态 ====================

/**
 * 刷新在线状态
 *   握手和心跳都走这里，避免两处各写一套「什么条件算在线」。
 */
async function markSeen(box, { bootAt = null } = {}) {
  await exec(
    `UPDATE medbox SET status = 'online', last_heartbeat_at = NOW() WHERE id = ?`,
    [box.id]
  );
  // device_status 是「一箱一行」的快照表，用 INSERT ... ON DUPLICATE KEY 覆盖写
  await exec(
    `INSERT INTO device_status (medbox_id, last_seen_at, boot_at)
     VALUES (?, NOW(), ?)
     ON DUPLICATE KEY UPDATE last_seen_at = NOW(),
       boot_at = COALESCE(VALUES(boot_at), boot_at)`,
    [box.id, bootAt]
  );
}

/**
 * 回收遥测
 *   设备报什么就存什么，但一律先收敛再入库。
 */
async function saveTelemetry(box, body) {
  const t = body || {};
  const battery = clampNum(t.battery, 0, 100);
  const rssi = clampNum(t.rssi, -120, 0);
  const temp = clampNum(t.temperature, -40, 125, false);
  const uptime = clampNum(t.uptime_sec, 0, 2147483647);

  await exec(
    `INSERT INTO device_status
       (medbox_id, api_version, battery, charging, rssi, uptime_sec, temperature,
        door_open, fault_code, fault_msg, last_seen_at, raw)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW(),?)
     ON DUPLICATE KEY UPDATE
       api_version = VALUES(api_version), battery = VALUES(battery),
       charging = VALUES(charging), rssi = VALUES(rssi),
       uptime_sec = VALUES(uptime_sec), temperature = VALUES(temperature),
       door_open = VALUES(door_open),
       fault_code = VALUES(fault_code), fault_msg = VALUES(fault_msg),
       raw = VALUES(raw), last_seen_at = NOW()`,
    [
      box.id,
      t.api_version ? String(t.api_version).slice(0, 16) : 'v1',
      battery,
      triBool(t.charging),
      rssi,
      uptime,
      temp,
      triBool(t.door_open),
      t.fault_code ? String(t.fault_code).slice(0, 32) : null,
      t.fault_msg ? String(t.fault_msg).slice(0, 200) : null,
      JSON.stringify(t).slice(0, 60000),
    ]
  );

  // 固件版本一起带上来就顺手更新（不用设备专门再调一个接口）
  if (t.firmware_version) {
    await exec('UPDATE medbox SET firmware_version = ? WHERE id = ?',
      [String(t.firmware_version).slice(0, 32), box.id]);
  }
  if (t.hardware_model) {
    await exec('UPDATE medbox SET hardware_model = ? WHERE id = ?',
      [String(t.hardware_model).slice(0, 64), box.id]);
  }
}

// ==================== 握手 ====================

async function handshake(box, body, baseUrl) {
  const t = body || {};
  const bootAt = t.boot_at && !Number.isNaN(new Date(t.boot_at).getTime())
    ? toMysqlDatetime(new Date(t.boot_at))
    : toMysqlDatetime(new Date());

  // 必须同步改内存里的 box：下面算配置指纹要用到 hardware_model。
  // 只写库、不改对象的话，这次握手给出的指纹基于旧值，
  // 下一次心跳按新值算出来就对不上，设备会白拉一次全量配置。
  if (t.firmware_version) {
    const fw = String(t.firmware_version).slice(0, 32);
    await exec('UPDATE medbox SET firmware_version = ? WHERE id = ?', [fw, box.id]);
    box.firmware_version = fw;
  }
  if (t.hardware_model) {
    const hm = String(t.hardware_model).slice(0, 64);
    await exec('UPDATE medbox SET hardware_model = ? WHERE id = ?', [hm, box.id]);
    box.hardware_model = hm;
  }
  await markSeen(box, { bootAt });
  await saveTelemetry(box, { ...t, api_version: t.api_version || 'v1' });

  const config = await buildConfig(box, baseUrl);
  const tasks = await buildTasks(box, toDateStr(new Date()), baseUrl);
  const commands = await pullCommands(box.id, 20);

  return {
    ok: true,
    // 对时：设备时钟不准会导致所有服药判定错乱，握手必须把服务器时间带回去
    server_time: toMysqlDatetime(new Date()),
    server_epoch_ms: Date.now(),
    api_version: 'v1',
    config_version: config.config_version,
    device: config.device,
    policy: config.policy,
    config,                       // 握手直接把全量配置给全，省一次往返
    today_tasks: tasks,           // 今天剩下的任务单
    commands,                     // 上次离线期间积压的指令
    message: `已连接 ${config.device.device_code}；今日任务 ${tasks.length} 条`,
  };
}

// ==================== 心跳 ====================

async function heartbeat(box, body, baseUrl) {
  const t = body || {};
  await markSeen(box);
  await saveTelemetry(box, t);

  const elders = await boxElders(box);
  const slots = await boxSlots(box);
  const signature = await configSignature(box, elders, slots);

  // 下一顿：今天还没完成、时间点还没过的最近一条
  const now = new Date();
  const tasks = await buildTasks(box, toDateStr(now), baseUrl);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const nextTask = tasks
    .filter((x) => x.status === 'pending' && timeToMin(x.dose_time) >= nowMin)
    .sort((a, b) => timeToMin(a.dose_time) - timeToMin(b.dose_time))[0] || null;

  // 设备带 config_version 上来，对不上就告诉它该重拉了
  const clientVer = t.config_version ? String(t.config_version) : null;
  const needSync = clientVer ? clientVer !== signature : false;

  const commands = await pullCommands(box.id, 10);

  return {
    ok: true,
    server_time: toMysqlDatetime(now),
    server_epoch_ms: now.getTime(),
    online: true,
    config_version: signature,
    config_changed: needSync,     // true → 设备立刻调 GET /api/device/config
    next_task: nextTask,
    pending_commands: commands,
    unread_alerts: 0,             // 预留：设备屏显提示用，暂不下发具体内容
  };
}

// ==================== 指令队列 ====================

const VALID_COMMANDS = ['ring', 'led', 'unlock', 'lock', 'speak', 'sync', 'reboot', 'locate'];

/**
 * 入队一条指令
 * @param {object} opt {command, params, priority, createdBy, ttlMin, source}
 */
async function enqueueCommand(boxId, opt = {}) {
  const cmd = String(opt.command || '');
  if (!VALID_COMMANDS.includes(cmd)) {
    throw badRequest(`不支持的指令：${cmd}，可选值：${VALID_COMMANDS.join(' / ')}`);
  }
  const ttl = Number(opt.ttlMin ?? 30);          // 默认 30 分钟内有效，避免半夜突然响铃
  const priority = Number(opt.priority ?? (cmd === 'ring' || cmd === 'locate' ? 3 : cmd === 'sync' ? 8 : 5));
  const r = await exec(
    `INSERT INTO device_command (medbox_id, command, params, priority, source, created_by, expires_at)
     VALUES (?,?,?,?,?,?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [boxId, cmd, opt.params ? JSON.stringify(opt.params).slice(0, 4000) : null,
      priority, opt.source === 'system' ? 'system' : 'user', opt.createdBy || null, ttl]
  );
  return queryOne('SELECT * FROM device_command WHERE id = ?', [r.insertId]);
}

/**
 * 取待执行指令
 *
 * 取走即置 sent：万一设备把响应丢了会重试，但队列里已经取不到这条，
 * 不会出现「响了一次铃没回执，下一轮又响一次」。
 * 代价是极端情况下丢一条指令 —— 对提醒类指令可接受，比反复响铃扰民好。
 */
async function pullCommands(boxId, limit = 10) {
  const n = Math.min(50, Math.max(1, Number(limit) || 10));
  await exec(
    `UPDATE device_command SET status = 'expired'
      WHERE medbox_id = ? AND status = 'pending'
        AND expires_at IS NOT NULL AND expires_at < NOW()`,
    [boxId]
  );
  const rows = await query(
    `SELECT id, command, params, priority, source, created_at, expires_at
       FROM device_command
      WHERE medbox_id = ? AND status = 'pending'
      ORDER BY priority, id LIMIT ${n}`,
    [boxId]
  );
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  await exec(
    `UPDATE device_command SET status = 'sent', picked_at = NOW()
      WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  return rows.map((r) => ({
    command_id: Number(r.id),
    command: r.command,
    params: typeof r.params === 'string' ? safeJson(r.params) : (r.params || null),
    priority: Number(r.priority),
    created_at: r.created_at,
    expires_at: r.expires_at,
  }));
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** 指令回执：设备执行完（不管成功失败）都要回一条，否则云端永远不知道结果 */
async function ackCommand(boxId, commandId, status, message) {
  const okStatus = ['done', 'failed'].includes(status) ? status : 'done';
  const row = await queryOne(
    'SELECT * FROM device_command WHERE id = ? AND medbox_id = ?',
    [commandId, boxId]
  );
  if (!row) throw notFound('指令不存在或不属于这台药箱');
  if (['done', 'failed'].includes(row.status)) {
    // 重复回执：幂等返回，不报错（设备重试是正常行为）
    return queryOne('SELECT * FROM device_command WHERE id = ?', [commandId]);
  }
  await exec(
    `UPDATE device_command SET status = ?, acked_at = NOW(), result_msg = ? WHERE id = ?`,
    [okStatus, message ? String(message).slice(0, 200) : null, commandId]
  );
  return queryOne('SELECT * FROM device_command WHERE id = ?', [commandId]);
}

// ==================== 格位状态 ====================

/**
 * 上报格位状态
 *
 * 每格都可能没装传感器，所以四列都允许 NULL。
 * 关键点：is_empty 只有明确报 true 才写 1，报 null 一律保持 null ——
 * 否则「没装传感器」会被当成「空格」，子女端天天收到假的缺药提醒。
 */
async function reportSlots(box, slots) {
  if (!Array.isArray(slots) || !slots.length) throw badRequest('slots 必须是非空数组');
  if (slots.length > 64) throw badRequest('一次最多上报 64 个格位');

  const out = [];
  for (const s of slots) {
    const slotNo = Number(s.slot_no);
    if (!Number.isFinite(slotNo) || slotNo < 1) {
      out.push({ slot_no: s.slot_no, ok: false, error: 'slot_no 非法' });
      continue;
    }
    const comp = await queryOne(
      'SELECT id FROM compartment WHERE medbox_id = ? AND slot_no = ?',
      [box.id, slotNo]
    );
    if (!comp) {
      out.push({ slot_no: slotNo, ok: false, error: '该格位不存在' });
      continue;
    }
    await exec(
      `UPDATE compartment
          SET stock_ratio = ?, is_empty = ?, sensor_ok = ?, reported_at = NOW(),
              is_locked = COALESCE(?, is_locked)
        WHERE id = ?`,
      [
        clampNum(s.stock_ratio, 0, 100),
        triBool(s.is_empty),
        triBool(s.sensor_ok),
        triBool(s.is_locked),
        comp.id,
      ]
    );
    out.push({ slot_no: slotNo, ok: true });
  }

  // 空格 → 顺手推一条库存告警（去重交给 alertSnoozed 的同类静默期）
  const emptied = slots.filter((s) => triBool(s.is_empty) === true);
  if (emptied.length) {
    await raiseSlotEmptyAlert(box, emptied.length);
  }

  await exec('UPDATE medbox SET last_heartbeat_at = NOW(), status = "online" WHERE id = ?', [box.id]);
  return { ok: true, accepted: out.filter((x) => x.ok).length, rejected: out.filter((x) => !x.ok), detail: out };
}

/** 格子空了 → 通知子女补药（同一台药箱同类告警有静默期，不会连发） */
async function raiseSlotEmptyAlert(box, count) {
  try {
    const elders = await boxElders(box);
    const elder = elders[0];
    if (!elder) return;
    const recent = await queryOne(
      `SELECT id FROM alert WHERE elder_id = ? AND alert_type = 'stock_low'
         AND created_at >= DATE_SUB(NOW(), INTERVAL 6 HOUR) LIMIT 1`,
      [elder.id]
    );
    if (recent) return;
    const owner = await queryOne(
      'SELECT id FROM user WHERE family_id = ? ORDER BY FIELD(role,"owner","member","viewer") LIMIT 1',
      [box.family_id]
    );
    await exec(
      `INSERT INTO alert (elder_id, alert_type, level, content, channel, sent_to_user_id)
       VALUES (?,?,?,?,?,?)`,
      [elder.id, 'stock_low', 'warning',
        `药箱有 ${count} 个格子已经取空（${box.device_code}），请及时补药并重新装格。`,
        'web', owner ? owner.id : null]
    );
  } catch (e) {
    console.warn('[device] 空格告警写入失败：', e.message);
  }
}

// ==================== 故障上报 ====================

/**
 * 设备故障上报
 *   硬件类故障（锁卡死、喇叭不响、传感器坏）和「服药行为异常」是两回事，
 *   单独用 fault 告警类型，界面上文案和处置建议都不一样。
 */
async function reportFault(box, body) {
  const code = body && body.code ? String(body.code).slice(0, 32) : 'UNKNOWN';
  const msg = body && body.message ? String(body.message).slice(0, 200) : '';
  const elder = (await boxElders(box))[0] || null;

  await exec(
    `INSERT INTO device_status (medbox_id, fault_code, fault_msg, last_seen_at, raw)
     VALUES (?,?,?,NOW(),?)
     ON DUPLICATE KEY UPDATE fault_code = VALUES(fault_code),
       fault_msg = VALUES(fault_msg), last_seen_at = NOW(), raw = VALUES(raw)`,
    [box.id, code, msg || null, JSON.stringify(body || {}).slice(0, 60000)]
  );

  let alertId = null;
  if (elder) {
    // 同一故障码 30 分钟内只报一次，避免设备每 10 秒重试刷出一屏告警
    const recent = await queryOne(
      `SELECT id FROM alert WHERE elder_id = ? AND alert_type = 'fault'
         AND content LIKE ? AND created_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE) LIMIT 1`,
      [elder.id, `%${code}%`]
    );
    if (!recent) {
      const owner = await queryOne(
        'SELECT id FROM user WHERE family_id = ? ORDER BY FIELD(role,"owner","member","viewer") LIMIT 1',
        [box.family_id]
      );
      const r = await exec(
        `INSERT INTO alert (elder_id, alert_type, level, content, channel, sent_to_user_id)
         VALUES (?,?,?,?,?,?)`,
        [elder.id, 'fault', 'warning',
          `${box.device_code} 报告设备故障（${code}）${msg ? '：' + msg : ''}，请检查药箱。`,
          'web', owner ? owner.id : null]
      );
      alertId = r.insertId;
    }
  }
  return { ok: true, code, alertId, message: alertId ? '已通知子女' : '已记录（同类故障在静默期内）' };
}

// ==================== 设备日志 ====================

/**
 * 日志清理的节流时间戳。
 * 为什么要节流：设备出故障时会连续上传几百条日志，如果每条都跑一次 DELETE，
 * 数据库会被自己的清理任务拖垮。改成「一个进程一小时最多清一次」，
 * 保留策略仍然是 7 天，只是清得粗一点 —— 日志本来就不是实时业务数据。
 */
let lastPurgeAt = 0;
const LOG_KEEP_DAYS = Number(process.env.DEVICE_LOG_KEEP_DAYS || 7);

async function purgeOldLogs(force = false) {
  const now = Date.now();
  if (!force && now - lastPurgeAt < 3600 * 1000) return;
  lastPurgeAt = now;
  try {
    await exec(
      `DELETE FROM device_log WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 5000`,
      [LOG_KEEP_DAYS]
    );
  } catch (e) {
    console.warn('[device] 日志清理失败：', e.message);
  }
}

/**
 * 接收一批设备日志
 *
 * 上限：一次 100 条、正文 2000 字。
 * 为什么要限：日志是设备「随手就发」的东西，不限的话，一个死循环 bug
 * 能在几分钟内把库塞满 —— 而这正是设备出故障时最容易发生的事。
 */
async function saveLogs(box, body) {
  const list = Array.isArray(body && body.logs) ? body.logs : null;
  if (!list) throw badRequest('logs 必须是数组');
  if (!list.length) return { ok: true, accepted: 0 };
  if (list.length > 100) throw badRequest('一次最多上传 100 条日志，请分批发送');

  const LEVELS = ['debug', 'info', 'warn', 'error'];
  let accepted = 0;
  let skipped = 0;

  for (const item of list) {
    const msg = item && item.message ? String(item.message).slice(0, 2000) : null;
    if (!msg) { skipped++; continue; }
    const level = LEVELS.includes(item.level) ? item.level : 'info';
    let at = new Date();
    if (item.at) {
      const d = new Date(item.at);
      if (!Number.isNaN(d.getTime())) at = d;
    }
    await exec(
      `INSERT INTO device_log (medbox_id, level, event, message, context, occurred_at)
       VALUES (?,?,?,?,?,?)`,
      [
        box.id, level,
        item.event ? String(item.event).slice(0, 64) : null,
        msg,
        item.context ? JSON.stringify(item.context).slice(0, 60000) : null,
        toMysqlDatetime(at),
      ]
    );
    accepted++;
  }

  await purgeOldLogs();
  await exec('UPDATE medbox SET last_heartbeat_at = NOW(), status = "online" WHERE id = ?', [box.id]);
  return { ok: true, accepted, skipped, keep_days: LOG_KEEP_DAYS };
}

/** 读取设备日志（给排障用；子女端也能看，方便报障时说清现象） */
async function readLogs(boxId, limit) {
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  return query(
    `SELECT id, level, event, message, context, occurred_at
       FROM device_log WHERE medbox_id = ?
      ORDER BY occurred_at DESC, id DESC LIMIT ${n}`,
    [boxId]
  );
}

// ==================== 幂等事件 ====================

/**
 * 查这条事件是不是已经入过库
 *   设备断网补传时同一个 client_event_id 可能被重发多次。
 *   返回已有记录 = 直接回它，不再走判定、不再生告警。
 */
async function findEventByClientId(boxId, clientEventId) {
  if (!clientEventId) return null;
  return queryOne(
    'SELECT * FROM intake_event WHERE medbox_id = ? AND client_event_id = ?',
    [boxId, String(clientEventId).slice(0, 64)]
  );
}

module.exports = {
  toMysqlDatetime, toDateStr, timeToMin, minToTime, hhmm, triBool, clampNum, absoluteUrl,
  boxElders, boxSlots, reminderPolicy, configSignature, speechText, pickRecording,
  buildTasks, buildConfig, markSeen, saveTelemetry,
  handshake, heartbeat,
  VALID_COMMANDS, enqueueCommand, pullCommands, ackCommand,
  reportSlots, reportFault, findEventByClientId,
  saveLogs, readLogs, purgeOldLogs,
};
