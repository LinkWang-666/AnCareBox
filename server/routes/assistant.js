/**
 * AI 用药助手接口（主动式 Agent）
 *   GET  /api/assistant/insights   主动建议：Agent 接管数据后自己发现的异常/建议
 *   POST /api/assistant/ask        主动问答：子女在「AI 用药助手」窗口提问
 *
 * 契约说明（给队友 UI 的对接依据，详见 docs/ASSISTANT_API.md）：
 *   - 两个接口都要求子女身份登录（requireAuth，返回的 familyId 来自令牌）
 *   - insights 返回结构化数组，每条带 type/priority/title/body/evidence
 *   - ask 返回 answer 文本 + sources（每条回答可溯源）
 *
 * 安全要点：
 *   - family_id 一律取 req.auth.familyId，前端传的忽略（防横向越权）
 *   - 老人端（device 令牌）不可调用本接口，只面向子女端
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const A = require('../services/auth');
const { wrap, badRequest } = require('../services/http');
const Assistant = require('../services/assistant');
const Vision = require('../services/vision');

const router = express.Router();

/**
 * AI 调用限流：同一 IP 每分钟最多 20 次。
 *
 * 为什么要单独限：这几个接口每次都会真的调用大模型，按 token 计费。
 * 全局限流是 300 次/分钟，对「问一句答一句」的场景太宽松 ——
 * 一个循环脚本几分钟就能把 API Key 的额度烧光。
 * 只限「会产生新文本」的接口；/assistant/insights 不限，因为它有 10 分钟缓存、
 * 且首页轮询依赖它，限了会让建议卡片停更。
 */
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI 调用过于频繁，请稍等一分钟再试', code: 'RATE_LIMITED' },
});

/** 主动建议：Agent 接管家庭服药数据后产出的洞察 */
router.get('/assistant/insights', A.requireAuth, wrap(async (req, res) => {
  if (req.auth.type !== 'user') {
    return res.status(403).json({ error: '该接口仅面向子女端', code: 'FORBIDDEN' });
  }
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 30);
  const result = await Assistant.buildInsights(req.auth.familyId, days);
  res.json({ ok: true, ...result });
}));

/** 主动问答：子女在助手窗口提问 */
router.post('/assistant/ask', aiLimiter, A.requireAuth, wrap(async (req, res) => {
  if (req.auth.type !== 'user') {
    return res.status(403).json({ error: '该接口仅面向子女端', code: 'FORBIDDEN' });
  }
  const question = (req.body || {}).question;
  if (!question || !String(question).trim()) {
    throw badRequest('请提供 question 字段');
  }
  const result = await Assistant.generateAnswer(req.auth.familyId, question);
  res.json({ ok: true, ...result });
}));

/**
 * 流式问答（SSE）：与 /assistant/ask 同一路线，但答案是「边生成边显示」。
 *
 * 前端用原生 fetch + ReadableStream 读取，收到一条 delta 就往后追加一个字，
 * 明显缩短「看起来要等多久」。大模型不可用/失败时，streamAnswer 内部会自动
 * 回退规则引擎，一次性产出整段文本，仍以 SSE 逐条吐出，前端无需改判断逻辑。
 *
 * 事件协议（data 均为 JSON）：
 *   event: meta    { ok:true }             —— 已连接、开始生成
 *   event: delta   { text }                —— 一段文本增量
 *   event: done    { ok:true }             —— 正常结束
 *   event: error   { error }               —— 生成失败
 */
router.post('/assistant/ask-stream', aiLimiter, A.requireAuth, async (req, res) => {
  if (req.auth.type !== 'user') {
    return res.status(403).json({ error: '该接口仅面向子女端', code: 'FORBIDDEN' });
  }
  const question = (req.body || {}).question;
  if (!question || !String(question).trim()) {
    return res.status(400).json({ error: '请提供 question 字段', code: 'BAD_REQUEST' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  res.on('close', () => { closed = true; });

  const send = (event, data) => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send('meta', { ok: true });
    for await (const delta of Assistant.streamAnswer(req.auth.familyId, question)) {
      if (closed) break;
      send('delta', { text: delta });
    }
    send('done', { ok: true });
  } catch (e) {
    send('error', { error: e.message || '生成失败' });
  } finally {
    if (!closed && !res.writableEnded) res.end();
  }
});

/**
 * 拍照识药：把药品包装/说明书照片交给视觉大模型，提取结构化入库信息。
 * 只面向子女端（device 令牌无上传需要）。
 */
router.post('/vision/recognize', aiLimiter, A.requireAuth, wrap(async (req, res) => {
  if (req.auth.type !== 'user') {
    return res.status(403).json({ error: '该接口仅面向子女端', code: 'FORBIDDEN' });
  }
  const imageDataUrl = (req.body || {}).image;
  if (!imageDataUrl || !/^data:image\//.test(String(imageDataUrl))) {
    throw badRequest('请提供图片（image 字段，dataURL 格式）');
  }
  const result = await Vision.recognizeMedicine(imageDataUrl);
  res.json({ ok: true, ...result });
}));

module.exports = router;
