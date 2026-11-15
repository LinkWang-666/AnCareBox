/**
 * 输出本机局域网 IP（给 .bat 用）
 * -------------------------------------------------------------
 * 用途：想用手机/平板演示老人端时，需要知道电脑在局域网里的地址。
 *       localhost 只有本机认得，手机访问必须用这个 IP。
 *
 * 为什么单独做一个脚本：
 *   一台机器往往有多个网卡（WiFi、有线、VMware/VirtualBox 虚拟网卡、
 *   WSL 虚拟网卡），ipconfig 会输出一大堆地址，挑错就访问不上。
 *   这里只挑「IPv4 + 非内部回流」的地址，并且优先给常见的局域网段。
 *
 * 输出：仅一个 IP 字符串（无 IP 时输出 127.0.0.1），方便 .bat 的 for /f 接收。
 * 用法：node scripts/print-lan-ip.js
 */
const os = require('os');

const all = [];
const ifaces = os.networkInterfaces();

for (const name of Object.keys(ifaces)) {
  for (const net of ifaces[name]) {
    // family 可能是 'IPv4' 字符串，也可能是数字 4（不同 Node 版本有差异）
    const isV4 = net.family === 'IPv4' || net.family === 4;
    if (isV4 && !net.internal) all.push({ name, address: net.address });
  }
}

// 优先级：192.168.*（家用路由器最常见） > 10.*（校园网/企业网） > 其他
function rank(addr) {
  if (addr.startsWith('192.168.')) return 0;
  if (addr.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 2; // 172.16-31 也是私网段
  return 3;
}

all.sort((a, b) => rank(a.address) - rank(b.address));

console.log(all.length ? all[0].address : '127.0.0.1');
