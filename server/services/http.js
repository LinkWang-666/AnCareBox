/**
 * HTTP 错误与统一异常处理
 *
 * 为什么单独抽出来：
 *   原来的 wrap 一律返回 400。但「没登录」应该是 401、「无权访问」应该是 403、
 *   「找不到」应该是 404 —— 前端要靠状态码区分处理（比如 401 跳登录页），
 *   所以这里让抛出的错误可以自带状态码。
 */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 400 参数或业务错误 */
const badRequest = (msg) => new HttpError(400, msg);
/** 401 未登录或令牌失效 */
const unauthorized = (msg) => new HttpError(401, msg);
/** 403 已登录但无权 */
const forbidden = (msg) => new HttpError(403, msg);
/** 404 资源不存在 */
const notFound = (msg) => new HttpError(404, msg);

/**
 * 路由包装：捕获异常，按错误自带的状态码返回
 *
 * 为什么不把 err.message 无脑抛给前端：
 *   数据库异常（比如 ER_BAD_FIELD_ERROR）的 message 里带表名、字段名甚至整条 SQL。
 *   这类信息只该出现在服务端日志里，返给浏览器等于把库结构免费送人。
 *   所以分流：HttpError（我们自己抛的业务错误）原样返回文案；
 *   其他一切（数据库、文件、第三方）统一 500 + 通用文案 + 控制台留全量堆栈。
 */
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    if (e instanceof HttpError) {
      return res.status(e.status).json({ error: e.message });
    }
    console.error(`[${req.method} ${req.originalUrl}] 未预期异常：`, e);
    res.status(500).json({ error: '服务内部异常，请稍后重试', code: 'INTERNAL' });
  });

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, wrap };
