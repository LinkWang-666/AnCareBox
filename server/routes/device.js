/**
 * 设备侧接口 —— 药箱硬件唯一入口（/api/device/*）
 *
 * 这一组接口是给「实物药箱」用的，不是给网页用的。
 * 实物还没接电脑也没关系：接口按真机需求一次留全，接上就能跑，
 * 不用再回来改后端。每个接口都有明确的「设备什么时候调、调完干什么」。
 *
 * ┌ 设备一生要调的接口 ────────────────────────────────────────────┐
 * │ 1 上电   POST /api/device/handshake   认身份、报能力、对时、拿全量配置 │
 * │ 2 待机   POST /api/device/heartbeat   每 60 秒一次，取指令、看是否要重拉配置 │
 * │ 3 到点   GET  /api/device/tasks       拿当天任务单（可离线执行一整天） │
 * │ 4 取药   POST /api/device/events      一次动作报一条事件            │
 * │ 5 补传   POST /api/device/events/batch 断网期间攒的事件一次性补传（幂等）│
 * │ 6 执行   GET  /api/device/commands    取远程指令（响铃/亮灯/解锁/播报）│
 * │ 7 回执   POST /api/device/commands/:id/ack  执行完必须回执        │
 * │ 8 感知   POST /api/device/slots       每格余量 / 是否空 / 传感器好坏  │
 * │ 9 自检   POST /api/device/status      电量 / 信号 / 门磁 / 温度      │
 * │ 10 报警  POST /api/device/sos         老人按「我不舒服」            │
 * │ 11 故障  POST /api/device/fault       锁卡死 / 喇叭不响 / 传感器坏   │
 * │ 12 OTA   GET  /api/device/firmware    查有没有新固件               │
 * │ 13 对时  GET  /api/device/time        单独校时（心跳里也带）        │
 * └──────────────────────────────────────────────────────────────┘
 *
 * 鉴权：除 bind 之外全部要求 device 令牌（Authorization: Bearer <设备令牌>）。
 *      设备令牌由子女在网页上生成 6 位绑定码，设备调 /api/auth/device-bind 换取。
 *
 * 安全底线：所有接口的设备身份一律取自令牌，请求体里传来的 device_code 会被忽略。
 *          否则任何人抓到一台药箱的报文，就能伪造全家的服药记录。
 */
const express = require('express');
const { query, queryOne, exec } = require('../db');
const { wrap, badRequest } = require('../services/http');
const A = require('../services/auth');
const S = require('../services/scope');
const D = require('../services/device');
const { handleIntakeEvent } = require('../services/intake');

const router = express.Router();

/** 只允许设备令牌访问 —— 子女端网页不该调这些接口 */
function requireDevice(req, res, next) {
  if (req.auth.type !== 'device') {
    return res.status(403).json({
      error: '该接口仅供药箱设备调用（需要设备令牌）',
      code: 'DEVICE_ONLY',
    });
  }
  next();
}

/** 设备看到的自身地址：录音/固件都要给绝对 URL，设备没有「当前页面」可参照 */
function baseUrlOf(req) {
  const host = req.get('host') || `localhost:${process.env.PORT || 3000}`;
  return `${req.protocol}://${host}`;
}

/** 设备事件限流用的松紧度：真机补传时会连发几十条，不能按网页的节奏限 */
const deviceLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: Number(process.env.DEVICE_RATE_LIMIT_MAX || 240),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '设备请求过于频繁，请降低上报频率', code: 'DEVICE_RATE_LIMIT' },
});

// ==================== 0. 绑定入口提示（不需要令牌） ====================

/**
 * 硬件首次接入时最常问的问题是「用什么换取令牌」。
 * 这里给一个明确的指路接口：请求走到这个地址，直接把该调什么告诉它。
 *
 * 注意顺序：它必须放在鉴权中间件之前，否则「还没令牌的人来问怎么拿令牌」
 * 会先被 401 挡住，成了一个死循环。
 */
router.get('/bind', (req, res) => {
  res.json({
    ok: false,
    code: 'USE_AUTH_DEVICE_BIND',
    error: '绑定请调用 POST /api/auth/device-bind',
    howto: {
      url: '/api/auth/device-bind',
      method: 'POST',
      body: { code: '6 位绑定码（子女端「药箱管理 → 生成绑定码」，5 分钟内有效）' },
      returns: {
        accessToken: '设备令牌，存本地 flash；后续请求放 Authorization: Bearer <token>',
        expiresIn: '180d',
      },
      next: '拿到令牌后先调 POST /api/device/handshake 报到',
    },
  });
});

// 鉴权链：先验令牌，再确认是设备令牌（顺序不能反 ——
// requireDevice 要读 req.auth，而 req.auth 是 requireAuth 填进去的）
router.use(A.requireAuth, requireDevice, deviceLimiter);

// ==================== 1. 上电握手 ====================

/**
 * 设备开机第一件事。
 *
 * 为什么不叫 register：设备不是「注册一个账号」，它必须已经被子女用绑定码
 * 授权过（拿到设备令牌）才能进来。这里做的是「报到 + 对时 + 领配置」。
 */
router.post('/handshake', wrap(async (req, res) => {
  const box = req.auth.box;
  const out = await D.handshake(box, req.body || {}, baseUrlOf(req));
  res.json(out);
}));

// ==================== 2. 心跳 ====================

/**
 * 每 60 秒一次。
 *
 * 心跳的三件事，缺一不可：
 *   1) 证明在线（超过 5 分钟没心跳，子女端会收到离线告警）
 *   2) 把积压的远程指令取走（这是云端 → 设备的唯一通道）
 *   3) 顺带把下一顿任务和配置版本带回去（设备据此判断要不要重拉配置）
 */
router.post('/heartbeat', wrap(async (req, res) => {
  const out = await D.heartbeat(req.auth.box, req.body || {}, baseUrlOf(req));
  res.json(out);
}));

// ==================== 3. 对时 ====================

/**
 * 设备时钟不准是智能药箱最致命的问题：
 *   设备自己按本地时钟判定「几点该吃药」，慢 20 分钟就等于每次都吃晚。
 *   所以除了握手/心跳里带 server_time，再单给一个轻量接口，方便设备定时校时。
 */
router.get('/time', wrap(async (req, res) => {
  const now = new Date();
  res.json({
    server_time: D.toMysqlDatetime(now),
    server_epoch_ms: now.getTime(),
    timezone: process.env.DEVICE_TIMEZONE || 'Asia/Shanghai',
    date: D.toDateStr(now),
  });
}));

// ==================== 4. 全量配置 ====================

/** 配置变了（心跳里 config_changed=true）就调这个重拉一次 */
router.get('/config', wrap(async (req, res) => {
  res.json(await D.buildConfig(req.auth.box, baseUrlOf(req)));
}));

// ==================== 5. 任务单 ====================

/**
 * 当天任务单。
 *
 * 一张任务 = 几点 + 开哪一格 + 念什么 + 几点算超时 + 已经做没做。
 * 设备拿到就能离线跑一整天，断网也不漏提醒 —— 这是药箱能不能用的分水岭。
 *
 * 参数：?date=YYYY-MM-DD（默认今天，最多查前后 7 天，避免设备乱翻历史）
 */
router.get('/tasks', wrap(async (req, res) => {
  const today = D.toDateStr(new Date());
  let date = String(req.query.date || today).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('date 格式应为 YYYY-MM-DD');

  const diffDays = Math.abs((new Date(date) - new Date(today)) / 86400000);
  if (Number.isNaN(diffDays) || diffDays > 7) throw badRequest('只能查询今天前后 7 天内的任务');

  const tasks = await D.buildTasks(req.auth.box, date, baseUrlOf(req));
  res.json({
    date,
    server_time: D.toMysqlDatetime(new Date()),
    count: tasks.length,
    tasks,
  });
}));

// ==================== 6. 事件上报（单条） ====================

/**
 * 一次物理动作报一条。设备身份强制取自令牌。
 *
 * 与 /api/events 的区别：
 *   那个接口同时服务子女端调试和模拟器；这个是设备专用，只认设备令牌，
 *   语义更窄、更容易在固件里对齐。
 */
router.post('/events', wrap(async (req, res) => {
  const payload = { ...(req.body || {}) };
  payload.device_code = req.auth.box.device_code;   // 覆盖，防止冒名
  payload.source = payload.source || 'device';
  res.json(await handleIntakeEvent(payload));
}));

/**
 * 离线补传（批量）
 *
 * 为什么必须有这个接口：
 *   药箱放在卧室，WiFi 断一晚上很常见。断网期间的开箱、取药动作
 *   必须先在本地队列里攒着，联网后一次性补传 —— 否则「昨晚吃了没」
 *   这个问题永远答不出来，依从率也会少算一天。
 *
 * 幂等：每条带 client_event_id，同一个号只会入库一次。
 *      设备重发、网络重试、固件崩溃重启后重发，都不会多算一次漏服。
 *
 * 请求体：
 *   { "events": [ {client_event_id, slot_no, event_type, dose_qty, occurred_at}, ... ] }
 */
router.post('/events/batch', wrap(async (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body.events) ? body.events : null;
  if (!list) throw badRequest('events 必须是数组');
  if (!list.length) return res.json({ ok: true, accepted: 0, duplicated: 0, failed: 0, results: [] });
  if (list.length > 50) throw badRequest('一次最多补传 50 条，请分批发送');

  const box = req.auth.box;
  // 按发生时间排序：判定「重复取药」依赖时间先后，乱序补传会把顺序判反
  const sorted = [...list].sort(
    (a, b) => new Date(a.occurred_at || 0) - new Date(b.occurred_at || 0)
  );

  const results = [];
  let accepted = 0; let duplicated = 0; let failed = 0;

  for (const raw of sorted) {
    const cid = raw && raw.client_event_id ? String(raw.client_event_id).slice(0, 64) : null;
    try {
      // 已经入过库 → 直接回原记录，不重复判定、不重复告警
      if (cid) {
        const exists = await D.findEventByClientId(box.id, cid);
        if (exists) {
          duplicated++;
          results.push({ client_event_id: cid, ok: true, duplicated: true, event_id: Number(exists.id), result: exists.result });
          continue;
        }
      }
      const payload = {
        ...raw,
        device_code: box.device_code,
        source: raw.source || 'device',
        client_event_id: cid,
      };
      const out = await handleIntakeEvent(payload);
      accepted++;
      results.push({
        client_event_id: cid,
        ok: true,
        duplicated: false,
        event_id: Number(out.event.id),
        result: out.event.result,
        alert: out.alert || null,
      });
    } catch (e) {
      // 单条坏了不能拖垮整批：设备补传的东西可能有一条字段是脏的，
      // 整批 500 会让设备无限重试、永远传不完。
      failed++;
      results.push({ client_event_id: cid, ok: false, error: e.message });
    }
  }

  res.json({ ok: true, accepted, duplicated, failed, total: list.length, results });
}));

// ==================== 7. 指令队列 ====================

/** 取待执行指令（取走即置 sent，不会重复执行） */
router.get('/commands', wrap(async (req, res) => {
  const limit = Number(req.query.limit || 10);
  const rows = await D.pullCommands(req.auth.box.id, limit);
  res.json({ count: rows.length, commands: rows });
}));

/** 指令回执：执行完（成功或失败）都要回一条，云端才知道结果 */
router.post('/commands/:id/ack', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) throw badRequest('指令 id 非法');
  const body = req.body || {};
  const row = await D.ackCommand(req.auth.box.id, id, body.status, body.message);
  res.json({ ok: true, command: row });
}));

// ==================== 8. 格位状态 ====================

/**
 * 每格余量与传感器状态。
 *
 * 关键约定：**没装传感器的格子不要报字段，或报 null**。
 *   报 0 会被当成「格子空了」，子女端就会天天收到假的补药提醒。
 */
router.post('/slots', wrap(async (req, res) => {
  const body = req.body || {};
  const slots = Array.isArray(body.slots) ? body.slots : null;
  if (!slots) throw badRequest('slots 必须是数组，形如 [{slot_no:1, stock_ratio:80, is_empty:false}]');
  res.json(await D.reportSlots(req.auth.box, slots));
}));

// ==================== 9. 设备自检 ====================

/**
 * 电量 / 信号 / 温度 / 门磁 / 固件版本。
 * 心跳里也可以带同样的字段（省的两次请求），这个接口给「心跳只发空包」的固件用。
 */
router.post('/status', wrap(async (req, res) => {
  const box = req.auth.box;
  await D.markSeen(box);
  await D.saveTelemetry(box, req.body || {});
  const st = await queryOne('SELECT * FROM device_status WHERE medbox_id = ?', [box.id]);
  res.json({
    ok: true,
    server_time: D.toMysqlDatetime(new Date()),
    device: {
      device_code: box.device_code,
      firmware_version: box.firmware_version,
      hardware_model: box.hardware_model,
      status: 'online',
    },
    status: st || null,
  });
}));

// ==================== 10. 故障上报 ====================

/**
 * 硬件本身坏了（不是老人吃药行为异常）。
 * 例：LOCK_JAMMED 锁卡死、SPEAKER_DEAD 喇叭不响、SENSOR_FAULT 传感器坏、DOOR_OPEN 箱门没关严。
 * 云端会生成 fault 告警通知子女，同类故障 30 分钟内只报一次。
 */
router.post('/fault', wrap(async (req, res) => {
  const body = req.body || {};
  if (!body.code) throw badRequest('code 必填，如 LOCK_JAMMED / SPEAKER_DEAD / SENSOR_FAULT / DOOR_OPEN');
  res.json(await D.reportFault(req.auth.box, body));
}));

// ==================== 11. SOS ====================

/**
 * 老人按下「我不舒服」。
 * 设备侧必须能直接用，所以这里独立实现一份（不复用网页端，避免以后改网页把硬件带崩）。
 */
router.post('/sos', wrap(async (req, res) => {
  const body = req.body || {};
  let elderId = body.elder_id || req.auth.elderId;
  if (!elderId && Array.isArray(req.auth.elderIds) && req.auth.elderIds.length) {
    elderId = req.auth.elderIds[0];
  }
  if (!elderId) throw badRequest('这台药箱还没有关联老人，无法发起求助');

  const elder = await S.assertElder(elderId, req.auth);
  const owner = await queryOne(
    'SELECT id FROM user WHERE family_id = ? ORDER BY FIELD(role,"owner","member","viewer") LIMIT 1',
    [elder.family_id]
  );
  const { insertId } = await exec(
    `INSERT INTO alert (elder_id, alert_type, level, content, channel, sent_to_user_id)
     VALUES (?,?,?,?,?,?)`,
    [elder.id, 'sos', 'urgent',
      `${elder.name} 按下了「我不舒服」，请立即联系确认。`,
      'web', owner ? owner.id : null]
  );
  // SOS 优先级最高：同时给设备排一条「立刻响铃 + 播报」，让现场也能被提醒
  await D.enqueueCommand(req.auth.box.id, {
    command: 'speak',
    params: { text: '已通知家人，请坐下休息，不要走动。', volume: 5 },
    priority: 1,
    ttlMin: 10,
    source: 'system',
  });
  res.json({ ok: true, alertId: insertId, command_queued: true, message: '已通知子女' });
}));

// ==================== 12. 录音清单 ====================

/** 方言录音下载地址（设备本地缓存后，即使断网也能播家人的声音） */
router.get('/recordings', wrap(async (req, res) => {
  const box = req.auth.box;
  const elders = await D.boxElders(box);
  if (!elders.length) return res.json([]);
  const rows = await query(
    `SELECT id, elder_id, schedule_id, title, audio_url, duration_sec, dialect, play_order
       FROM recording
      WHERE elder_id IN (${elders.map(() => '?').join(',')}) AND enabled = 1
      ORDER BY elder_id, play_order, id`,
    elders.map((e) => e.id)
  );
  const base = baseUrlOf(req);
  res.json(rows.map((r) => ({
    recording_id: Number(r.id),
    elder_id: Number(r.elder_id),
    schedule_id: r.schedule_id ? Number(r.schedule_id) : null,
    title: r.title,
    dialect: r.dialect,
    duration_sec: r.duration_sec,
    audio_url: D.absoluteUrl(base, r.audio_url),
    play_order: Number(r.play_order || 0),
  })));
}));

// ==================== 13. OTA 检查 ====================

/**
 * 查有没有新固件。
 *
 * 现在还没有真实固件包，这个接口先留着：只要往 device_firmware 表插一行，
 * 设备下一次检查就能收到升级信息，不需要改任何代码。
 * 比对规则：同型号下取 released_at 最新的一条；版本不同则提示升级。
 */
router.get('/firmware', wrap(async (req, res) => {
  const box = req.auth.box;
  const model = box.hardware_model || null;
  const current = box.firmware_version || null;
  if (!model) {
    return res.json({
      current,
      latest: null,
      need_update: false,
      message: '设备尚未上报 hardware_model，无法匹配固件；请在 handshake 的请求体里带上',
    });
  }
  const latest = await queryOne(
    `SELECT version, url, sha256, size_bytes, notes, is_mandatory, released_at
       FROM device_firmware WHERE hardware_model = ?
      ORDER BY released_at DESC, id DESC LIMIT 1`,
    [model]
  );
  if (!latest) {
    return res.json({
      current, latest: null, need_update: false,
      message: `型号 ${model} 暂无可用固件`,
    });
  }
  res.json({
    current,
    latest: {
      version: latest.version,
      url: latest.url,
      sha256: latest.sha256,
      size_bytes: latest.size_bytes,
      notes: latest.notes,
      is_mandatory: !!latest.is_mandatory,
      released_at: latest.released_at,
    },
    need_update: String(current || '') !== String(latest.version),
  });
}));

// ==================== 14. 设备日志 ====================

/**
 * 上传诊断日志。
 *
 * 真机装到老人家里以后，出问题只能靠设备自己把这些记录传上来 ——
 * 没有它，售后只能让家属把药箱寄回来。
 *
 * 请求体：
 *   { "logs": [ {level, event, message, at, context}, ... ] }   // 一次最多 100 条
 */
router.post('/logs', wrap(async (req, res) => {
  res.json(await D.saveLogs(req.auth.box, req.body || {}));
}));

/** 读取日志：设备自己也可以拉回来看（比如崩溃重启后确认上次记录到哪了） */
router.get('/logs', wrap(async (req, res) => {
  const rows = await D.readLogs(req.auth.box.id, req.query.limit);
  res.json(rows.map((r) => ({
    ...r,
    context: typeof r.context === 'string' ? safeParse(r.context) : r.context,
  })));
}));

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ==================== 15. 绑定说明（见文件开头的 GET /bind）====================

module.exports = router;
