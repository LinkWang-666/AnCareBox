/**
 * 数据归属校验 —— 防止横向越权
 *
 * 什么是横向越权：
 *   已登录的 A 用户，通过修改请求的 id 去访问 B 用户的数据。
 *   比如把 /api/schedules/3 改成 /api/schedules/10，就能看到李家的服药计划。
 *   这是本项目最容易出事的地方，光做「登录」挡不住。
 *
 * 规矩：
 *   1. 凡是带 id 的读写，先查出这条数据属于哪个家庭，再和令牌里的 familyId 比对
 *   2. 列表查询一律用 familyId 过滤，不能只按前端传的 elder_id 查
 *   3. device 令牌更严格：只能碰自己绑定的那一位老人的数据
 */
const { queryOne } = require('../db');
const { forbidden, notFound } = require('./http');

/**
 * 设备令牌可访问的老人集合（一箱多老人共用后不止一位）
 * 中间件已把 medbox_elder 的关联结果放进 auth.elderIds；
 * 这里兜底兼容旧令牌只有 elderId 的情况。
 */
function deviceElderSet(auth) {
  return Array.isArray(auth.elderIds) && auth.elderIds.length
    ? auth.elderIds.map(Number)
    : [Number(auth.elderId)];
}

/**
 * 校验一位老人是否在当前身份的可访问范围内
 * @returns 老人记录（校验通过后返回，省得调用方再查一次）
 */
async function assertElder(elderId, auth) {
  const elder = await queryOne('SELECT * FROM elder WHERE id = ?', [elderId]);
  if (!elder) throw notFound('老人档案不存在');

  if (auth.type === 'device') {
    // 设备令牌：只能访问与自己关联的老人（共用模式下有多位）
    if (!deviceElderSet(auth).includes(Number(elderId))) {
      throw forbidden('该药箱只能操作其关联老人的数据');
    }
  } else {
    if (elder.family_id !== auth.familyId) {
      throw forbidden('无权访问其他家庭的老人档案');
    }
  }
  return elder;
}

/** 校验药品归属（medicine 表自带 family_id） */
async function assertMedicine(medicineId, auth) {
  const m = await queryOne('SELECT * FROM medicine WHERE id = ?', [medicineId]);
  if (!m) throw notFound('药品不存在');

  if (auth.type === 'device') {
    // 设备不直接改药品，但要读（老人端展示药名），放行同一家庭的
    if (m.family_id !== auth.familyId) throw forbidden('无权访问该药品');
  } else {
    if (m.family_id !== auth.familyId) throw forbidden('无权访问其他家庭的药品');
  }
  return m;
}

/** 校验药箱归属（medbox 表自带 family_id） */
async function assertMedbox(medboxId, auth) {
  const b = await queryOne('SELECT * FROM medbox WHERE id = ?', [medboxId]);
  if (!b) throw notFound('药箱不存在');

  if (auth.type === 'device') {
    if (auth.deviceId !== Number(medboxId)) throw forbidden('该设备只能访问自身信息');
  } else {
    if (b.family_id !== auth.familyId) throw forbidden('无权访问其他家庭的药箱');
  }
  return b;
}

/** 校验隔间归属（compartment → medbox → family） */
async function assertCompartment(compartmentId, auth) {
  const c = await queryOne(
    `SELECT c.*, m.family_id
     FROM compartment c JOIN medbox m ON c.medbox_id = m.id
     WHERE c.id = ?`,
    [compartmentId]
  );
  if (!c) throw notFound('隔间不存在');

  if (auth.type === 'device') {
    // 隔间是药箱的物理部件：只要属于本设备即可（共用的老人都能开自己的格）
    if (Number(c.medbox_id) !== Number(auth.deviceId)) throw forbidden('该药箱只能操作自身的隔间');
  } else {
    if (c.family_id !== auth.familyId) throw forbidden('无权访问其他家庭的隔间');
  }
  return c;
}

/** 校验服药计划归属（schedule 没有 family_id，通过 elder 反查） */
async function assertSchedule(scheduleId, auth) {
  const s = await queryOne(
    `SELECT s.*, e.family_id
     FROM schedule s JOIN elder e ON s.elder_id = e.id
     WHERE s.id = ?`,
    [scheduleId]
  );
  if (!s) throw notFound('服药计划不存在');

  if (auth.type === 'device') {
    if (!deviceElderSet(auth).includes(Number(s.elder_id))) throw forbidden('该药箱只能操作其关联老人的服药计划');
  } else {
    if (s.family_id !== auth.familyId) throw forbidden('无权访问其他家庭的服药计划');
  }
  return s;
}

/** 校验录音归属（recording 通过 elder 反查） */
async function assertRecording(recordingId, auth) {
  const r = await queryOne(
    `SELECT r.*, e.family_id
     FROM recording r JOIN elder e ON r.elder_id = e.id
     WHERE r.id = ?`,
    [recordingId]
  );
  if (!r) throw notFound('录音不存在');

  if (auth.type === 'device') {
    if (!deviceElderSet(auth).includes(Number(r.elder_id))) throw forbidden('该药箱只能播放其关联老人的录音');
  } else {
    if (r.family_id !== auth.familyId) throw forbidden('无权访问其他家庭的录音');
  }
  return r;
}

/** 校验告警归属（alert 通过 elder 反查） */
async function assertAlert(alertId, auth) {
  const a = await queryOne(
    `SELECT a.*, e.family_id
     FROM alert a JOIN elder e ON a.elder_id = e.id
     WHERE a.id = ?`,
    [alertId]
  );
  if (!a) throw notFound('告警不存在');

  if (auth.type === 'device') {
    if (!deviceElderSet(auth).includes(Number(a.elder_id))) throw forbidden('无权访问该告警');
  } else {
    if (a.family_id !== auth.familyId) throw forbidden('无权访问其他家庭的告警');
  }
  return a;
}

/**
 * 列表查询用的家庭过滤条件
 * 用法：const w = familyWhere(auth, 'e');  // → 'e.family_id = ?' 与 [familyId]
 */
function familyWhere(auth, alias) {
  return { sql: `${alias}.family_id = ?`, value: auth.familyId };
}

module.exports = {
  assertElder, assertMedicine, assertMedbox, assertCompartment,
  assertSchedule, assertRecording, assertAlert, familyWhere, deviceElderSet,
};
