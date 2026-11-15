/**
 * 身份认证服务 —— JWT 的签发、验证，以及密码的哈希与校验
 *
 * ┌─ 两类令牌 ────────────────────────────────────────────┐
 * │ user   令牌：子女端登录后拿到，含 userId / familyId / role │
 * │ device 令牌：药箱用绑定码换取，长期有效，只能操作绑定的老人  │
 * └──────────────────────────────────────────────────────┘
 *
 * 关于「签发了收不回」这个 JWT 天生的短板：
 *   令牌里带一个版本号 tv，库里 user.token_version / medbox.token_version 存当前版本。
 *   登出、改密、解绑时把库里的版本号 +1，旧令牌的 tv 就对不上了 —— 等效于立即失效。
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');
const { query, queryOne, exec } = require('../db');

// 密钥：生产环境必须在 .env 里设置一个足够长的随机串
const SECRET = process.env.JWT_SECRET || 'dev-only-secret-please-change-in-env';
const ACCESS_TTL  = process.env.JWT_ACCESS_TTL  || '2h';    // 子女端访问令牌
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '30d';   // 刷新令牌（存 httpOnly Cookie）
const DEVICE_TTL  = process.env.JWT_DEVICE_TTL  || '180d';  // 药箱设备令牌
const BCRYPT_COST = Number(process.env.BCRYPT_COST || 10);  // 生产建议 12

const isDefaultSecret = !process.env.JWT_SECRET;

// ==================== 密码 ====================

/** 生成密码哈希（bcrypt 自带随机盐，同样的密码两次结果不同，这是正常的） */
function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_COST);
}

/** 校验密码：拿明文和库里的哈希比对，bcrypt 会自动取出盐重算 */
function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compareSync(plain, hash);
}

// ==================== 令牌签发 ====================

/** 子女端访问令牌：2 小时 */
function signAccessToken(user) {
  return jwt.sign(
    { type: 'user', uid: user.id, fid: user.family_id, role: user.role, tv: user.token_version },
    SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

/** 刷新令牌：30 天，放 httpOnly Cookie，JS 读不到，XSS 偷不走 */
function signRefreshToken(user) {
  return jwt.sign(
    { type: 'refresh', uid: user.id, tv: user.token_version },
    SECRET,
    { expiresIn: REFRESH_TTL }
  );
}

/**
 * 令牌编号 jti：写进 JWT 的同时落库到 device_session.token_jti。
 * 有了它，服务端才能精确定位「哪一次绑定」，从而做到单设备吊销，
 * 而不是像 token_version 那样把整个药箱的所有会话一起干掉。
 */
function newJti() {
  return randomUUID().replace(/-/g, '');
}

/**
 * 把 '180d' 这类有效期换算成天数，用于写库的 expires_at。
 *
 * 为什么要逐个列单位而不是「不是 h/m 就当天数」：
 *   原来没处理秒（'3600s'）和星期（'2w'），parseInt 出来 3600，
 *   单位不认识就按天算 —— 于是 1 小时的令牌在库里被记成 3600 天，
 *   会话表里的到期时间比实际晚了近十年，吊销逻辑形同虚设。
 *   未知单位一律按天兜底并给出保守上限，宁可早过期也不要写成十年。
 */
function ttlToDays(ttl) {
  const n = parseInt(String(ttl), 10) || 0;
  const unit = String(ttl).replace(/[0-9]/g, '').trim().toLowerCase();
  if (unit === 'y') return n * 365;
  if (unit === 'w') return n * 7;
  if (unit === 'd' || unit === '') return n;
  if (unit === 'h') return Math.max(1, Math.ceil(n / 24));
  if (unit === 'm') return Math.max(1, Math.ceil(n / (24 * 60)));
  if (unit === 's') return Math.max(1, Math.ceil(n / 86400));
  return Math.min(n, 365); // 未知单位：按天，但不超过一年
}

/**
 * 设备的「长期凭证」：绑定成功时种进 httpOnly Cookie。
 *
 * 它和设备令牌的分工：
 *   设备令牌   → 每次请求带在 Authorization 头，短平快地证明身份
 *   这个凭证   → 浏览器自己保管，JS 读不到；localStorage 被清时靠它救回令牌
 *
 * 为什么不让 JS 去读它（即不放 localStorage）：
 *   httpOnly 的 Cookie 无法被 JS 访问，所以 XSS 攻击偷不走；
 *   反过来如果放 localStorage，页面上任何一段恶意脚本都能拿走长期凭证。
 */
function signDeviceRefreshToken(box, jti) {
  return jwt.sign(
    { type: 'device_refresh', did: box.id, jti, tv: box.token_version },
    SECRET,
    { expiresIn: DEVICE_TTL }
  );
}

/** 药箱设备令牌：180 天，权限被限定在绑定的那一位老人 */
function signDeviceToken(box, jti) {
  const opt = { expiresIn: DEVICE_TTL };
  if (jti) opt.jwtid = jti;
  return jwt.sign(
    { type: 'device', did: box.id, eid: box.elder_id, fid: box.family_id, tv: box.token_version },
    SECRET,
    opt
  );
}

// ==================== 中间件 ====================

/**
 * 「最后在线时间」的写入节流。
 * 老人端每 60 秒轮询一次，若每次请求都写库，纯属浪费 IO。
 * 这里按 jti 做内存级节流：同一个会话 60 秒内只写一次。
 * 进程重启后缓存清空，下一次请求自然会重新写一遍，不影响正确性。
 */
const lastSeenCache = new Map();
const LAST_SEEN_INTERVAL = 60 * 1000;

function touchLastSeen(jti) {
  if (!jti) return;
  const now = Date.now();
  if (now - (lastSeenCache.get(jti) || 0) < LAST_SEEN_INTERVAL) return;
  lastSeenCache.set(jti, now);
  // 异步补写，失败也不该影响业务请求本身，所以用 catch 吞掉
  exec('UPDATE device_session SET last_seen_at = NOW() WHERE token_jti = ?', [jti]).catch(() => {});
}

/**
 * 校验设备会话有没有被吊销。
 * 老规则只有 token_version（一改就把整个药箱所有会话全踢），颗粒度太粗。
 * 有了 device_session 后，可以精确吊销某一台具体设备。
 *
 * 注意向后兼容：改造前签发的令牌没有 jti，这里直接放行，
 * 不会因为升级把已经绑定好的药箱踢下线 —— 它们重绑后自然就有 jti 了。
 */
async function checkDeviceSession(payload) {
  if (!payload.jti) return null;
  const s = await queryOne(
    'SELECT revoked_at, expires_at FROM device_session WHERE token_jti = ?',
    [payload.jti]
  );
  if (!s) return null;                       // 库里没有记录（比如清过库），交由上层放行
  if (s.revoked_at) return '该设备的登录已被取消，请重新绑定';
  if (s.expires_at && new Date(s.expires_at) < new Date()) return '设备登录已到期，请重新绑定';
  return null;
}

/**
 * 鉴权中间件：解析 Authorization 头，校验签名、有效期、版本号
 * 通过后把身份信息挂到 req.auth 上，后面的接口直接取用
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: '请先登录', code: 'NO_TOKEN' });
    }

    // 验签 + 查有效期：签名不对或过期都会在这里抛错
    const payload = jwt.verify(token, SECRET);

    if (payload.type === 'user') {
      const u = await queryOne('SELECT * FROM user WHERE id = ?', [payload.uid]);
      if (!u) return res.status(401).json({ error: '账号不存在', code: 'NO_USER' });
      // 版本号比对：改密或登出后这里会对不上
      if (u.token_version !== payload.tv) {
        return res.status(401).json({ error: '登录状态已失效，请重新登录', code: 'TOKEN_REVOKED' });
      }
      req.auth = { type: 'user', userId: u.id, familyId: u.family_id, role: u.role, user: u };

    } else if (payload.type === 'device') {
      const b = await queryOne('SELECT * FROM medbox WHERE id = ?', [payload.did]);
      if (!b) return res.status(401).json({ error: '设备不存在', code: 'NO_DEVICE' });
      if (b.token_version !== payload.tv) {
        return res.status(401).json({ error: '该药箱已被解绑，请重新绑定', code: 'DEVICE_REVOKED' });
      }
      const sessionErr = await checkDeviceSession(payload);
      if (sessionErr) {
        return res.status(401).json({ error: sessionErr, code: 'DEVICE_SESSION_REVOKED' });
      }
      touchLastSeen(payload.jti);
      // 一箱多老人：这台设备可访问的老人 = 主老人 + medbox_elder 关联的所有老人
      const elderRows = await query(
        `SELECT elder_id FROM medbox_elder WHERE medbox_id = ?
         UNION SELECT elder_id FROM medbox WHERE id = ? AND elder_id IS NOT NULL`,
        [b.id, b.id]
      );
      const elderIds = elderRows.map((r) => Number(r.elder_id));
      req.auth = {
        type: 'device', deviceId: b.id,
        elderId: b.elder_id,                // 主老人（兼容旧逻辑 / 上报兜底归属）
        elderIds,                           // 全部关联老人（共用模式下的越权判定用）
        familyId: b.family_id, box: b, jti: payload.jti || null,
      };

    } else {
      return res.status(401).json({ error: '令牌类型无效', code: 'BAD_TYPE' });
    }

    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ error: '登录已过期，请重新登录', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: '令牌无效：' + e.message, code: 'TOKEN_INVALID' });
  }
}

/**
 * 角色校验：必须放在 requireAuth 之后
 * 用法：router.delete('/elders/:id', requireAuth, requireRole('owner'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.auth.type !== 'user') {
      return res.status(403).json({ error: '该接口仅子女端可访问' });
    }
    if (!roles.includes(req.auth.role)) {
      return res.status(403).json({ error: `权限不足，需要 ${roles.join(' 或 ')} 角色` });
    }
    next();
  };
}

/**
 * 可写拦截：viewer 角色只读，设备端不能改配置
 * 用法：router.post('/medicines', requireAuth, requireWritable, handler)
 */
function requireWritable(req, res, next) {
  // 设备令牌只用于上报事件和读取自己的计划，不能改配置
  if (req.auth.type !== 'user') {
    return res.status(403).json({ error: '配置修改仅子女端可进行' });
  }
  if (req.auth.role === 'viewer') {
    return res.status(403).json({ error: '只读成员不能修改配置' });
  }
  next();
}

module.exports = {
  SECRET, ACCESS_TTL, REFRESH_TTL, DEVICE_TTL, isDefaultSecret,
  hashPassword, verifyPassword,
  signAccessToken, signRefreshToken, signDeviceToken, signDeviceRefreshToken,
  newJti, ttlToDays, checkDeviceSession, touchLastSeen,
  requireAuth, requireRole, requireWritable,
};
