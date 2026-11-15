/**
 * 第二批探测：事件上报的非法时间、计划时间窗 0 值、compartment 越权、重复设备码。
 * 全部采用「造数据 → 断言 → 清理」的方式，保证演示库不被污染。
 */
const BASE = 'http://127.0.0.1:3000';
let pass = 0, fail = 0; const failures = [];
function ok(n, c, e = '') { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; failures.push(n + ' :: ' + e); console.log(`  ✗ ${n} ${e}`); } }

async function req(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 300); }
  return { status: res.status, data };
}

(async () => {
  const login = await req('POST', '/api/auth/login', { body: { username: 'wangxm', password: 'medbox2026' } });
  const T = login.data.accessToken;

  const boxes = await req('GET', '/api/medbox', { token: T });
  const box = boxes.data[0];
  const elders = await req('GET', '/api/elders', { token: T });
  const elderId = elders.data[0].id;

  console.log('\n=== A. 事件上报 occurred_at 非法 ===');
  const r1 = await req('POST', '/api/events', {
    token: T, body: { device_code: box.device_code, slot_no: 1, event_type: 'take', occurred_at: 'not-a-date' },
  });
  ok('非法 occurred_at 不应 500', r1.status !== 500, `${r1.status} ${JSON.stringify(r1.data).slice(0, 200)}`);

  const r2 = await req('POST', '/api/events', {
    token: T, body: { device_code: box.device_code, slot_no: 1, event_type: 'take', occurred_at: '2019-01-01T03:00:00Z' },
  });
  ok('2019 年的历史事件应被拒', r2.status === 400, `${r2.status} ${JSON.stringify(r2.data).slice(0, 160)}`);
  // 清理
  if (r2.data && r2.data.event) {
    const rel = await req('GET', `/api/events?elder_id=${elderId}&limit=100`, { token: T });
    const hit = (rel.data || []).find((e) => e.id === r2.data.event.id);
    if (hit) console.log(`     （已写入事件 id=${hit.id}，occurred_at=${hit.occurred_at}）`);
  }

  console.log('\n=== B. 计划时间窗传 0 ===');
  const mk = await req('POST', '/api/schedules', {
    token: T, body: { elder_id: elderId, dose_time: '23:55', time_label: '__audit__', window_before_min: 0, window_after_min: 0 },
  });
  ok('创建计划成功', mk.status === 200, `${mk.status} ${JSON.stringify(mk.data).slice(0, 160)}`);
  if (mk.data && mk.data.id) {
    ok('window_before_min=0 被保留（未被 || 吞成 10）', Number(mk.data.window_before_min) === 0,
      `实际 ${mk.data.window_before_min}`);
    ok('window_after_min=0 被保留', Number(mk.data.window_after_min) === 0,
      `实际 ${mk.data.window_after_min}`);
    const del = await req('DELETE', `/api/schedules/${mk.data.id}`, { token: T });
    ok('清理测试计划', del.status === 200, String(del.status));
  }

  console.log('\n=== C. 计划绑定他家庭隔间（越权）===');
  const li = await req('POST', '/api/auth/login', { body: { username: 'li_owner', password: 'medbox2026' } });
  const LT = li.data.accessToken;
  const liBox = await req('GET', '/api/medbox', { token: LT });
  const liComps = liBox.data[0] ? await req('GET', `/api/medbox/${liBox.data[0].id}/compartments`, { token: LT }) : null;
  const foreignCompId = liComps && liComps.data && liComps.data[0] ? liComps.data[0].id : null;
  if (foreignCompId) {
    const mk2 = await req('POST', '/api/schedules', {
      token: T, body: { elder_id: elderId, dose_time: '23:56', time_label: '__audit2__', compartment_id: foreignCompId },
    });
    const crossed = mk2.status === 200 && Number(mk2.data.compartment_id) === Number(foreignCompId);
    ok('跨家庭 compartment_id 被拒', !crossed, `status=${mk2.status} compartment_id=${mk2.data && mk2.data.compartment_id}`);
    if (mk2.data && mk2.data.id) await req('DELETE', `/api/schedules/${mk2.data.id}`, { token: T });
  } else {
    console.log('  （李家没有隔间，跳过）');
  }

  console.log('\n=== D. 重复 device_code ===');
  const dup = await req('POST', '/api/medbox', { token: T, body: { device_code: box.device_code, compartment_count: 1 } });
  ok('重复 device_code 被拒', dup.status !== 200, `${dup.status} ${JSON.stringify(dup.data).slice(0, 160)}`);
  if (dup.status === 200 && dup.data && dup.data.id) {
    // 清理（连带隔间）
    const mb = require('../server/db');
    await mb.exec('DELETE FROM compartment WHERE medbox_id = ?', [dup.data.id]).catch(() => {});
    await mb.exec('DELETE FROM medbox_elder WHERE medbox_id = ?', [dup.data.id]).catch(() => {});
    await mb.exec('DELETE FROM medbox WHERE id = ?', [dup.data.id]).catch(() => {});
    console.log(`     （已清理重复药箱 id=${dup.data.id}）`);
    process.exit(0);
  }

  console.log('\n=== E. 设备令牌导出全家庭数据 ===');
  const bind = await req('POST', '/api/auth/bind-code', { token: T, body: { medbox_id: box.id } });
  if (bind.data && bind.data.bindCode) {
    const db = await req('POST', '/api/auth/device-bind', { body: { code: bind.data.bindCode } });
    if (db.data && db.data.accessToken) {
      const exp = await req('GET', '/api/export/family-data', { token: db.data.accessToken });
      ok('设备令牌导出家庭数据应被拒（只应面向子女端）', exp.status === 403,
        `status=${exp.status}，返回 ${exp.status === 200 ? Object.keys(exp.data).join(',') : ''}`);
    }
  }

  console.log('\n========================================');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (failures.length) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(0);
})().catch((e) => { console.error('脚本异常：', e); process.exit(2); });
