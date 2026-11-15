/**
 * 前后端通信封装 —— 所有页面共用
 * 统一处理：拼接 /api 前缀、携带 JWT、401 自动续期、错误提示
 *
 * 令牌存放说明：
 *   访问令牌（2 小时）存 localStorage，刷新令牌（30 天）由服务端写在 httpOnly Cookie 里，
 *   JS 读不到，所以 XSS 偷不走刷新令牌。这是当前较通用的折中方案。
 *
 *   老人端同理，但多了一层服务端持久化（device_session 表）：
 *   令牌不再只看浏览器的脸色，清理 localStorage 后还能凭 Cookie 静默换回来，
 *   详见 tryDeviceRefresh()。
 */

/**
 * 接口根地址
 * 由 js/config.js 写入 window.AX_API_BASE：
 *   · 同源访问（页面就在 3000 端口上）→ 空字符串，走相对路径 /api/...
 *   · 跨源访问（HBuilderX webview、8080 静态预览）→ 后端绝对地址
 * config.js 没加载时自动降级为空串，行为等同于改造前，不会坏。
 */
const API_ROOT = String((typeof window !== 'undefined' && window.AX_API_BASE) || '').replace(/\/+$/, '');

let TOKEN_KEY = 'mb_token';

/**
 * 切换令牌存放键
 * 为什么需要：同一个浏览器可能既开着子女端又开着老人端，
 * 共用一个键会互相顶掉。老人端改用 mb_device_token 分开存放。
 */
function setTokenKey(k) { TOKEN_KEY = k; }

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

/**
 * 读取当前令牌的身份类型：'user' | 'device' | null
 *
 * 为什么前端要能看懂令牌类型：
 *   老人端和子女端共用同一套接口，但权限完全不同。
 *   如果老人端误用了子女的令牌（两者在同一个浏览器，
 *   而刷新令牌 httpOnly Cookie 是全站共享的），就会出现这种怪事：
 *   页面能正常显示，但一点「我吃好了」后端就返回 device_code 必填，
 *   弹一串英文，看不出是自己身份串了。先认清身份，就能提前把人请回绑定页。
 *
 * 安全说明：这里**只读取不校验签名**。真正的鉴权永远在服务端做，
 * 前端这个判断仅用于界面引导，不影响任何权限。
 */
function tokenType() {
  const t = getToken();
  if (!t) return null;
  try {
    const seg = t.split('.')[1];
    if (!seg) return null;
    // JWT 用 base64url，需要转成标准 base64 才能解码
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
    return payload.type || null;
  } catch (e) {
    return null;
  }
}

/**
 * 401 的自定义处理器
 * 默认跳子女端登录页；老人端会把它改成「回到绑定页」，
 * 因为老人没有账号密码，不该被推去登录页。
 */
let unauthorizedHandler = null;
function setUnauthorizedHandler(fn) { unauthorizedHandler = fn; }
function fireUnauthorized() {
  if (unauthorizedHandler) { unauthorizedHandler(); return; }
  goLogin();
}

/** 弹出提示条 */
function toast(msg, isErr) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast' + (isErr ? ' err' : ''); }, 2000);
}

/**
 * 该往哪个登录页跳
 * 手机端子站在 /m/ 下，退出或令牌失效时要回手机版登录页，
 * 不能把手机用户丢到桌面版的 /login.html 上。
 */
function loginPath() {
  return /^\/m(\/|$)/.test(location.pathname) ? '/m/login.html' : '/login.html';
}

/** 跳登录页（带回来路，登录后能返回原页面） */
function goLogin() {
  clearToken();
  const lp = loginPath();
  if (location.pathname !== lp) {
    location.href = lp + '?from=' + encodeURIComponent(location.pathname);
  }
}

/**
 * 用刷新令牌换一张新的访问令牌
 * 刷新令牌在 httpOnly Cookie 里，浏览器会自动带上，不需要我们手动传
 */
async function tryRefresh() {
  try {
    const res = await fetch(API_ROOT + '/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return false;
    const d = await res.json();
    if (d.accessToken) { setToken(d.accessToken); return true; }
  } catch (e) { /* 网络异常按失败处理 */ }
  return false;
}

/**
 * 用浏览器里那张「长期凭证 Cookie」换回一张设备令牌。
 *
 * 什么时候会走到这里：
 *   用户清理了浏览器数据，localStorage 里的令牌被删了；
 *   但 httpOnly Cookie 还在（浏览器删 localStorage 时不会连带删 Cookie），
 *   于是页面能在老人完全无察觉的情况下，自己把令牌补回来。
 *
 * 凭证的分工：
 *   设备令牌   —— 每次请求带的，丢了可以再换
 *   凭证 Cookie —— httpOnly，JS 读不到（XSS 偷不走），用来补令牌
 *
 * 返回 true 表示已经拿到令牌。
 */
async function tryDeviceRefresh() {
  try {
    const res = await fetch(API_ROOT + '/api/auth/device-refresh', {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return false;
    const d = await res.json();
    if (d.accessToken) { setToken(d.accessToken); return true; }
  } catch (e) { /* 网络异常按失败处理 */ }
  return false;
}

/**
 * 单次请求的超时上限。
 *
 * 为什么必须设：
 *   没有超时的 fetch 在前端表现为「永远转圈」—— 服务端某个接口卡住（比如等大模型
 *   返回），页面就一直停在骨架屏，用户看到的是「系统坏了」，而我们这边连日志都没有。
 *   加上上限后，卡住的请求会明确变成「请求超时」，页面能走错误分支、给出可操作提示。
 *   取 20 秒：普通接口都在百毫秒级，长的是 AI 分析类，20 秒足够，也不至于让用户干等。
 */
const REQUEST_TIMEOUT_MS = 20000;

/** 统一请求 */
async function request(method, path, body, allowRetry = true) {
  const opt = { method, headers: {}, credentials: 'include' };
  const t = getToken();
  if (t) opt.headers['Authorization'] = 'Bearer ' + t;
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }

  let res;
  let timer = null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  if (ctrl) {
    opt.signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  }
  try {
    res = await fetch(API_ROOT + '/api' + path, opt);
  } catch (e) {
    if (timer) clearTimeout(timer);
    // 超时和「连不上」是两回事，提示要分开，否则用户会去查网络而不是等重试
    if (e && e.name === 'AbortError') {
      toast('请求超时，请稍后重试', true);
      throw new Error('请求超时');
    }
    // fetch 抛异常 = 网络层就断了（后端没起、手机连不到电脑、防火墙拦了）
    // 这种错误如果不翻译，页面上只会是全空白，用户完全不知道发生了什么。
    // 移动端加载了 config.js，会把「服务器地址」面板叫出来，手机上能当场改地址；
    // 桌面端没加载 config.js（同源，地址改不了也不用改），就只提示排查方向。
    const where = API_ROOT || location.origin;
    const msg = '连不上服务器（' + where + '）';
    const canPanel = typeof window.AX_SHOW_PANEL === 'function';
    toast(msg + (canPanel ? '，正在打开服务器地址设置' : '，请确认后端已启动、数据库在跑'), true);
    if (canPanel) {
      window.AX_SHOW_PANEL('请求 ' + where + ' 失败：后端没启动，或这台设备连不到电脑。');
    }
    throw new Error(msg);
  }
  if (timer) clearTimeout(timer);

  // 401：先试着静默续期，成功就重放一次；失败才踢到登录页
  if (res.status === 401 && allowRetry && t) {
    const ok = await tryRefresh();
    if (ok) return request(method, path, body, false);
    fireUnauthorized();
    throw new Error('登录已过期，请重新登录');
  }

  let data;
  try { data = await res.json(); } catch (e) { data = {}; }
  if (!res.ok) {
    const msg = data.error || `请求失败（${res.status}）`;
    toast(msg, true);
    throw new Error(msg);
  }
  return data;
}

const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
  getToken, setToken, clearToken, goLogin, tryRefresh, tryDeviceRefresh,
  setTokenKey, setUnauthorizedHandler, tokenType,
};

/** 登出：通知服务端把令牌版本 +1，本地清干净后回登录页（手机端回手机版登录页） */
async function logout() {
  try { await request('POST', '/auth/logout', {}); } catch (e) { /* 即便失败也要清本地 */ }
  clearToken();
  location.href = loginPath();
}

/** HTML 转义，防止用户输入破坏页面结构 */
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 结果 → 徽章 */
function resultBadge(r) {
  const map = {
    on_time: ['green', '按时'],
    early: ['green', '提前'],
    late: ['amber', '延迟'],
    missed: ['red', '漏服'],
    duplicate: ['red', '重复'],
    abnormal: ['red', '异常'],
    unknown: ['', '未知'],
  };
  const m = map[r] || ['', r];
  return `<span class="badge ${m[0]}">${m[1]}</span>`;
}

/** 格式化时间 */
function fmtTime(s) {
  if (!s) return '-';
  return String(s).slice(0, 16);
}

/**
 * 页面加载时的守卫：没有令牌就直接去登录页
 * 用法：<script>requireLogin();</script> 放在页面最前面
 */
async function requireLogin() {
  if (!getToken()) {
    // 也许还有刷新令牌，试一次
    const ok = await tryRefresh();
    if (!ok) { goLogin(); return false; }
  }
  return true;
}
