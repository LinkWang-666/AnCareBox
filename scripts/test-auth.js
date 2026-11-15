/**
 * 鉴权自检脚本 —— 逐条验证「登录、隔离、越权拦截、令牌吊销」
 *
 * 运行前先启动服务：npm start
 * 然后：npm run test:auth
 *
 * 为什么要写这个脚本：
 *   安全性不能依赖主观判断。
 *   横向越权的典型特征就是——正常操作一切正常，换个 id 才暴露。
 *   所以每一条都要真发请求、真看状态码。
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const API = BASE + '/api';
const PWD = 'medbox2026';

let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? '  -> ' + extra : ''}`); }
  if (extra && cond) console.log(`         ${extra}`);
}

async function req(method, p, body, token) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opt.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined && body !== null) opt.body = JSON.stringify(body);
  const r = await fetch(API + p, opt);
  let d = {};
  try { d = await r.json(); } catch (e) { /* 非 JSON 响应 */ }
  return { status: r.status, data: d };
}

const login = (u, p) => req('POST', '/auth/login', { username: u, password: p });

(async function main() {
  console.log('==================================================');
  console.log('  鉴权自检');
  console.log('==================================================\n');

  // ---------- 1. 未登录拦截 ----------
  console.log('1. 未登录访问');
  let r = await req('GET', '/elders');
  ok('未带令牌返回 401', r.status === 401, `实际 ${r.status} ${r.data.error || ''}`);

  r = await req('GET', '/medicines');
  ok('药品列表同样被拦', r.status === 401, `实际 ${r.status}`);

  r = await req('POST', '/events', { device_code: 'MB-2026-0001', slot_no: 1 });
  ok('伪造服药记录被拦', r.status === 401, `实际 ${r.status}`);

  r = await req('POST', '/sos', { elder_id: 1 });
  ok('伪造求救被拦', r.status === 401, `实际 ${r.status}`);

  // ---------- 2. 登录 ----------
  console.log('\n2. 登录');
  const wang = await login('wang_owner', PWD);
  ok('王家 owner 登录成功', wang.status === 200 && !!wang.data.accessToken,
    wang.data.error || `${wang.data.user && wang.data.user.realName}`);
  const wToken = wang.data.accessToken;

  const li = await login('li_owner', PWD);
  ok('李家 owner 登录成功', li.status === 200 && !!li.data.accessToken,
    li.data.error || `${li.data.user && li.data.user.realName}`);
  const lToken = li.data.accessToken;

  const bad = await login('wang_owner', 'wrong-password');
  ok('错误密码被拒', bad.status === 401, `实际 ${bad.status}`);

  // ---------- 3. 数据隔离 ----------
  console.log('\n3. 家庭数据隔离');
  r = await req('GET', '/elders', null, wToken);
  const wElders = Array.isArray(r.data) ? r.data : [];
  ok('王家只看到自己家的老人', wElders.length === 1 && wElders[0].family_id === 1,
    `看到 ${wElders.length} 位：${wElders.map((e) => e.name).join('、')}`);

  r = await req('GET', '/elders', null, lToken);
  const lElders = Array.isArray(r.data) ? r.data : [];
  ok('李家只看到自己家的老人', lElders.length === 1 && lElders[0].name === '李奶奶',
    `看到 ${lElders.length} 位：${lElders.map((e) => e.name).join('、')}`);

  r = await req('GET', '/medicines', null, lToken);
  const lMeds = Array.isArray(r.data) ? r.data : [];
  ok('李家药品列表不含王家药品',
    lMeds.length > 0 && !lMeds.some((m) => m.id === 1),
    `李家药品 ${lMeds.length} 种：${lMeds.map((m) => m.name).join('、')}`);

  // ---------- 4. 横向越权拦截 ----------
  console.log('\n4. 横向越权拦截（换 id 去碰别人家的东西）');
  r = await req('GET', '/elders/1', null, lToken);
  ok('李家访问王家老人档案 → 403', r.status === 403, `实际 ${r.status} ${r.data.error || ''}`);

  r = await req('GET', '/schedules/1', null, lToken);
  ok('李家访问王家服药计划 → 403', r.status === 403, `实际 ${r.status} ${r.data.error || ''}`);

  r = await req('PUT', '/medicines/1', { stock_qty: 999 }, lToken);
  ok('李家修改王家药品 → 403', r.status === 403, `实际 ${r.status}`);

  r = await req('DELETE', '/medicines/1', null, lToken);
  ok('李家删除王家药品 → 403', r.status === 403, `实际 ${r.status}`);

  r = await req('POST', '/events', {
    device_code: 'MB-2026-0001', slot_no: 1, event_type: 'take', source: 'attack',
  }, lToken);
  ok('李家用王家药箱编号伪造服药 → 403', r.status === 403, `实际 ${r.status} ${r.data.error || ''}`);

  r = await req('POST', '/sos', { elder_id: 1 }, lToken);
  ok('李家伪造王家老人求救 → 403', r.status === 403, `实际 ${r.status}`);

  r = await req('GET', '/dashboard/1', null, lToken);
  ok('李家查看王家依从性看板 → 403', r.status === 403, `实际 ${r.status}`);

  // ---------- 5. 本人正常操作 ----------
  console.log('\n5. 本人正常操作不受影响');
  r = await req('GET', '/elders/1', null, wToken);
  ok('王家访问自己老人 → 200', r.status === 200, `实际 ${r.status}`);

  r = await req('GET', '/dashboard/1', null, wToken);
  ok('王家查看自己看板 → 200', r.status === 200,
    r.status === 200 ? `依从率 ${r.data.rate}%` : r.data.error);

  r = await req('POST', '/events', {
    device_code: 'MB-2026-0001', slot_no: 1, event_type: 'take', dose_qty: 1, source: 'simulator',
  }, wToken);
  ok('王家上报服药事件 → 成功', r.status === 200 && !!r.data.event,
    r.status === 200 ? `判定 ${r.data.event.result}` : r.data.error);

  // 【回归用例】不带 elder_id 查「全家庭计划」——子女端首屏就是这么调的。
  // 这条 SQL 曾把 elder 表别名写成 el、而 WHERE 里写 e.family_id，
  // 导致 MySQL 报 Unknown column，页面首屏直接弹红色错误条。
  // 因为自检脚本以前没覆盖这条路径，这个 bug 一直没被发现，所以固定补上。
  r = await req('GET', '/schedules', null, wToken);
  ok('子女端首屏：查全部服药计划 → 200', r.status === 200,
    r.status === 200 ? `共 ${Array.isArray(r.data) ? r.data.length : 0} 条计划`
      : `${r.status} ${r.data.error || ''}`);

  ok('计划列表带出隔间格号（用于「到点只开一格」）',
    r.status === 200 && Array.isArray(r.data) && r.data.some((x) => x.slot_no !== undefined),
    r.status === 200 ? '' : r.data.error);

  // ---------- 6. 角色权限 ----------
  console.log('\n6. 角色权限');
  const mem = await login('wang_member', PWD);
  const mToken = mem.data.accessToken;
  ok('王家 member 登录成功', mem.status === 200);

  r = await req('POST', '/medicines', { name: '测试药', unit: '片' }, mToken);
  ok('member 可以新增药品', r.status === 200, `实际 ${r.status}`);
  const newMedId = r.data && r.data.id;

  if (newMedId) {
    r = await req('DELETE', '/medicines/' + newMedId, null, mToken);
    ok('member 不能删除药品（仅 owner 可删）→ 403', r.status === 403, `实际 ${r.status}`);
    // 清理：由 owner 删除
    await req('DELETE', '/medicines/' + newMedId, null, wToken);
  }

  // ---------- 7. 设备令牌 ----------
  console.log('\n7. 药箱设备令牌');
  r = await req('POST', '/auth/bind-code', { medbox_id: 1 }, wToken);
  ok('子女端生成绑定码', r.status === 200 && !!r.data.bindCode,
    r.status === 200 ? `绑定码 ${r.data.bindCode}（${r.data.expiresIn}）` : r.data.error);
  const bindCode = r.data.bindCode;

  if (bindCode) {
    r = await req('POST', '/auth/device-bind', { code: bindCode });
    ok('药箱凭绑定码换到令牌', r.status === 200 && !!r.data.accessToken,
      r.status === 200 ? `绑定老人：${r.data.elder && r.data.elder.name}` : r.data.error);
    const dToken = r.data.accessToken;

    if (dToken) {
      r = await req('GET', '/events/today', null, dToken);
      ok('设备令牌可读取今日计划', r.status === 200,
        r.status === 200 ? `老人ID ${r.data.elderId}` : r.data.error);

      r = await req('GET', '/elders', null, dToken);
      const dElders = Array.isArray(r.data) ? r.data : [];
      ok('设备只看得到自己绑定的老人', dElders.length === 1, `看到 ${dElders.length} 位`);

      r = await req('POST', '/medicines', { name: '设备偷偷加的药', unit: '片' }, dToken);
      ok('设备令牌不能改配置 → 403', r.status === 403, `实际 ${r.status}`);

      r = await req('POST', '/events', { slot_no: 1, event_type: 'take', source: 'device' }, dToken);
      ok('设备上报事件成功（且身份由令牌决定）', r.status === 200 && !!r.data.event,
        r.status === 200 ? `判定 ${r.data.event.result}` : r.data.error);

      // 解绑后令牌立即失效
      r = await req('POST', '/auth/device-unbind', { medbox_id: 1 }, wToken);
      ok('子女解绑药箱', r.status === 200, r.data.message || r.data.error);

      r = await req('GET', '/events/today', null, dToken);
      ok('解绑后旧设备令牌立即失效 → 401', r.status === 401, `实际 ${r.status}`);
    }
  }

  // ---------- 8. 改密后旧令牌失效 ----------
  console.log('\n8. 改密后令牌吊销');
  const tmpUser = 'tmp_' + Date.now().toString().slice(-6);
  const reg = await req('POST', '/auth/register', {
    username: tmpUser, password: PWD, familyName: '临时家庭', realName: '临时用户',
  });
  ok('注册新家庭成功', reg.status === 200 && !!reg.data.accessToken, reg.data.error);
  const tmpToken = reg.data.accessToken;

  if (tmpToken) {
    r = await req('POST', '/auth/change-password',
      { oldPassword: PWD, newPassword: 'newpass123' }, tmpToken);
    ok('改密成功', r.status === 200, r.data.message || r.data.error);

    r = await req('GET', '/auth/me', null, tmpToken);
    ok('改密后旧令牌立即失效 → 401', r.status === 401, `实际 ${r.status} ${r.data.code || ''}`);
  }

  // ---------- 9. 令牌伪造 ----------
  console.log('\n9. 令牌防伪造');
  r = await req('GET', '/elders', null, 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoidXNlciIsInVpZCI6MSwiZmlkIjoxLCJyb2xlIjoib3duZXIiLCJ0diI6MH0.fake-signature');
  ok('签名不对的令牌被拒 → 401', r.status === 401, `实际 ${r.status} ${r.data.code || ''}`);

  // ---------- 汇总 ----------
  console.log('\n==================================================');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('==================================================');

  // 自检本身是有副作用的，跑完必须收尾：
  //   · 第 7 节为了验证「解绑后旧设备令牌立即失效」，会把 MB-2026-0001 解绑，
  //     同时旧绑定码作废；
  //   · 第 8 节会额外注册一个临时家庭。
  // 不恢复的话，演示时老人端会弹「绑定码无效」的红色提示条，看着就像系统又坏了。
  // 所以这里自动重跑一次 seed-auth，把账号和绑定码修回可用的演示状态。
  console.log('\n正在恢复演示环境（重新签发绑定码）...');
  try {
    require('child_process').execSync(
      `"${process.execPath}" "${require('path').join(__dirname, 'seed-auth.js')}"`,
      { stdio: 'inherit' }
    );
    console.log('\n演示环境已恢复 —— README.md 3.4 节表格里的绑定码是最新可用的。');
  } catch (e) {
    console.log('\n[WARN] 自动恢复失败，请手动执行：node scripts/seed-auth.js');
  }
  process.exit(fail ? 1 : 0);
})();
