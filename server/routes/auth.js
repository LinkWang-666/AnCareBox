/**
 * 认证接口
 *   POST /api/auth/login           子女端登录
 *   POST /api/auth/refresh         用刷新令牌换新的访问令牌（静默续期）
 *   POST /api/auth/logout          登出，旧令牌立即失效
 *   GET  /api/auth/me              当前身份信息
 *   POST /api/auth/change-password 改密，旧令牌立即失效
 *   POST /api/auth/register        注册（自动创建一个新家庭 + owner 账号）
 *   POST /api/auth/bind-code       子女端生成药箱绑定码（5 分钟有效）
 *   POST /api/auth/device-bind     药箱/老人端用绑定码换设备令牌（并种下长期凭证 Cookie）
 *   POST /api/auth/device-refresh  凭 Cookie 静默换回令牌（清了浏览器存储也能自动恢复）
 *   GET  /api/auth/device-sessions 查看药箱绑过哪些设备、最后在线时间
 *   POST /api/auth/device-unbind   子女端解绑药箱，所有设备的令牌与凭证一起失效
 *
 * 令牌存放位置的设计取舍，见 services/auth.js 中 signDeviceRefreshToken 的注释。
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { randomInt } = require('crypto');

const { query, queryOne, exec } = require('../db');
const { wrap, badRequest, unauthorized, forbidden } = require('../services/http');
const { assertMedbox } = require('../services/scope');
const A = require('../services/auth');

const router = express.Router();

/** 刷新令牌的 Cookie 选项：httpOnly 让 JS 读不到，XSS 偷不走 */
const COOKIE_OPT = {
  httpOnly: true,
  sameSite: 'strict',
  maxAge: 30 * 24 * 3600 * 1000, // 30 天
};

/**
 * 设备的长期凭证 Cookie。
 * 有效期跟随设备令牌（默认 180 天），到期后需要重新走一次绑定。
 */
const DEVICE_COOKIE_OPT = {
  httpOnly: true,
  sameSite: 'strict',
  maxAge: A.ttlToDays(A.DEVICE_TTL) * 24 * 3600 * 1000,
  path: '/',
};
const DEVICE_COOKIE_NAME = 'deviceRefresh';

/**
 * 登录限流：同一 IP 15 分钟内最多 20 次
 * 目的：挡住密码爆破。生产环境还应按账号维度再限一层。
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请 15 分钟后再试' },
});

/**
 * 注册限流：同一 IP 每小时最多 10 个新家庭。
 * 不加的话，一个脚本能在几分钟内把 user/family 表灌满，
 * 顺手把用户名抢注光 —— 这是开放注册接口的必然风险。
 */
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '注册过于频繁，请稍后再试', code: 'RATE_LIMITED' },
});

/**
 * 设备绑定限流：同一 IP 每 5 分钟最多 30 次。
 * 绑定码只有 6 位数字，若不限流，攻击者可以按分钟级速度穷举，
 * 碰上一个有效码就拿到该药箱的长期设备令牌（就等于看到了这位老人的全部用药）。
 */
const deviceBindLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '绑定尝试过于频繁，请 5 分钟后再试', code: 'RATE_LIMITED' },
});

/** 去掉敏感字段后再返回给前端 */
function safeUser(u) {
  return {
    id: u.id, username: u.username, realName: u.real_name,
    familyId: u.family_id, role: u.role, phone: u.phone,
  };
}

// ==================== 登录 ====================
router.post('/login', loginLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) throw badRequest('账号和密码必填');

  const u = await queryOne('SELECT * FROM user WHERE username = ?', [username]);

  // 注意：账号不存在和密码错误返回同一句话。
  // 如果分开提示，攻击者就能用错误信息枚举出哪些账号存在。
  if (!u || !A.verifyPassword(password, u.password_hash)) {
    throw unauthorized('账号或密码错误');
  }

  const accessToken = A.signAccessToken(u);
  res.cookie('refreshToken', A.signRefreshToken(u), COOKIE_OPT);

  await exec(
    `INSERT INTO audit_log (user_id, family_id, action, target_type, target_id, ip)
     VALUES (?,?,?,?,?,?)`,
    [u.id, u.family_id, 'login', 'user', u.id, req.ip]
  );

  res.json({ ok: true, accessToken, expiresIn: A.ACCESS_TTL, user: safeUser(u) });
}));

// ==================== 刷新令牌 ====================
router.post('/refresh', wrap(async (req, res) => {
  const token = req.cookies && req.cookies.refreshToken;
  if (!token) throw unauthorized('缺少刷新令牌，请重新登录');

  let payload;
  try {
    payload = jwt.verify(token, A.SECRET);
  } catch (e) {
    throw unauthorized('刷新令牌已失效，请重新登录');
  }
  if (payload.type !== 'refresh') throw unauthorized('令牌类型错误');

  const u = await queryOne('SELECT * FROM user WHERE id = ?', [payload.uid]);
  if (!u) throw unauthorized('账号不存在');
  if (u.token_version !== payload.tv) throw unauthorized('登录状态已失效，请重新登录');

  res.json({ ok: true, accessToken: A.signAccessToken(u), expiresIn: A.ACCESS_TTL });
}));

// ==================== 登出 ====================
router.post('/logout', A.requireAuth, wrap(async (req, res) => {
  res.clearCookie('refreshToken');
  // 版本号 +1 —— 已签发的访问令牌从此对不上，等效于立即失效
  if (req.auth.type === 'user') {
    await exec('UPDATE user SET token_version = token_version + 1 WHERE id = ?', [req.auth.userId]);
  }
  res.json({ ok: true, message: '已登出' });
}));

// ==================== 当前身份 ====================
router.get('/me', A.requireAuth, wrap(async (req, res) => {
  const a = req.auth;
  if (a.type === 'user') {
    res.json({ type: 'user', ...safeUser(a.user) });
  } else {
    res.json({
      type: 'device',
      deviceId: a.deviceId,
      deviceCode: a.box.device_code,
      elderId: a.elderId,
      familyId: a.familyId,
    });
  }
}));

// ==================== 改密 ====================
router.post('/change-password', A.requireAuth, wrap(async (req, res) => {
  if (req.auth.type !== 'user') throw forbidden('设备端不支持修改密码');

  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) throw badRequest('旧密码和新密码必填');
  if (String(newPassword).length < 6) throw badRequest('新密码至少 6 位');

  const u = req.auth.user;
  if (!A.verifyPassword(oldPassword, u.password_hash)) throw badRequest('旧密码不正确');

  // 改密同时把令牌版本 +1：其他设备上已登录的会话全部踢下线
  await exec(
    'UPDATE user SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
    [A.hashPassword(newPassword), u.id]
  );
  res.clearCookie('refreshToken');
  res.json({ ok: true, message: '密码已修改，请重新登录' });
}));

// ==================== 注册（自动建家庭） ====================
router.post('/register', registerLimiter, wrap(async (req, res) => {
  const { username, password, familyName, realName } = req.body || {};
  if (!username || !password) throw badRequest('账号和密码必填');
  if (String(password).length < 6) throw badRequest('密码至少 6 位');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) throw badRequest('账号只能是 3-20 位字母、数字或下划线');

  if (await queryOne('SELECT id FROM user WHERE username = ?', [username])) {
    throw badRequest('该账号已被注册');
  }

  const f = await exec('INSERT INTO family (name) VALUES (?)', [familyName || `${username}的家`]);
  const u = await exec(
    `INSERT INTO user (family_id, username, password_hash, real_name, role)
     VALUES (?,?,?,?,'owner')`,
    [f.insertId, username, A.hashPassword(password), realName || username]
  );

  const user = await queryOne('SELECT * FROM user WHERE id = ?', [u.insertId]);
  res.cookie('refreshToken', A.signRefreshToken(user), COOKIE_OPT);
  res.json({ ok: true, accessToken: A.signAccessToken(user), expiresIn: A.ACCESS_TTL, user: safeUser(user) });
}));

// ==================== 生成药箱绑定码 ====================
/**
 * 子女在控制台点「生成绑定码」，得到 6 位数字；
 * 药箱屏幕上输入这 6 位，就能换取一个长期设备令牌。
 * 老人全程不用输密码 —— 这是老人端能落地的关键设计。
 */
router.post('/bind-code', A.requireAuth, A.requireRole('owner', 'member'), wrap(async (req, res) => {
  const medboxId = req.body.medbox_id;
  if (!medboxId) throw badRequest('medbox_id 必填');

  const box = await assertMedbox(medboxId, req.auth);

  // 绑定码只有 6 位数字，同时有效的码很容易撞车。
  // 若两台药箱拿到同一个码，device-bind 用 `WHERE bind_code = ?` 只取第一条，
  // 用户以为绑的是自己家，实际拿到的是别人家的设备令牌。
  // 所以生成时必须避开「当前仍然有效」的码，并改用加密安全随机数（Math.random 可预测）。
  let code = null;
  for (let i = 0; i < 10; i++) {
    const candidate = String(randomInt(100000, 1000000));
    const clash = await queryOne(
      'SELECT id FROM medbox WHERE bind_code = ? AND bind_code_expires_at > NOW() AND id <> ?',
      [candidate, box.id]
    );
    if (!clash) { code = candidate; break; }
  }
  if (!code) throw badRequest('绑定码生成失败，请稍后重试');

  await exec(
    `UPDATE medbox SET bind_code = ?, bind_code_expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)
     WHERE id = ?`,
    [code, box.id]
  );

  res.json({
    ok: true, bindCode: code, expiresIn: '5 分钟',
    deviceCode: box.device_code,
    tip: '请在老人端或药箱上输入这 6 位数字完成绑定',
  });
}));

// ==================== 药箱用绑定码换令牌 ====================
router.post('/device-bind', deviceBindLimiter, wrap(async (req, res) => {
  const { code } = req.body || {};
  if (!code) throw badRequest('绑定码必填');

  const box = await queryOne(
    'SELECT * FROM medbox WHERE bind_code = ? AND bind_code_expires_at > NOW()',
    [String(code)]
  );
  if (!box) throw badRequest('绑定码无效或已过期，请在子女端重新生成');
  if (!box.elder_id) throw badRequest('该药箱尚未关联老人，请先在子女端分配');

  const jti = A.newJti();

  // 会话落库：服务端从此知道「这台设备绑过，并且这张令牌是发给它的」
  await exec(
    `INSERT INTO device_session
       (medbox_id, token_jti, expires_at, last_seen_at, user_agent, login_ip)
     VALUES (?,?, DATE_ADD(NOW(), INTERVAL ? DAY), NOW(), ?, ?)`,
    [box.id, jti, A.ttlToDays(A.DEVICE_TTL), String(req.headers['user-agent'] || '').slice(0, 255), req.ip]
  );

  const token = A.signDeviceToken(box, jti);

  // 绑定码用后即焚，防止被二次使用；
  // 同时把药箱置为在线 —— 有设备绑定进来了，状态就该跟上。
  await exec(
    "UPDATE medbox SET bind_code = NULL, bind_code_expires_at = NULL, status = 'online' WHERE id = ?",
    [box.id]
  );

  // 再种一张长期凭证到 httpOnly Cookie。
  // browser 清除 localStorage 后，页面靠这张 Cookie 就能静默换回令牌，
  // 老人不需要任何操作 —— 这是本次改造解决的核心问题。
  res.cookie(DEVICE_COOKIE_NAME, A.signDeviceRefreshToken(box, jti), DEVICE_COOKIE_OPT);

  await exec(
    `INSERT INTO audit_log (user_id, family_id, action, target_type, target_id, ip)
     VALUES (?,?,?,?,?,?)`,
    [null, box.family_id, 'device_bind', 'medbox', box.id, req.ip]
  );

  const elder = await queryOne('SELECT id, name FROM elder WHERE id = ?', [box.elder_id]);
  res.json({
    ok: true, accessToken: token, expiresIn: A.DEVICE_TTL,
    device: { id: box.id, deviceCode: box.device_code },
    elder,
  });
}));

// ==================== 设备令牌静默恢复 ====================
/**
 * 场景：用户清理了浏览器数据（localStorage 里的令牌没了），
 *      但 httpOnly Cookie 还在 —— 用它直接换回一张新令牌，老人全程无感知。
 *
 * 注意这里不轮换 jti：
 *   设备凭证本身是长期的，恢复只是把丢失的令牌补回来，
 *   重新签发相同 jti 的令牌即可，避免每次刷新都往会话表里塞一行数据。
 */
router.post('/device-refresh', wrap(async (req, res) => {
  const token = req.cookies && req.cookies[DEVICE_COOKIE_NAME];
  if (!token) throw unauthorized('本机没有绑定记录，请在老人端输入绑定码');

  let payload;
  try {
    payload = jwt.verify(token, A.SECRET);
  } catch (e) {
    throw unauthorized('本机绑定记录已过期，请重新输入绑定码');
  }
  if (payload.type !== 'device_refresh') throw unauthorized('令牌类型错误');

  const box = await queryOne('SELECT * FROM medbox WHERE id = ?', [payload.did]);
  if (!box) throw unauthorized('设备不存在');
  if (box.token_version !== payload.tv) throw unauthorized('该药箱已被解绑，请重新绑定');

  const session = await queryOne(
    'SELECT id, revoked_at, expires_at FROM device_session WHERE token_jti = ?',
    [payload.jti]
  );
  if (!session) throw unauthorized('找不到绑定记录，请重新输入绑定码');
  if (session.revoked_at) throw unauthorized('该设备的登录已被取消，请重新绑定');
  if (session.expires_at && new Date(session.expires_at) < new Date()) {
    throw unauthorized('本机绑定已到期，请重新输入绑定码');
  }

  await exec('UPDATE device_session SET last_seen_at = NOW() WHERE id = ?', [session.id]);

  res.json({
    ok: true,
    accessToken: A.signDeviceToken(box, payload.jti),
    expiresIn: A.DEVICE_TTL,
    device: { id: box.id, deviceCode: box.device_code },
    elder: await queryOne('SELECT id, name FROM elder WHERE id = ?', [box.elder_id]),
  });
}));

/**
 * 子女端查看某个药箱的绑定设备（在线状态）
 * 数据来源 device_session.last_seen_at，真正意义上的「最后在线时间」
 */
router.get('/device-sessions', A.requireAuth, A.requireRole('owner', 'member'), wrap(async (req, res) => {
  const medboxId = Number(req.query.medbox_id);
  if (!medboxId) throw badRequest('medbox_id 必填');
  const box = await assertMedbox(medboxId, req.auth);

  const rows = await query(
    `SELECT id, token_jti, issued_at, expires_at, last_seen_at, revoked_at, user_agent, login_ip
     FROM device_session WHERE medbox_id = ? ORDER BY issued_at DESC`,
    [box.id]
  );
  res.json({ ok: true, deviceCode: box.device_code, sessions: rows });
}));

// ==================== 解绑药箱 ====================
router.post('/device-unbind', A.requireAuth, A.requireRole('owner'), wrap(async (req, res) => {
  const medboxId = req.body.medbox_id;
  if (!medboxId) throw badRequest('medbox_id 必填');

  const box = await assertMedbox(medboxId, req.auth);

  // 两层保险，缺一不可：
  //   1) 吊销所有会话记录 —— 精确命中每一台绑过的设备（含只靠 Cookie 恢复的那种）
  //   2) token_version +1 —— 兜底，连会话表里查不到的历史令牌一起作废
  const s = await exec(
    `UPDATE device_session SET revoked_at = NOW(), revoke_reason = 'unbind'
     WHERE medbox_id = ? AND revoked_at IS NULL`,
    [box.id]
  );
  await exec(
    "UPDATE medbox SET token_version = token_version + 1, bind_code = NULL, bind_code_expires_at = NULL, status = 'offline' WHERE id = ?",
    [box.id]
  );

  // 让浏览器把那张长期凭证 Cookie 也吐掉，否则它还会去尝试静默恢复
  res.clearCookie(DEVICE_COOKIE_NAME, { path: '/' });

  await exec(
    `INSERT INTO audit_log (user_id, family_id, action, target_type, target_id, ip)
     VALUES (?,?,?,?,?,?)`,
    [req.auth.userId, req.auth.familyId, 'device_unbind', 'medbox', box.id, req.ip]
  );

  res.json({
    ok: true,
    message: `已解绑 ${box.device_code}，${s.affectedRows} 台设备的登录同时失效`,
  });
}));

module.exports = router;
