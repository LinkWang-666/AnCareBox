/**
 * 智能药箱 · 家庭用药协同系统 —— Web 服务入口
 * 启动：npm start      然后浏览器打开 http://localhost:3000
 */
const path = require('path');
const os = require('os');

// dotenv 必须显式指定路径，否则换个目录启动就读不到 .env
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { ping } = require('./db');
const authRoutes = require('./routes/auth');
const configRoutes = require('./routes/config');
const runtimeRoutes = require('./routes/runtime');
const assistantRoutes = require('./routes/assistant');
const agentRoutes = require('./routes/agent');
const deviceRoutes = require('./routes/device');
const { isDefaultSecret } = require('./services/auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);

/**
 * 反向代理支持：部署在 nginx / 云负载均衡后面时必须开启。
 * 不开的话 req.ip 永远是 127.0.0.1，全局限流会把所有访客算成同一个来源，
 * 审计日志里的登录 IP 也全部失真。TRUST_PROXY=1 表示信任前面一层代理。
 */
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
}

// 安全响应头（X-Frame-Options / X-Content-Type-Options 等）
// 这里关掉 CSP：演示项目的前端有内联样式和脚本，开启会被浏览器拦下。
// 生产环境应当开启 CSP，并把内联内容改成外链文件。
app.use(helmet({ contentSecurityPolicy: false }));

/**
 * 跨域策略：只放行「本机 + 局域网 + 显式白名单」，不再反射任意 Origin。
 *
 * 为什么不写 origin: true：
 *   它会把请求里的 Origin 原样回写进 Access-Control-Allow-Origin，
 *   等于对任何网站开放。配合 credentials: true，一个陌生页面就能带着
 *   用户已登录的 Cookie 去调本服务 —— 这正是 CSRF 的标准入口。
 *   本项目前后端同源部署（同一个 3000 端口），手机端也是同源访问，
 *   正常使用根本不需要跨域，所以收紧不会影响任何真实场景。
 *
 * 需要对外提供服务时，在 .env 里用 CORS_ORIGINS 追加正式域名（逗号分隔）。
 */
const EXTRA_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const LOOPBACK_OR_LAN =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$/i;

app.use(cors({
  origin(origin, cb) {
    // 同源请求 / curl / 部分移动端 WebView 不带 Origin，直接放行
    if (!origin) return cb(null, true);
    if (LOOPBACK_OR_LAN.test(origin)) return cb(null, true);
    if (EXTRA_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false); // 不回 ACAO 头，浏览器自行拦截
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));           // 录音以 base64 上传，体积较大
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());                            // 解析 httpOnly 的刷新令牌

// 全局限流：单 IP 每分钟最多 300 次请求，挡住粗暴的扫描和爆破
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
}));

// 根路径：默认进入「介绍页」（长页落地），作为整个产品的门面
app.get('/', (req, res) => res.redirect('/landing.html'));

// 静态资源：public 下放前端页面
//
// 为什么要单独设 Cache-Control：
//   默认配置下浏览器会强缓存 api.js / elder.js 这类文件。改完代码重启服务后，
//   页面跑的还是旧逻辑 —— 表现为「明明修好了却还是报错」，极难自查。
//   no-cache 要求每次使用前回来校验（ETag 不变就返回 304），既拿到最新代码，
//   又不牺牲太多性能。配合 HTML 里的 ?v= 版本号，双保险。
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// 健康检查：不需要登录，方便排障
app.get('/api/health', async (req, res) => {
  try {
    const info = await ping();
    res.json({ ok: true, server: 'up', mysql: info });
  } catch (e) {
    res.status(500).json({ ok: false, server: 'up', mysql: 'down', error: e.message });
  }
});

// 认证接口（登录/刷新/登出/改密/注册/绑定码）—— 不需要已登录
app.use('/api/auth', authRoutes);

// 其余业务接口 —— 内部各自挂了 requireAuth
// 设备侧（实物药箱）单独一个命名空间：/api/device/*
// 单独挂载的理由：硬件接口的鉴权、限流、错误语义都和网页不同，
// 混在 /api 里以后加设备版本号（v1/v2 并存）会非常难受。
app.use('/api/device', deviceRoutes);

app.use('/api', configRoutes);
app.use('/api', runtimeRoutes);
app.use('/api', assistantRoutes);
app.use('/api', agentRoutes);

/**
 * 统一错误处理：把 express.json() 的解析失败转成 JSON 响应。
 *
 * 为什么要专门处理：
 *   客户端发来一个畸形 JSON（比如字面量 null、缺引号、截断的数据），
 *   Express 默认会甩出一整个 HTML 错误页给前端。
 *   前端 fetch 拿到 HTML，res.json() 直接抛异常，
 *   界面上只剩下「请求失败」，排查时根本看不出是自己传的数据有问题。
 *   统一转成 { error, code } 后，前端直接能把原因显示出来。
 */
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      error: '请求数据格式有误，无法解析',
      code: 'BAD_JSON',
      detail: String(err.message || '').slice(0, 120),
    });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '上传内容过大', code: 'PAYLOAD_TOO_LARGE' });
  }
  console.error('未处理的异常：', err);
  res.status(500).json({ error: '服务内部异常', code: 'INTERNAL', detail: String(err && err.message || '').slice(0, 120) });
});

// 兜底：未匹配返回 404 JSON
app.use((req, res) => res.status(404).json({ error: `接口不存在：${req.method} ${req.originalUrl}` }));

/**
 * 找出本机的局域网 IPv4 —— 就是手机要访问的那个地址。
 *
 * 为什么不能「取第一个网卡」：
 *   Windows 上几乎每台装过开发工具的电脑都有一堆虚拟网卡（VMware、VirtualBox、
 *   Hyper-V、WSL、Docker），而且枚举顺序随系统变化。取错了就会打印一个手机
 *   永远连不上的地址 —— 比不打印更误导人，用户会以为是程序坏了。
 *
 * 做法：只认三个私有网段（192.168 / 10. / 172.16-31），再按网卡名排掉已知的虚拟设备。
 *   192.168 排最前（家用路由器和手机热点最常见），其次 10.x，最后 172.16-31。
 */
function lanAddresses() {
  const virtual = /(vmware|virtualbox|vbox|hyper-?v|vethernet|wsl|docker|loopback|bluetooth|tap|tun|npcap|虚拟)/i;
  const hits = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (virtual.test(name)) continue;
    for (const item of list || []) {
      const v4 = (item.family === 'IPv4' || item.family === 4) ? item : null;
      if (!v4 || v4.internal) continue;
      if (!/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(v4.address)) continue;
      hits.push({ name, address: v4.address });
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return hits.sort((a, b) => rank(a.address) - rank(b.address));
}

const server = app.listen(PORT, async () => {
  console.log('==================================================');
  console.log('  智能药箱 · 家庭用药协同系统  （已启用 JWT 鉴权）');
  console.log('==================================================');
  try {
    const info = await ping();
    console.log(`  MySQL  : 已连接  ${info.db} (${info.version})`);
  } catch (e) {
    console.log(`  MySQL  : 连接失败 —— ${e.message}`);
    console.log('           请检查 .env 中的 DB_PASSWORD，并确认 MySQL80 服务已启动');
  }
  if (isDefaultSecret) {
    console.log('  ⚠ 警告 : 正在使用默认 JWT 密钥，生产环境必须在 .env 中设置 JWT_SECRET');
  }
  console.log(`  登录页 : http://localhost:${PORT}/login.html`);
  console.log(`  子女端 : http://localhost:${PORT}/index.html`);
  console.log(`  老人端 : http://localhost:${PORT}/elder.html`);

  // 手机端地址：每次启动现场探测，换个 WiFi / 重开热点就自动变，不用再手敲 ipconfig 查
  const lan = lanAddresses();
  console.log('--------------------------------------------------');
  if (lan.length) {
    console.log('  手机访问（前提：手机和电脑连同一个 WiFi）:');
    lan.forEach((it) => {
      console.log(`    http://${it.address}:${PORT}/m/        网卡 ${it.name}`);
    });
    if (lan.length > 1) {
      console.log('    ↑ 有多个地址时挨个试，能打开的那个就是对的');
    }
    console.log(`  手机看老人端 : http://${lan[0].address}:${PORT}/elder.html`);
    console.log('  手机打不开时按顺序查:');
    console.log('    1) 手机和电脑是否同一个 WiFi（别一个连主网络、一个连访客网络）');
    console.log('    2) Windows 防火墙是否放行 Node（首次运行会弹窗，要选「允许访问」）');
    console.log('    3) 手机浏览器地址别用 https，本服务是 http');
  } else {
    console.log('  手机访问 : 没检测到局域网地址 —— 电脑可能没连 WiFi / 网线');
  }
  console.log('==================================================');
});

// 端口被占用时给出人话提示，而不是抛一堆红色堆栈
// 常见场景：服务已经开着，用户又双击了一次启动脚本
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.log('');
    console.log('==================================================');
    console.log(`  端口 ${PORT} 已被占用，服务很可能已经在运行。`);
    console.log(`  直接打开浏览器访问： http://localhost:${PORT}`);
    console.log('  若想重启：先关闭原来那个黑窗口，再重新运行本脚本。');
    console.log('==================================================');
    process.exit(1);
  }
  console.error('服务启动失败：', err);
  process.exit(1);
});
