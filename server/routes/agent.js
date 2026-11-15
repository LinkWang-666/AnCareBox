/**
 * AI Agent 接口（自然语言 → 自动执行）
 *   POST /api/agent/chat   用户说一句话，AI 自动调用工具完成操作并回复
 *
 * 返回结构：
 *   { ok, answer, actions, engine }
 *   - answer  给用户看的中文回复
 *   - actions 本次实际执行了哪些工具（[{tool, args, ok, summary}]）
 *   - engine  'llm'（大模型驱动）| 'rule'（关键词降级）
 *
 * 安全：仅子女端（user 令牌）可调用；familyId 一律取 req.auth.familyId。
 *       写工具按角色二次校验（viewer 只能查、不能改），并在执行后写审计日志 ——
 *       助手改数据和界面改数据走的是同一张审计表，事后追溯时不能有盲区。
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const A = require('../services/auth');
const { wrap, badRequest } = require('../services/http');
const { exec } = require('../db');
const Agent = require('../services/agent');

const router = express.Router();

/**
 * 助手限流：同一 IP 每分钟最多 15 次。
 * 这个接口比其他 AI 接口更贵 —— 一次请求内部最多跑 3 轮工具调用，
 * 每轮都是一次完整的大模型往返。不限的话，一个循环脚本能把额度打穿。
 */
const agentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '助手调用过于频繁，请稍等一分钟再试', code: 'RATE_LIMITED' },
});

/** 把助手的写操作记进审计日志：动作名统一加 ai_ 前缀，便于和界面操作区分 */
async function auditAgentWrites(auth, actions, req) {
  const writes = (actions || []).filter((a) => a && a.ok !== false && Agent.WRITE_TOOLS.has(a.tool));
  for (const a of writes) {
    try {
      await exec(
        `INSERT INTO audit_log (user_id, family_id, action, target_type, target_id, after_json, ip)
         VALUES (?,?,?,?,?,?,?)`,
        [
          auth.userId, auth.familyId, 'ai_' + a.tool, 'agent', null,
          JSON.stringify({ args: a.args || null, summary: a.summary || null }).slice(0, 4000),
          req.ip,
        ]
      );
    } catch (e) {
      // 审计失败不能影响已经执行成功的业务操作，只记日志
      console.warn('[agent] 审计写入失败：', e.message);
    }
  }
}

router.post('/agent/chat', agentLimiter, A.requireAuth, wrap(async (req, res) => {
  if (req.auth.type !== 'user') {
    return res.status(403).json({ error: '该接口仅面向子女端', code: 'FORBIDDEN' });
  }
  const message = (req.body || {}).message;
  if (!message || !String(message).trim()) {
    throw badRequest('请提供 message 字段');
  }
  const confirm = (req.body || {}).confirm || null;
  const result = await Agent.runAgent(
    req.auth.familyId,
    String(message).trim(),
    confirm,
    { role: req.auth.role, userId: req.auth.userId }
  );
  await auditAgentWrites(req.auth, result.actions, req);
  res.json({ ok: true, ...result });
}));

module.exports = router;
