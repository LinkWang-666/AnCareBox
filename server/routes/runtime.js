/**
 * 运行类接口：药箱上报、记录查询、告警处理、依从性看板
 *   POST /api/events            设备/模拟器上报一条事件
 *   GET  /api/events            服药记录查询
 *   GET  /api/events/today      今日概览（老人端用）
 *   GET  /api/alerts            告警列表
 *   PUT  /api/alerts/:id/handle 标记已处理
 *   GET  /api/dashboard/:elderId 依从性统计
 *
 * 鉴权改造后最要紧的一点：
 *   改造前任何人都能 POST /api/events 伪造「已服药」记录，
 *   一旦服药流水可伪造，漏服告警和依从性数据就全废了。
 *   现在：device 令牌的 device_code 强制取令牌里的值，传什么都不认。
 */
const express = require('express');
const { query, queryOne, exec } = require('../db');
const { wrap, badRequest, forbidden } = require('../services/http');
const A = require('../services/auth');
const S = require('../services/scope');
const { handleIntakeEvent, adherence } = require('../services/intake');
const Asst = require('../services/assistant');

const router = express.Router();

/**
 * 把前端传来的分页 / 天数参数收成一个安全的整数。
 *
 * 为什么不能直接 `LIMIT ${Number(limit)}`：
 *   传 ?limit=abc 得到 NaN，拼进 SQL 就是 `LIMIT NaN`，MySQL 直接语法报错；
 *   传 ?limit=999999 又会让一次查询把全表拖出来。两者都属于「前端随手一敲，
 *   后端就崩」的形态。这里统一收敛到 [1, max]，非法值退回默认值，
 *   既不会拼出语法错误，也不会被当成拖库入口。
 */
function safeInt(v, def, min, max) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

// ==================== 事件上报（药箱 / 模拟器调用） ====================
router.post('/events', A.requireAuth, wrap(async (req, res) => {
  const payload = { ...(req.body || {}) };

  if (req.auth.type === 'device') {
    // 设备令牌：设备身份以令牌为准，body 里传什么都覆盖掉，防止冒名上报
    payload.device_code = req.auth.box.device_code;
  } else {
    // 子女端调试/演示：允许指定药箱，但必须属于本家庭
    if (!payload.device_code) throw badRequest('device_code 必填');
    const box = await queryOne('SELECT * FROM medbox WHERE device_code = ?', [payload.device_code]);
    if (!box || box.family_id !== req.auth.familyId) throw forbidden('无权操作该药箱');
  }

  const out = await handleIntakeEvent(payload);
  res.json(out);
}));

// ==================== 服药记录查询 ====================
router.get('/events', A.requireAuth, wrap(async (req, res) => {
  const { elder_id, date, limit = 100 } = req.query;
  const where = [];
  const vals = [];

  if (elder_id) {
    await S.assertElder(elder_id, req.auth);
    where.push('e.elder_id = ?');
    vals.push(elder_id);
  } else if (req.auth.type === 'device') {
    where.push('e.elder_id = ?');
    vals.push(req.auth.elderId);
  } else {
    where.push('el.family_id = ?');
    vals.push(req.auth.familyId);
  }

  if (date) { where.push('DATE(e.occurred_at) = ?'); vals.push(date); }

  const rows = await query(
    `SELECT e.*, s.time_label, s.dose_time, c.slot_no, el.name AS elder_name
     FROM intake_event e
     LEFT JOIN schedule s ON e.schedule_id = s.id
     LEFT JOIN compartment c ON e.compartment_id = c.id
     LEFT JOIN elder el ON e.elder_id = el.id
     WHERE ${where.join(' AND ')}
     ORDER BY e.occurred_at DESC
     LIMIT ${safeInt(limit, 100, 1, 500)}`,
    vals
  );
  res.json(rows);
}));

/** 今日概览：老人端大屏用 */
router.get('/events/today', A.requireAuth, wrap(async (req, res) => {
  // 老人身份：device 令牌可在「关联老人集合」内指定（共用模式切换使用者），
  //           不传则用主老人；子女令牌需校验归属
  let elderId = req.query.elder_id;
  let elders = null; // 共用模式下返回可切换的使用者名单
  if (req.auth.type === 'device') {
    const ids = Array.isArray(req.auth.elderIds) && req.auth.elderIds.length
      ? req.auth.elderIds.map(Number) : [Number(req.auth.elderId)];
    const want = elderId ? Number(elderId) : Number(req.auth.elderId || ids[0]);
    if (!ids.includes(want)) throw forbidden('该老人不在这台药箱的关联名单里');
    elderId = want;
    if (ids.length > 1) {
      elders = await query(
        `SELECT id, name, gender FROM elder WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
        ids
      );
    }
  } else if (elderId) {
    await S.assertElder(elderId, req.auth);
  } else {
    // 未指定则取本家庭第一位老人
    const first = await queryOne(
      'SELECT id FROM elder WHERE family_id = ? ORDER BY id LIMIT 1', [req.auth.familyId]
    );
    if (!first) throw badRequest('该家庭还没有老人档案');
    elderId = first.id;
  }

  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const minutesNow = now.getHours() * 60 + now.getMinutes();

  const schedule = await queryOne(
    `SELECT s.*, c.slot_no
     FROM schedule s LEFT JOIN compartment c ON s.compartment_id = c.id
     WHERE s.elder_id = ? AND s.status = 'active'
     ORDER BY ABS(TIME_TO_SEC(TIMEDIFF(s.dose_time, ?))) LIMIT 1`,
    [elderId, hhmm + ':00']
  );

  let items = [];
  let recording = null;
  let inWindow = false;
  if (schedule) {
    // 是否处于「可服药窗口」内：[dose_time - 提前, dose_time + 延后]
    const toMin = (t) => { const p = String(t).split(':'); return Number(p[0]) * 60 + Number(p[1]); };
    const base = toMin(schedule.dose_time);
    const before = Number(schedule.window_before_min ?? 10);
    const after = Number(schedule.window_after_min ?? 30);
    inWindow = minutesNow >= base - before && minutesNow <= base + after;

    items = await query(
      `SELECT si.*, m.name AS medicine_name, m.unit, m.appearance
       FROM schedule_item si JOIN medicine m ON si.medicine_id = m.id
       WHERE si.schedule_id = ?`,
      [schedule.id]
    );
    // 取这一顿要播的录音：先找绑定到本时段的，没有才退回通用录音。
    // 末尾补 id：同一时段若绑了多条（play_order 都是默认 0），
    // 不写 id 时 MySQL 不保证顺序，同一个时段两次调班会播不同的录音。
    recording = await queryOne(
      `SELECT * FROM recording WHERE elder_id = ? AND enabled = 1
        AND (schedule_id = ? OR schedule_id IS NULL)
       ORDER BY schedule_id IS NULL, play_order, id LIMIT 1`,
      [elderId, schedule.id]
    );
  }

  const done = await queryOne(
    `SELECT COUNT(*) AS cnt FROM intake_event
     WHERE elder_id = ? AND DATE(occurred_at) = CURDATE()
       AND result IN ('on_time','early','late')`,
    [elderId]
  );
  const totalPlans = await queryOne(
    `SELECT COUNT(*) AS cnt FROM schedule WHERE elder_id = ? AND status = 'active'`,
    [elderId]
  );

  // 老人端大屏补充：老人称呼 + 全天计划（早/中/晚打卡用）+ 已完成的计划
  const elderRow = await queryOne(
    'SELECT id, name, gender FROM elder WHERE id = ?', [elderId]
  );
  const daySlots = await query(
    `SELECT id, dose_time, time_label FROM schedule
     WHERE elder_id = ? AND status = 'active' ORDER BY dose_time`,
    [elderId]
  );
  const doneSlots = await query(
    `SELECT DISTINCT schedule_id FROM intake_event
     WHERE elder_id = ? AND DATE(occurred_at) = CURDATE()
       AND schedule_id IS NOT NULL AND result IN ('on_time','early','late')`,
    [elderId]
  );

  res.json({
    now: hhmm,
    inWindow,
    elderId: Number(elderId),
    elderName: elderRow ? elderRow.name : '',
    gender: elderRow ? elderRow.gender : '',
    elders,                 // 共用模式：可切换的使用者列表（单人时为 null）
    schedule,
    items,
    recording,
    todayDone: Number(done.cnt),
    todayTotal: Number(totalPlans.cnt),
    daySlots,
    doneSlotIds: doneSlots.map((r) => Number(r.schedule_id)),
  });
}));

// ==================== 告警 ====================
router.get('/alerts', A.requireAuth, wrap(async (req, res) => {
  const { elder_id, is_read, limit = 50 } = req.query;
  const where = [];
  const vals = [];

  if (elder_id) {
    await S.assertElder(elder_id, req.auth);
    where.push('a.elder_id = ?');
    vals.push(elder_id);
  } else if (req.auth.type === 'device') {
    where.push('a.elder_id = ?');
    vals.push(req.auth.elderId);
  } else {
    where.push('el.family_id = ?');
    vals.push(req.auth.familyId);
  }

  if (is_read !== undefined) { where.push('a.is_read = ?'); vals.push(is_read); }

  const rows = await query(
    `SELECT a.*, el.name AS elder_name, u.real_name AS sent_to_name
     FROM alert a
     LEFT JOIN elder el ON a.elder_id = el.id
     LEFT JOIN user u ON a.sent_to_user_id = u.id
     WHERE ${where.join(' AND ')}
     ORDER BY a.created_at DESC
     LIMIT ${safeInt(limit, 50, 1, 500)}`,
    vals
  );
  res.json(rows);
}));

router.put('/alerts/:id/handle', A.requireAuth, wrap(async (req, res) => {
  await S.assertAlert(req.params.id, req.auth);
  await exec(
    'UPDATE alert SET is_read = 1, handled_at = NOW(), handle_note = ? WHERE id = ?',
    [req.body.handle_note || null, req.params.id]
  );
  res.json(await queryOne('SELECT * FROM alert WHERE id = ?', [req.params.id]));
}));

/** 一键全部标记已读 */
router.put('/alerts/read-all', A.requireAuth, wrap(async (req, res) => {
  const { elder_id } = req.body || {};
  const where = [];
  const vals = [];

  if (elder_id) {
    await S.assertElder(elder_id, req.auth);
    where.push('elder_id = ?');
    vals.push(elder_id);
  } else if (req.auth.type === 'device') {
    where.push('elder_id = ?');
    vals.push(req.auth.elderId);
  } else {
    // 只更新本家庭的告警：用子查询限定范围
    where.push(`elder_id IN (SELECT id FROM elder WHERE family_id = ?)`);
    vals.push(req.auth.familyId);
  }

  // 一并写 handled_at：批量处理也算「处理过」，后面的同类告警会进入静默期
  const r = await exec(
    `UPDATE alert SET is_read = 1, handled_at = NOW(),
            handle_note = COALESCE(handle_note, '批量处理')
      WHERE is_read = 0 AND ${where.join(' AND ')}`,
    vals
  );
  res.json({ ok: true, affected: r.affectedRows });
}));

// ==================== 老人端 SOS ====================
/**
 * 老人按下「我不舒服」，立刻通知子女
 * 改造前 elder_id 由前端任意传，可以被伪造成任何人求救；
 * 现在 device 令牌下强制取令牌里的老人，子女令牌下需校验归属。
 */
router.post('/sos', A.requireAuth, wrap(async (req, res) => {
  let elderId = req.body ? req.body.elder_id : null;

  if (req.auth.type === 'device') {
    // 一箱多老人：谁按的记谁（前端会带上当前使用者）；不传则记到主老人
    elderId = elderId || req.auth.elderId;
  }

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
  res.json({ ok: true, alertId: insertId, message: '已通知子女' });
}));

// ==================== 依从性看板 ====================
/**
 * 总览看板聚合接口（对照设计稿第 2 页）：
 *   stat        最近 N 天依从统计（原有）
 *   todayDone/  今日已完成 / 计划总数
 *   todayTotal
 *   streakDays  连续按时天数（今天没吃完不打断，从昨天往前数）
 *   prevWeekRate 上一个 7 天的依从率，前端算「较上周 ±x%」
 *   timeline[]  今日服药时间线：done 已按时 / current 解锁中 / overdue 超时未取 / upcoming 未到时间
 *   box         药箱在线状态（设备心跳）
 */
router.get('/dashboard/:elderId', A.requireAuth, wrap(async (req, res) => {
  const elder = await S.assertElder(req.params.elderId, req.auth);

  const days = safeInt(req.query.days, 7, 1, 90);   // 非法/越界一律收敛，避免 INTERVAL NaN 报错
  const stat = await adherence(elder.id, days);

  const unreadAlerts = await queryOne(
    'SELECT COUNT(*) AS cnt FROM alert WHERE elder_id = ? AND is_read = 0',
    [elder.id]
  );
  // 库存预警也要限定本家庭：不同家庭的药品不能混着看
  const lowStock = await query(
    'SELECT id, name, stock_qty, stock_alert_qty FROM medicine WHERE family_id = ? AND stock_qty <= stock_alert_qty',
    [req.auth.familyId]
  );

  // ---- 今日服药 X/Y ----
  const todayTotal = await queryOne(
    `SELECT COUNT(*) AS cnt FROM schedule WHERE elder_id = ? AND status = 'active'`,
    [elder.id]
  );
  const todayDone = await queryOne(
    `SELECT COUNT(DISTINCT schedule_id) AS cnt FROM intake_event
     WHERE elder_id = ? AND DATE(occurred_at) = CURDATE()
       AND schedule_id IS NOT NULL AND result IN ('on_time','early','late')`,
    [elder.id]
  );

  // ---- 连续按时天数 ----
  // 思路：从今天往回逐天看「当天完成数是否 >= 当天计划数」。
  // 今天还没吃完不扣分（不算断也不算连），从昨天开始数。
  const perDay = await query(
    `SELECT d, SUM(result IN ('on_time','early','late')) AS taken, COUNT(*) AS total FROM (
       SELECT DATE(e.occurred_at) AS d, e.result, e.elder_id
       FROM intake_event e
       WHERE e.elder_id = ? AND e.occurred_at >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
         AND e.schedule_id IS NOT NULL
     ) t GROUP BY d ORDER BY d DESC`,
    [elder.id]
  );
  const planCount = Number(todayTotal.cnt);
  let streakDays = 0;
  {
    const byDay = {};
    perDay.forEach((r) => { byDay[String(r.d)] = r; });
    const start = new Date();
    for (let i = 1; i <= 60; i++) {          // 从昨天开始
      const dt = new Date(start.getTime() - i * 86400000);
      const key = dt.getFullYear() + '-' +
        String(dt.getMonth() + 1).padStart(2, '0') + '-' +
        String(dt.getDate()).padStart(2, '0');
      const rec = byDay[key];
      // 当天无服药事件则视为无计划，跳过不断签
      if (!rec) continue;
      if (Number(rec.taken) >= planCount && planCount > 0) streakDays++;
      else break;
    }
  }

  // ---- 上周依从率（前 7 天） ----
  const prev = await adherence(elder.id, 14);
  // 用「本地日期字符串」判断属于前 7 天。
  // 不能用 toISOString()：它转 UTC，东八区凌晨 0-8 点会被算成前一天，
  // 导致「较上周」在早班时段偏移一天 —— 而 streakDays 那边用的是本地日期，
  // 同一页两个数字依据不同时区口径，对不上账时根本查不出来。
  const localDay = (msAgo) => {
    const dt = new Date(Date.now() - msAgo);
    return dt.getFullYear() + '-' +
      String(dt.getMonth() + 1).padStart(2, '0') + '-' +
      String(dt.getDate()).padStart(2, '0');
  };
  const dayKeys = [];
  for (let i = 7; i <= 13; i++) dayKeys.push(localDay(i * 86400000));
  const prevRows = (prev.daily || []).filter((r) => dayKeys.includes(String(r.d).slice(0, 10)));
  const pTotal = prevRows.reduce((a, r) => a + Number(r.total), 0);
  const pTaken = prevRows.reduce((a, r) => a + Number(r.taken), 0);
  const prevWeekRate = pTotal ? Math.round((pTaken / pTotal) * 1000) / 10 : 0;

  // ---- 今日时间线 ----
  const now = new Date();
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const toMin = (hhmmss) => {
    const [h, m] = String(hhmmss).split(':');
    return Number(h) * 60 + Number(m);
  };
  const schRows = await query(
    `SELECT s.id, s.dose_time, s.time_label, s.window_before_min, s.window_after_min,
            c.slot_no, c.label AS compartment_label
     FROM schedule s LEFT JOIN compartment c ON s.compartment_id = c.id
     WHERE s.elder_id = ? AND s.status = 'active'
     ORDER BY s.dose_time`,
    [elder.id]
  );
  const evToday = await query(
    `SELECT schedule_id, result, MAX(occurred_at) AS last_at
     FROM intake_event
     WHERE elder_id = ? AND DATE(occurred_at) = CURDATE() AND schedule_id IS NOT NULL
     GROUP BY schedule_id, result`,
    [elder.id]
  );
  const okEv = {};   // schedule_id -> 已完成
  const anyEv = {};  // schedule_id -> 最近一次事件
  evToday.forEach((r) => {
    if (!anyEv[r.schedule_id] || r.last_at > anyEv[r.schedule_id]) anyEv[r.schedule_id] = r.last_at;
    if (['on_time', 'early', 'late'].includes(r.result)) okEv[r.schedule_id] = r.last_at;
  });
  const schIds = schRows.map((s) => s.id);
  const itemRows = schIds.length ? await query(
    `SELECT si.schedule_id, si.dose_qty, si.note, m.name AS medicine_name, m.unit
     FROM schedule_item si JOIN medicine m ON si.medicine_id = m.id
     WHERE si.schedule_id IN (${schIds.map(() => '?').join(',')})`,
    schIds
  ) : [];

  const timeline = schRows.map((s) => {
    const start = toMin(s.dose_time) - Number(s.window_before_min ?? 10);
    const end = toMin(s.dose_time) + Number(s.window_after_min ?? 30);
    let status = 'upcoming';
    if (okEv[s.id]) status = 'done';
    else if (minutesNow >= start && minutesNow <= end) status = 'current';
    else if (minutesNow > end) status = 'overdue';
    return {
      id: s.id,
      dose_time: s.dose_time,
      time_label: s.time_label,
      slot_no: s.slot_no,
      compartment_label: s.compartment_label,
      status,                                        // done / current / overdue / upcoming
      takenAt: okEv[s.id] || null,
      items: itemRows.filter((i) => i.schedule_id === s.id),
    };
  });

  // ---- 药箱状态（走 medbox_elder 关联：老人可能与他人共用一台药箱） ----
  const box = await queryOne(
    `SELECT m.id, m.device_code, m.status, m.last_heartbeat_at
     FROM medbox m
     JOIN medbox_elder me ON me.medbox_id = m.id AND me.elder_id = ?
     LIMIT 1`,
    [elder.id]
  );
  // 「在线」= 设备自己报了在线，且心跳在 5 分钟内；
  // 心跳从未上报过的（种子数据）按 status 字段显示，不算离线
  if (box) {
    const fresh = !box.last_heartbeat_at ||
      (Date.now() - new Date(box.last_heartbeat_at).getTime()) < 5 * 60000;
    box.online = box.status === 'online' && fresh;

    // 设备离线（有心跳记录、但超过 5 分钟没心跳）→ 同步进告警中心（去重 + 静默期）
    if (box.status === 'online' && box.last_heartbeat_at && !fresh) {
      try {
        const snoozed = await Asst.alertSnoozed(elder.id, 'offline');
        if (!snoozed) {
          const owner = await queryOne(
            'SELECT id FROM user WHERE family_id = ? ORDER BY FIELD(role,"owner","member","viewer") LIMIT 1',
            [elder.family_id]
          );
          await exec(
            `INSERT INTO alert (elder_id, alert_type, level, content, channel, sent_to_user_id)
             VALUES (?,?,?,?,?,?)`,
            [elder.id, 'offline', 'warning',
             `${elder.name} 的药箱已离线（超过 5 分钟未收到心跳），请检查设备电源与网络。`,
             'web', owner ? owner.id : null]
          );
        }
      } catch (err) {
        console.warn('[runtime] 设备离线告警落库失败：', err.message);
      }
    }

    // 共用名单：这台药箱还服务哪些老人
    box.shared_elders = await query(
      `SELECT e.id, e.name FROM medbox_elder me
       JOIN elder e ON e.id = me.elder_id
       WHERE me.medbox_id = ? AND me.elder_id != ?
       ORDER BY me.is_primary DESC, e.id`,
      [box.id, elder.id]
    );
  }

  res.json({
    elder,
    ...stat,
    unreadAlerts: Number(unreadAlerts.cnt),
    lowStock,
    todayDone: Number(todayDone.cnt),
    todayTotal: Number(todayTotal.cnt),
    streakDays,
    prevWeekRate,
    timeline,
    box: box || null,
  });
}));

// ==================== 数据导出与删除 ====================
/**
 * 导出某位老人的「用药记录单」数据（老人档案 + 在服药品清单 + 服药记录流水）
 * 对应方案书 2.3「就诊带上用药单」：前端用这份数据生成可打印/存 PDF 的记录单
 */
router.get('/export/record/:elderId', A.requireAuth, wrap(async (req, res) => {
  const elder = await S.assertElder(req.params.elderId, req.auth);

  // 在服药品清单（按药名去重，带规格分类）
  const meds = await query(
    `SELECT m.name, m.spec, m.manufacturer, m.category, m.unit
     FROM schedule_item si
     JOIN medicine m ON si.medicine_id = m.id
     JOIN schedule s ON si.schedule_id = s.id
     WHERE s.elder_id = ? AND s.status = 'active'
     GROUP BY m.id
     ORDER BY m.name`,
    [elder.id]
  );

  // 服药记录流水（最近 500 条）
  const events = await query(
    `SELECT e.occurred_at, e.result, e.event_type, e.source,
            s.time_label, s.dose_time, c.slot_no
     FROM intake_event e
     LEFT JOIN schedule s ON e.schedule_id = s.id
     LEFT JOIN compartment c ON e.compartment_id = c.id
     WHERE e.elder_id = ?
     ORDER BY e.occurred_at DESC
     LIMIT 500`,
    [elder.id]
  );

  res.json({ elder, meds, events });
}));

/**
 * 导出本家庭全部数据（JSON，供用户下载存档，对应「数据可携带」）
 * 不含密码哈希等敏感字段，健康数据最小化
 *
 * 只面向子女端：device 令牌也能查出 familyId，但它的授权范围是「这台药箱关联的老人」，
 * 不是「整个家庭」。放开的话，任何一台绑定的药箱都能把全家的老人档案、药品、
 * 告警一次性拖走 —— 超出设备令牌的授权边界。
 */
router.get('/export/family-data', A.requireAuth, wrap(async (req, res) => {
  if (req.auth.type !== 'user') throw forbidden('数据导出仅面向子女端，设备令牌不可导出家庭数据');
  const f = req.auth.familyId;
  const [elders, medicines, medboxes, schedules, events, alerts] = await Promise.all([
    query('SELECT * FROM elder WHERE family_id = ? ORDER BY id', [f]),
    query('SELECT * FROM medicine WHERE family_id = ? ORDER BY id', [f]),
    query('SELECT * FROM medbox WHERE family_id = ? ORDER BY id', [f]),
    query('SELECT s.*, e.name AS elder_name FROM schedule s JOIN elder e ON s.elder_id = e.id WHERE e.family_id = ? ORDER BY s.id', [f]),
    query('SELECT e.* FROM intake_event e JOIN elder el ON e.elder_id = el.id WHERE el.family_id = ? ORDER BY e.id', [f]),
    query('SELECT a.* FROM alert a JOIN elder el ON a.elder_id = el.id WHERE el.family_id = ? ORDER BY a.id', [f]),
  ]);
  res.json({
    exportedAt: new Date().toISOString(),
    familyId: f,
    elders,
    medicines,
    medboxes,
    schedules,
    events,
    alerts,
  });
}));

/**
 * 删除本家庭的「历史数据」（服药记录 + 告警），保留基础配置（老人/药品/计划）
 * 对应方案书 2.9「一键删除」：仅 owner 可执行，前端做二次确认
 */
router.delete('/export/family-data', A.requireAuth, A.requireRole('owner'), wrap(async (req, res) => {
  const f = req.auth.familyId;
  await exec(
    `DELETE e FROM intake_event e
     JOIN elder el ON e.elder_id = el.id
     WHERE el.family_id = ?`,
    [f]
  );
  await exec(
    `DELETE a FROM alert a
     JOIN elder el ON a.elder_id = el.id
     WHERE el.family_id = ?`,
    [f]
  );
  res.json({ ok: true, message: '已删除本家庭的服药记录与告警数据' });
}));

module.exports = router;
