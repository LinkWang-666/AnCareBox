/**
 * 配置类接口：子女在 Web 端的全部增删改查
 *   /api/elders      老人档案 + 提醒策略
 *   /api/medbox      药箱设备 + 隔间
 *   /api/medicines   药品字典
 *   /api/schedules   服药计划 + 计划明细（items）
 *   /api/recordings  子女方言录音
 *
 * 改造要点（接入鉴权后）：
 *   1. 每个接口都挂了 requireAuth，未登录一律 401
 *   2. family_id 一律从令牌里取，不再相信前端传的值（原来是 b.family_id || 1，等于谁都能写进别人家）
 *   3. 带 id 的读写先查归属，不属于当前家庭一律 403
 *   4. 删除类操作限定 owner，viewer 只读
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const { query, queryOne, exec, pool } = require('../db');
const { wrap, badRequest, notFound, forbidden } = require('../services/http');
const A = require('../services/auth');
const S = require('../services/scope');
const D = require('../services/device');

const router = express.Router();

/** 录音文件存放目录 */
const AUDIO_DIR = path.join(__dirname, '..', '..', 'public', 'audio');

/** 写审计日志：记录「谁把什么改成了什么」，改错剂量时能追溯 */
async function audit(auth, action, targetType, targetId, before, after, req) {
  try {
    await exec(
      `INSERT INTO audit_log (user_id, family_id, action, target_type, target_id,
                              before_json, after_json, ip)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        auth.type === 'user' ? auth.userId : null,
        auth.familyId, action, targetType, targetId,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        req ? req.ip : null,
      ]
    );
  } catch (e) {
    // 审计写不进去也不能影响主流程，只打印
    console.warn('[audit] 写入失败：', e.message);
  }
}

/** 设备令牌：关联老人集合内的都可见；子女令牌看整个家庭 */
function elderCondition(auth) {
  if (auth.type === 'device') {
    const ids = Array.isArray(auth.elderIds) && auth.elderIds.length
      ? auth.elderIds : [auth.elderId];
    return { sql: `e.id IN (${ids.map(() => '?').join(',')})`, val: ids };
  }
  return { sql: 'e.family_id = ?', val: auth.familyId };
}

// ==================== 老人档案 ====================
router.get('/elders', A.requireAuth, wrap(async (req, res) => {
  const c = elderCondition(req.auth);
  // 一箱多老人：老人用哪台药箱走 medbox_elder 关联，聚合出设备编码与共用人数
  const rows = await query(
    `SELECT e.*,
            (SELECT GROUP_CONCAT(DISTINCT m.device_code ORDER BY m.device_code SEPARATOR ',')
               FROM medbox_elder me JOIN medbox m ON m.id = me.medbox_id
              WHERE me.elder_id = e.id) AS device_codes,
            (SELECT COUNT(DISTINCT me2.elder_id)
               FROM medbox_elder me2
              WHERE me2.medbox_id IN (SELECT medbox_id FROM medbox_elder WHERE elder_id = e.id)
            ) AS co_users
     FROM elder e
     WHERE ${c.sql}
     ORDER BY e.id`,
    Array.isArray(c.val) ? c.val : [c.val]
  );
  res.json(rows);
}));

router.get('/elders/:id', A.requireAuth, wrap(async (req, res) => {
  const elder = await S.assertElder(req.params.id, req.auth);
  res.json(elder);
}));

router.post('/elders', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body;
  if (!b.name) throw badRequest('姓名必填');

  const { insertId } = await exec(
    `INSERT INTO elder (family_id, name, gender, birth_date, age, hearing_level, vision_level,
                        chronic_diseases, allergies, remind_30m, remind_10m, remind_3m,
                        volume_level, speech_rate, repeat_times, timeout_minutes,
                        duplicate_window_minutes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      // 家庭归属强制取令牌里的值，前端传什么都不认
      req.auth.familyId, b.name, b.gender || null, b.birth_date || null, b.age || null,
      b.hearing_level || 'normal', b.vision_level || 'normal',
      b.chronic_diseases || null, b.allergies || null,
      b.remind_30m ? 1 : 0, b.remind_10m !== false ? 1 : 0, b.remind_3m !== false ? 1 : 0,
      b.volume_level || 3, b.speech_rate || 'slow', b.repeat_times || 2,
      b.timeout_minutes || 30, b.duplicate_window_minutes || 2,
    ]
  );
  const row = await queryOne('SELECT * FROM elder WHERE id = ?', [insertId]);
  await audit(req.auth, 'create', 'elder', insertId, null, row, req);
  res.json(row);
}));

router.put('/elders/:id', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body;
  await S.assertElder(req.params.id, req.auth);

  const allowed = ['name', 'gender', 'birth_date', 'age', 'hearing_level', 'vision_level',
    'chronic_diseases', 'allergies', 'remind_30m', 'remind_10m', 'remind_3m',
    'volume_level', 'speech_rate', 'repeat_times', 'timeout_minutes',
    'duplicate_window_minutes', 'status', 'sos_contact_user_id'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (b[k] !== undefined) { sets.push(`\`${k}\` = ?`); vals.push(b[k]); }
  }
  if (!sets.length) throw badRequest('没有要更新的字段');

  const before = await queryOne('SELECT * FROM elder WHERE id = ?', [req.params.id]);
  vals.push(req.params.id);
  await exec(`UPDATE elder SET ${sets.join(',')} WHERE id = ?`, vals);

  const after = await queryOne('SELECT * FROM elder WHERE id = ?', [req.params.id]);
  await audit(req.auth, 'update', 'elder', req.params.id, before, after, req);
  res.json(after);
}));

// 删除老人是高危操作，只允许 owner
router.delete('/elders/:id', A.requireAuth, A.requireRole('owner'), wrap(async (req, res) => {
  const before = await S.assertElder(req.params.id, req.auth);
  await exec('DELETE FROM elder WHERE id = ?', [req.params.id]);
  await audit(req.auth, 'delete', 'elder', req.params.id, before, null, req);
  res.json({ ok: true });
}));

// ==================== 药箱与隔间 ====================
router.get('/medbox', A.requireAuth, wrap(async (req, res) => {
  if (req.auth.type === 'device') {
    const box = await queryOne('SELECT * FROM medbox WHERE id = ?', [req.auth.deviceId]);
    if (!box) return res.json([]);
    // 附带关联老人，老人端切换使用者要用
    box.elders = await boxElders(box.id);
    box.status_detail = await deviceStatusOf(box.id);
    return res.json([box]);
  }
  const rows = await query(
    'SELECT * FROM medbox WHERE family_id = ? ORDER BY id', [req.auth.familyId]
  );
  for (const box of rows) {
    box.elders = await boxElders(box.id);
    box.status_detail = await deviceStatusOf(box.id);
  }
  res.json(rows);
}));

/**
 * 药箱最近一次运行的遥测（电量/信号/门磁/故障码）
 *
 * 没有实物药箱时这张表是空的，返回 null —— 前端据此显示「未接入设备」，
 * 而不是显示「电量 0%」把人吓一跳。
 */
async function deviceStatusOf(medboxId) {
  return queryOne('SELECT * FROM device_status WHERE medbox_id = ?', [medboxId]);
}

/** 查某台药箱关联的全部老人（medbox_elder + 主老人兜底） */
async function boxElders(medboxId) {
  return query(
    `SELECT me.elder_id, me.is_primary, e.name, e.gender
     FROM medbox_elder me JOIN elder e ON e.id = me.elder_id
     WHERE me.medbox_id = ?
     ORDER BY me.is_primary DESC, e.id`,
    [medboxId]
  );
}

/** 写入药箱-老人关联：第一位视为主老人，同步回 medbox.elder_id */
async function saveBoxElders(medboxId, familyId, elderIds) {
  const ids = [...new Set(elderIds.map(Number).filter(Boolean))];
  if (!ids.length) return;
  // 只允许关联本家庭的老人
  const placeholders = ids.map(() => '?').join(',');
  const valid = await query(
    `SELECT id FROM elder WHERE family_id = ? AND id IN (${placeholders})`,
    [familyId, ...ids]
  );
  const validIds = valid.map((r) => Number(r.id));
  if (!validIds.length) throw badRequest('关联老人不属于本家庭');

  await exec('DELETE FROM medbox_elder WHERE medbox_id = ?', [medboxId]);
  for (let i = 0; i < validIds.length; i++) {
    await exec(
      'INSERT INTO medbox_elder (medbox_id, elder_id, is_primary) VALUES (?,?,?)',
      [medboxId, validIds[i], i === 0 ? 1 : 0]
    );
  }
  // 主老人同步回 medbox.elder_id，兼容旧逻辑（上报兜底归属等）
  await exec('UPDATE medbox SET elder_id = ? WHERE id = ?', [validIds[0], medboxId]);
}

router.post('/medbox', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body;
  if (!b.device_code) throw badRequest('device_code 必填');

  // 一箱多老人：elder_ids 数组（第一位为主老人）；兼容旧的 elder_id 单值
  const elderIds = Array.isArray(b.elder_ids) && b.elder_ids.length
    ? b.elder_ids
    : (b.elder_id ? [b.elder_id] : []);

  let insertId;
  try {
    const r = await exec(
      `INSERT INTO medbox (family_id, elder_id, device_code, compartment_count, status)
       VALUES (?,?,?,?,'offline')`,
      [req.auth.familyId, elderIds[0] || null, b.device_code, b.compartment_count || 7]
    );
    insertId = r.insertId;
  } catch (e) {
    // device_code 上有唯一索引。直接抛出去会变成 500「服务内部异常」，
    // 用户看到一个红条，却不知道是自己把设备编号填重复了。
    if (e.errno === 1062 || e.code === 'ER_DUP_ENTRY') {
      throw badRequest(`设备编号「${b.device_code}」已被其他药箱占用（同一台药箱不能重复添加）`);
    }
    throw e;
  }

  // 同时创建对应数量的隔间
  for (let i = 1; i <= (b.compartment_count || 7); i++) {
    await exec(
      'INSERT INTO compartment (medbox_id, slot_no, label, is_locked) VALUES (?,?,?,1)',
      [insertId, i, `第${i}格`]
    );
  }
  if (elderIds.length) await saveBoxElders(insertId, req.auth.familyId, elderIds);

  const row = await queryOne('SELECT * FROM medbox WHERE id = ?', [insertId]);
  row.elders = await boxElders(insertId);
  await audit(req.auth, 'create', 'medbox', insertId, null, row, req);
  res.json(row);
}));

/** 设置药箱的共用老人（全量覆盖：传几位就关联几位，第一位为主老人） */
router.put('/medbox/:id/elders', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  await S.assertMedbox(req.params.id, req.auth);
  const b = req.body || {};
  if (!Array.isArray(b.elder_ids)) throw badRequest('elder_ids 必须是数组');

  const before = await queryOne('SELECT * FROM medbox WHERE id = ?', [req.params.id]);
  await saveBoxElders(Number(req.params.id), req.auth.familyId, b.elder_ids);
  const after = await queryOne('SELECT * FROM medbox WHERE id = ?', [req.params.id]);
  after.elders = await boxElders(after.id);
  await audit(req.auth, 'update', 'medbox', req.params.id,
    { elder_id: before.elder_id }, { elder_id: after.elder_id, elders: after.elders }, req);
  res.json(after);
}));

// ==================== 远程指令下发（子女 → 药箱） ====================
/**
 * 给药箱排一条指令：响铃提醒 / 亮灯 / 开某一格 / 播一段话 / 找设备。
 *
 * 为什么是「排队」而不是「直推」：
 *   药箱是电池设备，网络时好时坏。排进队列后，设备下次心跳（≤60 秒）
 *   就把指令取走；即使那一刻正好断网，指令也只是等着，不会丢。
 *
 * 几个必须在这里挡住的东西：
 *   slot_no 必须属于这台药箱 —— 否则能隔空打开别人家的药格；
 *   seconds 收敛到 1~120 —— 免得一条指令让蜂鸣器响一整夜；
 *   text 限长 200 字 —— 设备喇叭只能念这么长，超了会被截断成半句。
 */
router.post('/medbox/:id/commands', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const box = await S.assertMedbox(req.params.id, req.auth);
  const b = req.body || {};

  const command = String(b.command || '').trim();
  if (!D.VALID_COMMANDS.includes(command)) {
    throw badRequest(`command 不合法，可选值：${D.VALID_COMMANDS.join(' / ')}`);
  }

  const params = {};
  if (b.params && typeof b.params === 'object') Object.assign(params, b.params);

  if (params.slot_no !== undefined) {
    const slotNo = Number(params.slot_no);
    if (!Number.isFinite(slotNo)) throw badRequest('params.slot_no 必须是数字');
    const comp = await queryOne(
      'SELECT id FROM compartment WHERE medbox_id = ? AND slot_no = ?', [box.id, slotNo]
    );
    if (!comp) throw badRequest(`这台药箱没有第 ${slotNo} 格`);
    params.slot_no = slotNo;
  }
  if (['unlock', 'lock'].includes(command) && params.slot_no === undefined) {
    throw badRequest(`${command} 指令必须指定 params.slot_no`);
  }
  if (params.seconds !== undefined) {
    params.seconds = Math.min(120, Math.max(1, Number(params.seconds) || 10));
  }
  if (params.text !== undefined) {
    params.text = String(params.text).slice(0, 200);
  }
  if (command === 'speak' && !params.text) {
    throw badRequest('speak 指令必须带 params.text');
  }

  const row = await D.enqueueCommand(box.id, {
    command,
    params,
    priority: b.priority,
    ttlMin: b.ttl_min,
    createdBy: req.auth.type === 'user' ? req.auth.userId : null,
    source: 'user',
  });
  await audit(req.auth, 'command', 'medbox', box.id, null, { command, params }, req);
  res.json({
    ok: true,
    command: row,
    message: '指令已排队，药箱下次心跳（最长约 60 秒）会取走执行',
  });
}));

/** 指令历史与执行状态：子女能确认「我按的那次响铃到底有没有响」 */
router.get('/medbox/:id/commands', A.requireAuth, wrap(async (req, res) => {
  const box = await S.assertMedbox(req.params.id, req.auth);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const rows = await query(
    `SELECT c.*, u.real_name AS created_by_name
       FROM device_command c
       LEFT JOIN user u ON u.id = c.created_by
      WHERE c.medbox_id = ? ORDER BY c.id DESC LIMIT ${limit}`,
    [box.id]
  );
  res.json(rows);
}));

router.get('/medbox/:id/compartments', A.requireAuth, wrap(async (req, res) => {
  await S.assertMedbox(req.params.id, req.auth);
  // 一箱多老人：顺带标出每一格被哪位老人的计划占用
  const rows = await query(
    `SELECT c.*, s.id AS schedule_id, s.dose_time, s.time_label,
            s.elder_id, el.name AS elder_name
     FROM compartment c
     LEFT JOIN schedule s ON s.compartment_id = c.id AND s.status = 'active'
     LEFT JOIN elder el ON el.id = s.elder_id
     WHERE c.medbox_id = ? ORDER BY c.slot_no`,
    [req.params.id]
  );
  res.json(rows);
}));

/**
 * 装药清单：每格放哪位老人的哪几种药、各几片（对应方案书 6.1.3）
 * 与 /compartments 的区别：这里把 schedule_item 的药品明细一并 JOIN 出来，
 * 子女照着这张单子把药分装进格子，装错格就等于吃错药。
 */
router.get('/medbox/:id/load-list', A.requireAuth, wrap(async (req, res) => {
  await S.assertMedbox(req.params.id, req.auth);
  const rows = await query(
    `SELECT c.id AS compartment_id, c.slot_no, c.label AS compartment_label,
            s.id AS schedule_id, s.dose_time, s.time_label, s.elder_id,
            e.name AS elder_name,
            m.id AS medicine_id, m.name AS medicine_name, m.unit, m.stock_qty,
            si.dose_qty
     FROM compartment c
     LEFT JOIN schedule s ON s.compartment_id = c.id AND s.status = 'active'
     LEFT JOIN elder e ON e.id = s.elder_id
     LEFT JOIN schedule_item si ON si.schedule_id = s.id
     LEFT JOIN medicine m ON m.id = si.medicine_id
     WHERE c.medbox_id = ?
     ORDER BY c.slot_no, m.name`,
    [req.params.id]
  );
  res.json(rows);
}));

router.put('/compartments/:id', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body;
  await S.assertCompartment(req.params.id, req.auth);

  const sets = [];
  const vals = [];
  for (const k of ['label', 'is_locked']) {
    if (b[k] !== undefined) { sets.push(`\`${k}\` = ?`); vals.push(b[k]); }
  }
  if (!sets.length) throw badRequest('没有要更新的字段');

  const before = await queryOne('SELECT * FROM compartment WHERE id = ?', [req.params.id]);
  vals.push(req.params.id);
  await exec(`UPDATE compartment SET ${sets.join(',')} WHERE id = ?`, vals);

  const after = await queryOne('SELECT * FROM compartment WHERE id = ?', [req.params.id]);
  await audit(req.auth, 'update', 'compartment', req.params.id, before, after, req);
  res.json(after);
}));

// ==================== 药品 ====================
router.get('/medicines', A.requireAuth, wrap(async (req, res) => {
  const rows = await query(
    'SELECT * FROM medicine WHERE family_id = ? ORDER BY status, id',
    [req.auth.familyId]
  );
  res.json(rows);
}));

router.post('/medicines', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body;
  if (!b.name) throw badRequest('药品名称必填');

  const { insertId } = await exec(
    `INSERT INTO medicine (family_id, name, spec, manufacturer, unit, appearance,
                           stock_qty, stock_alert_qty, expiry_date, category,
                           contraindication, active_ingredient, barcode)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.auth.familyId, b.name, b.spec || null, b.manufacturer || null,
     b.unit || '片', b.appearance || null,
     b.stock_qty || 0, b.stock_alert_qty || 7,
     b.expiry_date || null, b.category || null, b.contraindication || null,
     b.active_ingredient || null, b.barcode || null]
  );
  const row = await queryOne('SELECT * FROM medicine WHERE id = ?', [insertId]);
  await audit(req.auth, 'create', 'medicine', insertId, null, row, req);
  res.json(row);
}));

router.put('/medicines/:id', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body;
  await S.assertMedicine(req.params.id, req.auth);

  const allowed = ['name', 'spec', 'manufacturer', 'unit', 'appearance',
    'stock_qty', 'stock_alert_qty', 'expiry_date', 'category', 'contraindication',
    'active_ingredient', 'barcode', 'status'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (b[k] !== undefined) { sets.push(`\`${k}\` = ?`); vals.push(b[k]); }
  }
  if (!sets.length) throw badRequest('没有要更新的字段');

  const before = await queryOne('SELECT * FROM medicine WHERE id = ?', [req.params.id]);
  vals.push(req.params.id);
  await exec(`UPDATE medicine SET ${sets.join(',')} WHERE id = ?`, vals);

  const after = await queryOne('SELECT * FROM medicine WHERE id = ?', [req.params.id]);
  await audit(req.auth, 'update', 'medicine', req.params.id, before, after, req);
  res.json(after);
}));

// 删除药品：owner 或 member（照护成员）可删；viewer 只读
router.delete('/medicines/:id', A.requireAuth, A.requireRole('owner', 'member'), wrap(async (req, res) => {
  const before = await S.assertMedicine(req.params.id, req.auth);
  // 过期药可直接清理：先解除其服药计划引用，避免外键 RESTRICT 导致「过期药删不掉」
  const expired = !!before.expiry_date && Date.parse(String(before.expiry_date)) < Date.now();
  try {
    if (expired) {
      await exec('DELETE FROM schedule_item WHERE medicine_id = ?', [req.params.id]);
    }
    await exec('DELETE FROM medicine WHERE id = ?', [req.params.id]);
  } catch (e) {
    // 外键 RESTRICT（errno 1451）：药品仍被服药计划引用（未过期）
    if (e.errno === 1451 || e.code === 'ER_ROW_IS_REFERENCED_2') {
      throw badRequest('该药品已被服药计划引用，请先把用药计划里的这种药移除，再删除药品');
    }
    throw e;
  }
  await audit(req.auth, 'delete', 'medicine', req.params.id, before, null, req);
  res.json({ ok: true });
}));

// ==================== 服药计划 ====================

/**
 * 校验「这个隔间能不能装这位老人的药」。
 *
 * 为什么光校验隔间属于本家庭还不够：
 *   compartment_id 是前端下拉传上来的。外键只保证这个隔间存在，
 *   不保证它和这位老人有关系。若允许随便绑，会出现两种脏数据：
 *     a) 王家老人的计划挂到李家的隔间上 —— 到点李家老人的开箱会被判成王家服药；
 *     b) 挂到本家庭另一台药箱的隔间上 —— 老人开自己箱子，计划却记在另一台。
 *   两者都只在「到点那一刻」才暴露，界面上完全看不出来。
 *   所以这里一次校验两层：隔间归属（assertCompartment 已含家庭/设备判断）
 *   + 该隔间所属药箱确实关联着这位老人。
 */
async function assertCompartmentForElder(compartmentId, elderId, auth) {
  if (compartmentId === null || compartmentId === undefined || compartmentId === '') return null;
  const c = await S.assertCompartment(compartmentId, auth);
  if (elderId) {
    const link = await queryOne(
      'SELECT 1 AS ok FROM medbox_elder WHERE medbox_id = ? AND elder_id = ? LIMIT 1',
      [c.medbox_id, elderId]
    );
    if (!link) throw badRequest('该隔间所属药箱没有关联这位老人，请先在「药箱」里把老人加进去');
  }
  return c;
}

router.get('/schedules', A.requireAuth, wrap(async (req, res) => {
  const { elder_id } = req.query;
  const vals = [];
  let where;

  if (elder_id) {
    await S.assertElder(elder_id, req.auth);
    where = 's.elder_id = ?';
    vals.push(elder_id);
  } else if (req.auth.type === 'device') {
    where = 's.elder_id = ?';
    vals.push(req.auth.elderId);
  } else {
    where = 'e.family_id = ?';
    vals.push(req.auth.familyId);
  }

  const rows = await query(
    // 注意：elder 表这里必须用别名 e —— 上面家庭过滤条件写的是 e.family_id。
    // 曾经这里写成 el，导致「查全部计划」时 MySQL 报 Unknown column 'e.family_id'，
    // 页面首屏直接弹红色错误条。改别名请连同上面的 where 一起改。
    `SELECT s.*, c.slot_no, c.label AS compartment_label, e.name AS elder_name
     FROM schedule s
     JOIN elder e ON s.elder_id = e.id
     LEFT JOIN compartment c ON s.compartment_id = c.id
     WHERE ${where}
     ORDER BY s.dose_time`,
    vals
  );
  res.json(rows);
}));

/** 计划详情：带上明细（药品名 + 剂量） */
router.get('/schedules/:id', A.requireAuth, wrap(async (req, res) => {
  const s = await S.assertSchedule(req.params.id, req.auth);
  s.items = await query(
    `SELECT si.*, m.name AS medicine_name, m.unit, m.stock_qty
     FROM schedule_item si JOIN medicine m ON si.medicine_id = m.id
     WHERE si.schedule_id = ?`,
    [req.params.id]
  );
  res.json(s);
}));

/** 新增计划（可同时带 items，用事务保证一致） */
router.post('/schedules', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body;
  if (!b.elder_id) throw badRequest('elder_id 必填');
  if (!b.dose_time) throw badRequest('服药时间必填');

  // 关键：确认这位老人属于当前家庭
  await S.assertElder(b.elder_id, req.auth);
  // 隔间若指定，必须属于本家庭、且该药箱确实服务这位老人
  await assertCompartmentForElder(b.compartment_id, b.elder_id, req.auth);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute(
      `INSERT INTO schedule (elder_id, compartment_id, dose_time, time_label,
                             window_before_min, window_after_min)
       VALUES (?,?,?,?,?,?)`,
      // 注意这里用 ?? 而不是 ||：时间窗允许填 0（比如「只许晚到不许早取」），
      // 用 || 会把 0 当成「没填」替换成默认值，用户设的规则被悄悄改掉。
      [b.elder_id, b.compartment_id || null, b.dose_time, b.time_label || null,
       b.window_before_min ?? 10, b.window_after_min ?? 30]
    );
    const scheduleId = r.insertId;

    for (const it of b.items || []) {
      // 明细里的药品也必须属于本家庭
      await S.assertMedicine(it.medicine_id, req.auth);
      await conn.execute(
        'INSERT INTO schedule_item (schedule_id, medicine_id, dose_qty, note) VALUES (?,?,?,?)',
        [scheduleId, it.medicine_id, it.dose_qty || 1, it.note || null]
      );
    }
    await conn.commit();

    const row = await queryOne('SELECT * FROM schedule WHERE id = ?', [scheduleId]);
    await audit(req.auth, 'create', 'schedule', scheduleId, null, { ...row, items: b.items }, req);
    res.json(row);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}));

router.put('/schedules/:id', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body;
  const plan = await S.assertSchedule(req.params.id, req.auth);
  // 改隔间同样要过归属校验，否则「改一下计划」就能把隔间换到别人家的药箱上
  if (b.compartment_id !== undefined) {
    await assertCompartmentForElder(b.compartment_id, plan.elder_id, req.auth);
  }

  const allowed = ['compartment_id', 'dose_time', 'time_label',
    'window_before_min', 'window_after_min', 'status'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (b[k] !== undefined) { sets.push(`\`${k}\` = ?`); vals.push(b[k]); }
  }

  const before = await queryOne('SELECT * FROM schedule WHERE id = ?', [req.params.id]);

  if (sets.length) {
    vals.push(req.params.id);
    await exec(`UPDATE schedule SET ${sets.join(',')} WHERE id = ?`, vals);
  }

  // 若传了 items，则整体替换明细
  if (Array.isArray(b.items)) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('DELETE FROM schedule_item WHERE schedule_id = ?', [req.params.id]);
      for (const it of b.items) {
        await S.assertMedicine(it.medicine_id, req.auth);
        await conn.execute(
          'INSERT INTO schedule_item (schedule_id, medicine_id, dose_qty, note) VALUES (?,?,?,?)',
          [req.params.id, it.medicine_id, it.dose_qty || 1, it.note || null]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  const after = await queryOne('SELECT * FROM schedule WHERE id = ?', [req.params.id]);
  await audit(req.auth, 'update', 'schedule', req.params.id, before, after, req);
  res.json(after);
}));

router.delete('/schedules/:id', A.requireAuth, A.requireRole('owner'), wrap(async (req, res) => {
  const before = await S.assertSchedule(req.params.id, req.auth);
  await exec('DELETE FROM schedule WHERE id = ?', [req.params.id]); // 明细随外键 CASCADE 删除
  await audit(req.auth, 'delete', 'schedule', req.params.id, before, null, req);
  res.json({ ok: true });
}));

// ==================== 子女方言录音 ====================
/**
 * 校验时段归属：录音只能绑到「这位老人自己的」时段上。
 *
 * 为什么后端必须查一遍：
 *   schedule_id 是前端下拉传上来的。外键只保证这个时段存在，
 *   不保证它属于同一位老人。传错一个 id，就会把 A 的录音挂到 B 的时间点上，
 *   到点时把别人的声音播给错的人听 —— 这种错在界面上完全看不出来，
 *   只有后端挡住才不会留成脏数据。
 */
async function assertSlotOfElder(scheduleId, elderId) {
  const row = await queryOne(
    'SELECT id FROM schedule WHERE id = ? AND elder_id = ?',
    [scheduleId, elderId]
  );
  if (!row) throw badRequest('该时段不属于这位老人，请重新选择');
}

router.get('/recordings', A.requireAuth, wrap(async (req, res) => {
  const { elder_id } = req.query;
  const vals = [];
  let where;

  if (elder_id) {
    await S.assertElder(elder_id, req.auth);
    where = 'r.elder_id = ?';
    vals.push(elder_id);
  } else if (req.auth.type === 'device') {
    where = 'r.elder_id = ?';
    vals.push(req.auth.elderId);
  } else {
    where = 'e.family_id = ?';
    vals.push(req.auth.familyId);
  }

  const rows = await query(
    `SELECT r.* FROM recording r JOIN elder e ON r.elder_id = e.id
     WHERE ${where} ORDER BY r.play_order, r.id`,
    vals
  );
  res.json(rows);
}));

router.post('/recordings', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body;
  if (!b.elder_id || !b.title || !b.audio_url) throw badRequest('elder_id / title / audio_url 必填');
  await S.assertElder(b.elder_id, req.auth);
  if (b.schedule_id) await assertSlotOfElder(b.schedule_id, b.elder_id);

  const { insertId } = await exec(
    `INSERT INTO recording (elder_id, schedule_id, title, audio_url, duration_sec,
                            dialect, play_order, is_birthday_egg, enabled)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [b.elder_id, b.schedule_id || null, b.title, b.audio_url, b.duration_sec || null,
     b.dialect || null, b.play_order || 0, b.is_birthday_egg ? 1 : 0, b.enabled !== false ? 1 : 0]
  );
  const row = await queryOne('SELECT * FROM recording WHERE id = ?', [insertId]);
  await audit(req.auth, 'create', 'recording', insertId, null, row, req);
  res.json(row);
}));

router.put('/recordings/:id', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body;
  // assertRecording 顺带把这条录音查出来了，后面当审计的 before 用，不再重复查一次
  const before = await S.assertRecording(req.params.id, req.auth);

  // 前端下拉选「通用」时传空串，统一转成 NULL —— 表里 NULL 才是「不限时段」的判据
  if (b.schedule_id === '') b.schedule_id = null;
  if (b.schedule_id !== undefined && b.schedule_id !== null) {
    await assertSlotOfElder(b.schedule_id, before.elder_id);
  }

  const allowed = ['title', 'audio_url', 'schedule_id', 'dialect', 'play_order',
    'is_birthday_egg', 'enabled', 'duration_sec'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (b[k] !== undefined) { sets.push(`\`${k}\` = ?`); vals.push(b[k]); }
  }
  if (!sets.length) throw badRequest('没有要更新的字段');

  vals.push(req.params.id);
  await exec(`UPDATE recording SET ${sets.join(',')} WHERE id = ?`, vals);

  // 一个时段只留一段录音：绑上新的，就把原来绑在这一段那条放回「通用」。
  //
  // 为什么必须互斥：到点只播一条，多条绑同一时段时由 play_order 决定播谁。
  // 这个顺序用户既看不见也改不了，典型后果是「刚绑的那条不响，响的是旧的」，
  // 而界面上两条都显示着绑在这一顿，根本看不出问题。
  // 想两条都留着、只是不参与播放，显式传 exclusive:false 可以跳过这段。
  let unbound = 0;
  if (b.schedule_id !== undefined && b.schedule_id !== null && b.exclusive !== false) {
    const r = await exec(
      'UPDATE recording SET schedule_id = NULL WHERE elder_id = ? AND schedule_id = ? AND id <> ?',
      [before.elder_id, b.schedule_id, req.params.id]
    );
    unbound = r.affectedRows;
  }

  const after = await queryOne('SELECT * FROM recording WHERE id = ?', [req.params.id]);
  await audit(req.auth, 'update', 'recording', req.params.id, before, after, req);
  // unbound 告诉前端「顺手解开了几条」，用来提示用户原来那条已放回通用
  res.json(Object.assign({}, after, { unbound }));
}));

router.delete('/recordings/:id', A.requireAuth, A.requireRole('owner'), wrap(async (req, res) => {
  const before = await S.assertRecording(req.params.id, req.auth);
  await exec('DELETE FROM recording WHERE id = ?', [req.params.id]);
  await audit(req.auth, 'delete', 'recording', req.params.id, before, null, req);
  res.json({ ok: true });
}));

/**
 * 录音上传：前端 MediaRecorder 录完后把音频转成 base64 发过来
 * 后端落盘到 public/audio/ 并返回可访问 URL
 *
 * 这里有两个必须自己兜住的坑，外键和参数校验都管不到：
 *
 * 1) 文件名后缀不能听客户端的。
 *    原先直接 `rec_${Date.now()}.${ext}` 拼路径，ext 传 '../../server/x.js'
 *    就能把文件写到项目里任意位置（path.join 会把 .. 折叠掉），
 *    等于开放了任意文件写入，重启一次就是任意代码执行。现在走白名单 + basename。
 *
 * 2) 文件名不能可猜。
 *    静态目录是公开的，谁都能 GET。若用 rec_<时间戳> 这种规律名，
 *    别人按毫秒枚举就能下载到别人家的方言录音。加随机串后不可枚举。
 */
const SAFE_AUDIO_EXT = new Set(['webm', 'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'aac', 'opus']);
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

router.post('/recordings/upload', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const { base64, ext = 'webm' } = req.body || {};
  if (!base64) throw badRequest('缺少 base64 音频数据');

  const matches = String(base64).match(/^data:([^;]+);base64,(.*)$/);
  const pure = matches ? matches[2] : String(base64);
  if (!pure) throw badRequest('base64 格式不正确');

  // 只取最后一段并去点，'../../x' → 'x'，'a/b.mp3' → 'b.mp3'
  const rawExt = path.basename(String(ext || 'webm')).replace(/^\.+/, '').toLowerCase().trim();
  const safeExt = SAFE_AUDIO_EXT.has(rawExt) ? rawExt : 'webm';

  const buf = Buffer.from(pure, 'base64');
  if (!buf.length) throw badRequest('音频内容为空');
  if (buf.length > MAX_AUDIO_BYTES) {
    throw badRequest(`录音文件过大（${(buf.length / 1024 / 1024).toFixed(1)}MB），请控制在 8MB 以内`);
  }

  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

  const filename = `rec_${Date.now()}_${randomBytes(8).toString('hex')}.${safeExt}`;
  const target = path.join(AUDIO_DIR, filename);
  // 双保险：即便上面的清洗被绕过，也确保落点仍在 audio 目录内
  if (path.dirname(target) !== path.resolve(AUDIO_DIR)) throw badRequest('非法的文件名');

  fs.writeFileSync(target, buf);

  res.json({ ok: true, url: `/audio/${filename}`, filename });
}));

// ==================== 家庭成员管理 ====================
// 队友 UI 的「家庭成员」页：列出照护成员、邀请新成员、改角色、改告警订阅、移除成员

/** 列出家庭成员（含每人关联的老人数与订阅偏好） */
router.get('/users', A.requireAuth, wrap(async (req, res) => {
  const rows = await query(
    `SELECT u.id, u.username, u.real_name, u.phone, u.role, u.push_enabled,
            u.alert_prefs, u.created_at,
            (SELECT COUNT(*) FROM elder e WHERE e.family_id = u.family_id) AS elder_count
     FROM user u
     WHERE u.family_id = ?
     ORDER BY FIELD(u.role,'owner','member','viewer'), u.id`,
    [req.auth.familyId]
  );
  // 家庭成员一律不返回密码哈希，也不返回 token_version 等敏感字段
  res.json(rows.map(({ password_hash, token_version, ...rest }) => rest));
}));

/** 邀请 / 新增家庭成员（owner / member 可邀请；新成员默认 member） */
router.post('/users', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.username) throw badRequest('账号必填');
  if (!b.password) throw badRequest('初始密码必填');
  if (String(b.password).length < 6) throw badRequest('密码至少 6 位');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(b.username)) throw badRequest('账号只能是 3-20 位字母、数字或下划线');
  if (await queryOne('SELECT id FROM user WHERE username = ?', [b.username])) {
    throw badRequest('该账号已被注册');
  }
  // 角色只能是 member 或 viewer（owner 只能有一个）
  const role = b.role === 'viewer' ? 'viewer' : 'member';

  const { insertId } = await exec(
    `INSERT INTO user (family_id, username, password_hash, real_name, phone, role, push_enabled, alert_prefs)
     VALUES (?,?,?,?,?,?,?,?)`,
    [req.auth.familyId, b.username, A.hashPassword(b.password),
     b.real_name || b.username, b.phone || null, role,
     b.push_enabled === 0 ? 0 : 1,
     b.alert_prefs ? String(b.alert_prefs) : null]
  );
  const row = await queryOne('SELECT id, username, real_name, phone, role, push_enabled, alert_prefs, created_at FROM user WHERE id = ?', [insertId]);
  await audit(req.auth, 'create', 'user', insertId, null, row, req);
  res.json(row);
}));

/** 修改成员：角色、姓名、推送开关、告警订阅（owner 可改一切，member 只能改自己） */
router.put('/users/:id', A.requireAuth, A.requireWritable, wrap(async (req, res) => {
  const targetId = Number(req.params.id);
  const target = await queryOne('SELECT * FROM user WHERE id = ? AND family_id = ?', [targetId, req.auth.familyId]);
  if (!target) throw notFound('该成员不存在或不属于当前家庭');

  // member 不能改别人，只能改自己（且不能给自己提权）
  if (req.auth.role === 'member' && targetId !== req.auth.userId) {
    throw forbidden('只能修改自己的信息');
  }

  const b = req.body || {};
  const allowed = ['real_name', 'phone', 'push_enabled', 'alert_prefs'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (b[k] !== undefined) { sets.push(`\`${k}\` = ?`); vals.push(b[k]); }
  }
  // 改角色：仅 owner 能改，且不能把唯一的 owner 降级
  if (b.role !== undefined && b.role !== target.role) {
    if (req.auth.role !== 'owner') throw forbidden('只有主配置人能改角色');
    if (!['owner', 'member', 'viewer'].includes(b.role)) throw badRequest('角色不合法');
    if (target.role === 'owner' && b.role !== 'owner') {
      throw badRequest('不能降级唯一的家庭主配置人');
    }
    sets.push('`role` = ?'); vals.push(b.role);
  }
  if (!sets.length) throw badRequest('没有要更新的字段');

  vals.push(targetId);
  await exec(`UPDATE user SET ${sets.join(',')} WHERE id = ?`, vals);
  const after = await queryOne('SELECT id, username, real_name, phone, role, push_enabled, alert_prefs, created_at FROM user WHERE id = ?', [targetId]);
  await audit(req.auth, 'update', 'user', targetId, target, after, req);
  res.json(after);
}));

/** 移除成员（仅 owner，且不能移除自己） */
router.delete('/users/:id', A.requireAuth, A.requireRole('owner'), wrap(async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.auth.userId) throw badRequest('不能移除自己');
  const target = await queryOne('SELECT * FROM user WHERE id = ? AND family_id = ?', [targetId, req.auth.familyId]);
  if (!target) throw notFound('该成员不存在或不属于当前家庭');
  if (target.role === 'owner') throw badRequest('不能移除家庭主配置人');

  await exec('DELETE FROM user WHERE id = ?', [targetId]);
  await audit(req.auth, 'delete', 'user', targetId, target, null, req);
  res.json({ ok: true });
}));

module.exports = router;
