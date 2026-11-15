/**
 * 服务健康检查（给 .bat 启动器用）
 * -------------------------------------------------------------
 * 作用：3000 端口被占用时，判断「占着的那个」是不是本项目自己的服务。
 *
 * 为什么需要它：
 *   以前启动器一发现端口被占就直接要人输 Y 去 taskkill。
 *   但如果占用者是当前用户没权限结束的进程（例如被沙箱宿主托管的 node），
 *   taskkill 会失败，脚本 goto 回去重新检测 —— 于是陷入「反复问 Y」的死循环。
 *
 *   正确做法是先问一句「你还活着吗」：
 *     活着且是我们的服务 → 直接复用，根本不用杀；
 *     活着但不是我们的服务 → 确实要处理，但杀不掉时要明确告知，不能循环。
 *
 * 输出一律英文（调用方是 GBK 代码页的 cmd，中文会乱码）。
 * 退出码：0 = 是本项目服务且健康；1 = 端口没开的 / 不是本项目服务
 *
 * 用法：node scripts/health-probe.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const PORT = process.env.PORT || 3000;
const URL = `http://127.0.0.1:${PORT}/api/health`;

// 给 1.5 秒就够了：连不上通常立刻失败，不必让用户干等
const TIMEOUT = 1500;

(async () => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);

  try {
    const res = await fetch(URL, { signal: ctrl.signal });
    clearTimeout(timer);

    if (!res.ok) {
      console.log(`PORT BUSY: returns HTTP ${res.status} (not healthy)`);
      process.exitCode = 1;
      return;
    }

    const d = await res.json();

    // 认招牌：本项目 /api/health 固定返回 { ok:true, server:'up' }
    if (d.ok === true && d.server === 'up') {
      console.log(`RUNNING: smart-medbox is already serving on ${PORT}` +
        (d.mysql ? ` (mysql ${d.mysql.db})` : ''));
      process.exitCode = 0;
      return;
    }

    console.log('PORT BUSY: occupied by another program');
    process.exitCode = 1;
  } catch (e) {
    clearTimeout(timer);
    console.log('PORT BUSY: no valid response');
    process.exitCode = 1;
  }
})();
