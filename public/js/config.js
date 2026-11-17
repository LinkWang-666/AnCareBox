/**
 * 安心格 · 接口地址解析 + 连接自检（全站共用，必须最先加载）
 * ─────────────────────────────────────────────────────────────
 * 解决的问题：
 *   Web 端和移动端原本都用相对路径 /api/xxx，只有「页面和接口同源」时才对。
 *   一旦页面被搬到别的主机/端口（HBuilderX webview、静态预览、手机直连），
 *   相对路径就会打到错误的地址，页面全空，而且报错全是英文，看不出是地址问题。
 *
 * 写入 window 的三个值，供 js/api.js 使用：
 *   window.AX_API_BASE      接口根地址；空字符串 = 走相对路径（同源）
 *   window.AX_BACKEND_PORT  后端端口，日志与排查用
 *   window.AX_DIAG()        打印并返回当前连接诊断（手机上看不了控制台时用）
 *
 * 地址怎么定的（优先级从高到低）：
 *   1) 地址栏 ?api=http://x:3000      临时试，不改文件、不用重新打包
 *   2) localStorage 里手动保存过的地址  ← 手机上点「服务器地址」面板填一次，长期记住
 *   3) 本文件里的 MANUAL_BASE          后端不在本机、是 https 域名时改这里
 *   4) 自动推断：
 *        · http / https 打开 → 空串，一律走相对路径（同源）
 *        · file:// 打开      → 推断不出，需手动填写
 *
 *   第 4 条为什么不再按端口区分：页面既然是用 http(s) 从这台服务器拿到的，
 *   接口就几乎必然同源。本地直跑、手机连电脑、云上 nginx 反代三种情形全是同源。
 *   早先的实现会拼「当前主机:3000」，在 nginx 部署下必然连不上
 *   （Node 只监听 127.0.0.1，3000 也不对外开放）。
 *
 * 连不上会怎样：
 *   自动弹一个「服务器地址」小面板，只在真的连不上时出现——同源正常时不弹，
 *   手动指定过地址则先探一次 /api/health。面板文案按场景分流：
 *   局域网调试讲「查电脑 IP」，线上部署讲「填当前页面地址、不要带 :3000」。
 */
(function () {
  'use strict';

  // 后端 Node 服务端口（smart-medbox 默认 3000）
  var BACKEND_PORT = 3000;

  // 手动指定接口根地址：填了优先用它；留空则自动推断
  var MANUAL_BASE = '';

  // 手机上手动填过的地址存在这个 key
  var LS_KEY = 'ax_api_base';

  // 健康检查接口（后端 server/app.js 里已有）
  var HEALTH_PATH = '/api/health';

  function currentPort() {
    return location.port || (location.protocol === 'https:' ? '443' : '80');
  }

  /**
   * 自动推断接口根地址；返回 '' 表示走同源相对路径。
   *
   * 为什么一律走同源：
   *   页面只要是用 http/https 打开拿到的，它和接口就几乎必然同源，三种情形都成立——
   *     · 本地电脑直接跑 Node        → 页面在 :3000，接口也在 :3000
   *     · 手机连电脑，输 http://IP:3000 → 同上
   *     · 云服务器 nginx 反代         → 页面在 :80/:443，nginx 把 /api 转给 :3000
   *   原来的实现在第三种情形下会拼出「主机:3000」，可线上 Node 只监听 127.0.0.1、
   *   安全组也不放行 3000，请求根本出不了机房门，页面就整个连不上。
   *
   *   反过来，如果只按「页面端口是不是 3000」来判断，就会把同源这种最常见的情况
   *   误判成跨源，所以这里不再猜端口，直接交给浏览器按相对路径解析。
   */
  function autoBase() {
    // file:// 没有 hostname，没有「同源」可言，只能手动填（见 boot）
    if (location.protocol === 'file:' || !location.hostname) return '';
    return '';
  }

  /**
   * 同源不通时的备选地址，仅供面板预填，不参与正常路径。
   * 对应一种真实存在的老用法：页面由别的静态服务（比如 :8080）托管，后端另跑在 :3000。
   * 云端部署用不到它——那种情况下 3000 对外就是不通的，填了也没用。
   */
  function fallbackBase() {
    if (location.protocol === 'file:' || !location.hostname) return '';
    if (String(currentPort()) === String(BACKEND_PORT)) return '';
    var scheme = location.protocol === 'https:' ? 'https://' : 'http://';
    return scheme + location.hostname + ':' + BACKEND_PORT;
  }

  /**
   * 是不是「本机 / 局域网调试」场景。
   * 只用来决定面板里那段提示怎么措辞：让手机连电脑的人看到「查电脑 IP」，
   * 让访问线上地址的人看到「查服务器状态」，各说各的，不互相误导。
   */
  function isLanDebug() {
    var h = String(location.hostname || '');
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]') return true;
    if (/^192\.168\./.test(h)) return true;
    if (/^10\./.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    return false;
  }

  /** 规范化用户输入的地址：补协议、去末尾斜杠、去掉误加的 /api */
  function normalize(u) {
    var s = String(u || '').trim().replace(/\/+$/, '');
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    s = s.replace(/\/api$/i, '');
    return s;
  }

  function readSaved() {
    try { return normalize(localStorage.getItem(LS_KEY) || ''); } catch (e) { return ''; }
  }

  function saveBase(u) {
    var v = normalize(u);
    try {
      if (v) localStorage.setItem(LS_KEY, v);
      else localStorage.removeItem(LS_KEY);
    } catch (e) { /* 隐私模式写不了，忽略 */ }
    return v;
  }

  // ?api=http://x:3000 现场覆盖，排查时不用改文件、不用重新打包
  var fromQuery = '';
  try {
    fromQuery = new URLSearchParams(location.search).get('api') || '';
  } catch (e) { /* 老内核不支持 URLSearchParams，忽略 */ }

  var saved = readSaved();

  // 预览服务（web交付版/server.js）托管页面时，会往 HTML 里插一个标记：
  // 它已经把 /api 反向代理到后端了，所以这里直接用同源相对路径最稳
  // —— 不跨域、Cookie 同站，刷新令牌能正常续期。
  var proxied = !!window.AX_SAME_ORIGIN_PROXY;

  var base = normalize(fromQuery || saved || MANUAL_BASE || (proxied ? '' : autoBase()));

  window.AX_API_BASE = base;
  window.AX_BACKEND_PORT = BACKEND_PORT;

  // 控制台可确认当前到底打到哪，排查时第一眼看这里
  if (window.console && console.log) {
    var src = fromQuery ? '来自 ?api= 参数'
      : (saved ? '来自本机保存的设置'
        : (MANUAL_BASE ? '来自 config.js 的 MANUAL_BASE'
          : (proxied ? '预览服务已代理 /api，走同源' : '自动推断')));
    console.log('[安心格] 接口地址：' + (base || '同源相对路径 /api') + '（' + src + '）');
  }

  /** 诊断信息：手机上看不了控制台时，页面上调 AX_DIAG() 就能看到 */
  window.AX_DIAG = function () {
    var d = {
      页面地址: location.href,
      接口地址: base || '(同源相对路径 /api)',
      后端端口: BACKEND_PORT,
      地址来源: fromQuery ? '?api= 参数' : (saved ? '本机保存' : (MANUAL_BASE ? 'MANUAL_BASE' : '自动推断'))
    };
    if (window.console && console.table) console.table(d); else console.log(d);
    return d;
  };

  /* ==========================================================
     连接自检 + 服务器地址面板
     ----------------------------------------------------------
     只在「真的可能连不上」时才探测，避免给每个页面平白加一次请求：
       · base 为空（同源）→ 页面本身就是后端发的，不必探
       · base 非空         → 探一次 /api/health，失败才弹面板
       · file://           → 必然连不上，直接弹面板
     ========================================================== */

  function probe(url, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var ctrl = null;
      try { ctrl = new AbortController(); } catch (e) { /* 老内核无 AbortController */ }

      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { ctrl && ctrl.abort(); } catch (e) { /* ignore */ }
        // 措辞不写死「电脑防火墙」：线上部署超时通常是安全组没放行端口，
        // 局域网才多半是本机防火墙，两者不能混为一谈。
        resolve({ ok: false, reason: '超时（4 秒没有响应，地址不对、端口没开放或服务没启动）' });
      }, timeoutMs || 4000);

      fetch(url, { method: 'GET', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          if (done) return;
          done = true; clearTimeout(timer);
          resolve(r.ok ? { ok: true } : { ok: false, reason: '服务器返回 HTTP ' + r.status });
        })
        .catch(function (e) {
          if (done) return;
          done = true; clearTimeout(timer);
          resolve({ ok: false, reason: '网络不通（' + (e && e.message ? e.message : '无法连接') + '）' });
        });
    });
  }

  /** 注入一个「服务器地址」面板，样式与项目一致（暖橄榄绿 + 米白） */
  function showPanel(reason) {
    if (document.getElementById('axApiPanel')) return;

    var css = ''
      + '#axApiMask{position:fixed;inset:0;z-index:2147483000;background:rgba(38,44,40,.42);'
      + 'display:flex;align-items:center;justify-content:center;padding:20px;'
      + 'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}'
      + '#axApiPanel{width:100%;max-width:420px;background:#FAF6EC;border-radius:20px;padding:22px 20px 18px;'
      + 'box-shadow:0 18px 48px rgba(62,74,66,.28);color:#3E4A42}'
      + '#axApiPanel h3{margin:0 0 6px;font-size:16px;font-weight:600;color:#3E4A42}'
      + '#axApiPanel .axr{font-size:12px;line-height:1.6;color:#B4603A;background:#FBEDE3;'
      + 'border-radius:10px;padding:8px 10px;margin:0 0 14px;word-break:break-all}'
      + '#axApiPanel .axl{font-size:12px;color:#8A968E;margin:0 0 6px}'
      + '#axApiPanel input{width:100%;box-sizing:border-box;border:1px solid #DCD5C3;border-radius:12px;'
      + 'padding:11px 12px;font-size:14px;background:#fff;color:#3E4A42;outline:none}'
      + '#axApiPanel input:focus{border-color:#4F7D66;box-shadow:0 0 0 3px rgba(79,125,102,.14)}'
      + '#axApiPanel .axhint{font-size:11px;line-height:1.65;color:#8A968E;margin:10px 0 16px}'
      + '#axApiPanel .axhint code{background:#EFEADC;border-radius:4px;padding:1px 5px;color:#4F7D66}'
      + '#axApiPanel .axbtns{display:flex;gap:10px}'
      + '#axApiPanel button{flex:1;border:0;border-radius:12px;padding:11px 0;font-size:14px;'
      + 'font-family:inherit;cursor:pointer}'
      + '#axApiPanel .axok{background:linear-gradient(135deg,#5C8C73,#4F7D66);color:#fff;'
      + 'box-shadow:0 6px 16px rgba(79,125,102,.28)}'
      + '#axApiPanel .axcancel{background:#EFEADC;color:#6F7C74}'
      + '#axApiPanel .axmsg{font-size:12px;margin:10px 0 0;min-height:16px;color:#8A968E}'
      + '#axApiPanel .axmsg.bad{color:#B4603A}'
      + '#axApiPanel .axmsg.good{color:#4F7D66}'
      + '#axApiPanel .axlink{display:block;width:100%;text-align:center;font-size:12px;color:#4F7D66;'
      + 'margin:14px 0 0;background:none;border:0;padding:0;text-decoration:underline;'
      + 'cursor:pointer;flex:none;font-family:inherit}';

    var st = document.createElement('style');
    st.id = 'axApiPanelStyle';
    st.textContent = css;
    document.head.appendChild(st);

    // 提示文案按场景分流：让人看到的是自己这一种情况该怎么查，
    // 而不是在云服务器上被建议「检查电脑防火墙」。
    var lan = isLanDebug();
    var label = lan ? '服务器地址（电脑的局域网 IP + 端口）' : '接口地址（一般与应用地址相同）';
    var placeholder = lan ? 'http://192.168.1.10:3000' : (location.origin || 'http://服务器IP');
    var hint = lan
      ? '怎么查：在电脑上打开 <code>双击启动Web应用.bat</code>，窗口里会直接打印'
        + '<code>手机访问：http://电脑IP:3000</code>，把这段地址填到上面即可。'
        + '手机要和电脑连同一个 WiFi。'
      : '若应用是用 nginx 部署的，直接填当前页面地址即可（例如 <code>'
        + (location.origin || 'http://服务器IP') + '</code>），不要带 <code>:3000</code>。'
        + '接口由 nginx 转发给后端，3000 端口本来就不对外开放。';

    var mask = document.createElement('div');
    mask.id = 'axApiMask';
    mask.innerHTML = ''
      + '<div id="axApiPanel">'
      + '  <h3>连不上服务器</h3>'
      + '  <p class="axr">' + (reason || '没有响应') + '</p>'
      + '  <p class="axl">' + label + '</p>'
      + '  <input id="axApiInput" type="text" inputmode="url" autocomplete="off" spellcheck="false"'
      + '         placeholder="' + placeholder + '">'
      + '  <p class="axhint">' + hint + '</p>'
      + '  <div class="axbtns">'
      + '    <button class="axcancel" id="axApiCancel">先不设</button>'
      + '    <button class="axok" id="axApiSave">测试并保存</button>'
      + '  </div>'
      + '  <p class="axmsg" id="axApiMsg"></p>'
      + '  <button class="axlink" id="axApiReset">清空设置，改用当前页面地址</button>'
      + '</div>';
    document.body.appendChild(mask);

    var input = document.getElementById('axApiInput');
    var msg = document.getElementById('axApiMsg');
    input.value = base || fallbackBase() || location.origin || '';

    function say(text, cls) {
      msg.textContent = text;
      msg.className = 'axmsg' + (cls ? ' ' + cls : '');
    }

    document.getElementById('axApiCancel').onclick = function () {
      mask.parentNode.removeChild(mask);
    };

    // 兜底出口：以前存过错误地址（比如线上环境填了 :3000）时，
    // 让人一键退回同源，不用猜该填什么。
    document.getElementById('axApiReset').onclick = function () {
      try { localStorage.removeItem(LS_KEY); } catch (e) { /* 隐私模式，忽略 */ }
      try {
        var u = new URL(location.href);
        u.searchParams.delete('api');
        location.replace(u.toString());
      } catch (e) {
        location.reload();
      }
    };

    document.getElementById('axApiSave').onclick = function () {
      var v = normalize(input.value);
      if (!v) { say('地址不能为空', 'bad'); return; }
      say('正在测试…');
      probe(v + HEALTH_PATH, 5000).then(function (r) {
        if (r.ok) {
          saveBase(v);
          say('连接成功，正在刷新…', 'good');
          setTimeout(function () {
            // 地址栏里的 ?api= 优先级最高，不清掉的话刷新后又会盖住刚保存的地址
            try {
              var u = new URL(location.href);
              u.searchParams.delete('api');
              location.replace(u.toString());
            } catch (e) {
              location.reload();
            }
          }, 500);
        } else {
          say('还是连不上：' + r.reason, 'bad');
        }
      });
    };

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') document.getElementById('axApiSave').click();
    });
  }

  /**
   * 对外暴露：任何一次真实请求失败时（api.js 的 catch）都可以直接把面板叫出来。
   * 比启动时探测更准 —— 探测通过但中途断网、或后端崩了，也能就地改地址。
   */
  window.AX_SHOW_PANEL = function (reason) {
    showPanel(reason || '无法连接服务器');
  };

  function boot() {
    // 本地文件打开：拿不到任何服务器信息，只能让人手填一次
    if (location.protocol === 'file:') {
      showPanel('当前是本地文件打开（file://），拿不到服务器地址，需要手动填一次。');
      return;
    }

    // 同源（base 为空）：页面就是这个后端发的，后端必然在线，不做多余请求。
    // 万一静态资源能拿到、接口却挂了，js/api.js 第一次真实请求失败时会调 AX_SHOW_PANEL，
    // 那时候再弹面板，比开机就探一次更准，也不给每个页面平白加一个请求。
    if (!base) return;

    // 手动指定过地址（?api= / 本机保存 / MANUAL_BASE）：值得确认它现在还通
    probe(base + HEALTH_PATH, 4000).then(function (r) {
      if (!r.ok) showPanel('无法访问 ' + base + '　·　' + r.reason);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
