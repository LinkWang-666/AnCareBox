/**
 * 静态一致性检查：
 *  1) HTML 里重复的 id（会导致 JS 取错元素）
 *  2) 前端调用的接口路径是否都存在于后端路由（拼错就是 404）
 *  3) HTML 里引用的本地 js/css 文件是否存在
 * 用法：node _audit/consistency.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
let problems = 0;
const say = (s) => { console.log(s); };

function walk(dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(PUB);

/* ---------- 1. 重复 id ---------- */
say('=== 1. HTML 重复 id ===');
for (const f of files.filter((x) => x.endsWith('.html'))) {
  const html = fs.readFileSync(f, 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Map();
  ids.forEach((id) => seen.set(id, (seen.get(id) || 0) + 1));
  const dup = [...seen].filter(([, n]) => n > 1);
  if (dup.length) {
    problems += dup.length;
    say(`  ✗ ${path.basename(f)} 重复: ${dup.map(([k, n]) => k + '×' + n).join(', ')}`);
  }
}
say('  （无输出即全部唯一）');

/* ---------- 2. 前端接口路径 vs 后端路由 ---------- */
say('\n=== 2. 前端调用路径是否都有后端路由 ===');
const routeFiles = walk(path.join(ROOT, 'server')).filter((x) => x.endsWith('.js'));
const routes = [];
for (const f of routeFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
  let m;
  while ((m = re.exec(src))) {
    // 把 :id 一类转成正则
    let p = m[2].replace(/:[A-Za-z_]+/g, '__X__');
    // auth.js 单独挂在 /api/auth 下，其余挂在 /api 下；比对时统一成「去掉挂载前缀」的形式
    const base = path.basename(f) === 'auth.js' ? '/auth' : '';
    routes.push({ method: m[1].toUpperCase(), path: base + p, raw: m[2], file: path.basename(f) });
  }
}

// app.js 里还有直接 app.get 的
const appSrc = fs.readFileSync(path.join(ROOT, 'server', 'app.js'), 'utf8');
for (const m of appSrc.matchAll(/app\.(get|post|put|delete)\(\s*['"`]([^'"`]+)['"`]/g)) {
  routes.push({ method: m[1].toUpperCase(), path: m[2].replace(/:[A-Za-z_]+/g, '__X__'), raw: m[2], file: 'app.js' });
}

const frontFiles = walk(PUB).filter((x) => x.endsWith('.js'));
const calls = [];
for (const f of frontFiles) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /\bapi\.(get|post|put|del)\(\s*[`'"]([^`'"]+)[`'"]/g;
  let m;
  while ((m = re.exec(src))) {
    let p = m[2];
    if (!p.startsWith('/')) continue;
    p = p.split('?')[0].replace(/\$\{[^}]+\}/g, '__X__');
    calls.push({ method: m[1] === 'del' ? 'DELETE' : m[1].toUpperCase(), path: p, file: path.basename(f) });
  }
}

function matches(call) {
  // 前端常用 'xxx/' + id 的字符串拼接，捕获到的只是前缀，按前缀匹配
  const isPrefix = call.path.endsWith('/');
  return routes.some((r) => {
    if (r.method !== call.method) return false;
    if (isPrefix) return r.path.startsWith(call.path);
    const a = r.path.split('/').filter(Boolean);
    const b = call.path.split('/').filter(Boolean);
    if (a.length !== b.length) return false;
    return a.every((seg, i) => seg === '__X__' || b[i] === '__X__' || seg === b[i]);
  });
}

const seenCall = new Set();
for (const c of calls) {
  const k = c.method + ' ' + c.path;
  if (seenCall.has(k)) continue;
  seenCall.add(k);
  if (!matches(c)) {
    problems++;
    say(`  ✗ 前端调用 ${k}（${c.file}）在后端找不到对应路由`);
  }
}
say(`  共比对 ${seenCall.size} 个不同接口调用`);

/* ---------- 3. HTML 引用的本地资源是否存在 ---------- */
say('\n=== 3. HTML 引用的脚本/样式是否存在 ===');
for (const f of files.filter((x) => x.endsWith('.html'))) {
  const dir = path.dirname(f);
  const html = fs.readFileSync(f, 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const u = m[1];
    if (/^(https?:)?\/\//.test(u) || u.startsWith('data:') || u.startsWith('#')) continue;
    if (!/\.(js|css)$/.test(u.split('?')[0])) continue;
    const rel = u.startsWith('/') ? path.join(PUB, u.split('?')[0]) : path.join(dir, u.split('?')[0]);
    if (!fs.existsSync(rel)) { problems++; say(`  ✗ ${path.basename(f)} 引用了不存在的 ${u}`); }
  }
}
say('  （无输出即全部可解析）');

say(`\n合计问题：${problems}`);
