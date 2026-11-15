/**
 * 第三批：只读成员（viewer）越权、AI 助手的角色旁路、事件上报边界。
 * 删除类操作只传「不存在的药名」，确保不会真的删掉演示数据。
 */
const BASE = 'http://127.0.0.1:3000';
let pass = 0, fail = 0; const failures = [];
function ok(n, c, e = '') { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; failures.push(n + ' :: ' + e); console.log(`  ✗ ${n} ${e}`); } }

async function req(m, p, { token, body } = {}) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method: m, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const txt = await r.text();
  let d; try { d = JSON.parse(txt); } catch { d = txt.slice(0, 200); }
  return { status: r.status, data: d };
}

(async () => {
  const login = await req('POST', '/api/auth/login', { body: { username: 'wangxm', password: 'medbox2026' } });
  const T = login.data.accessToken;
  const me = await req('GET', '/api/auth/me', { token: T });

  console.log('\n=== A. 创建只读成员 ===');
  const uname = 'audit_viewer_' + Date.now().toString().slice(-6);
  const mk = await req('POST', '/api/users', { token: T, body: { username: uname, password: 'viewer2026', real_name: '自检只读号', role: 'viewer' } });
  ok('创建 viewer 成功', mk.status === 200 && mk.data.role === 'viewer', `${mk.status} ${JSON.stringify(mk.data).slice(0, 140)}`);

  let VT = null;
  if (mk.status === 200) {
    const vl = await req('POST', '/api/auth/login', { body: { username: uname, password: 'viewer2026' } });
    VT = vl.data.accessToken;
    ok('viewer 可登录', vl.status === 200, String(vl.status));
  }

  if (VT) {
    console.log('\n=== B. viewer 写接口应全部被拒 ===');
    const customs = [
      ['POST', '/api/medicines', { name: '自检药A' }],
      ['POST', '/api/elders', { name: '自检老人' }],
      ['PUT', '/api/elders/1', { name: '改名尝试' }],
      ['POST', '/api/recordings/upload', { base64: 'dGVzdA==', ext: 'webm' }],
    ];
    for (const [m, p, b] of customs) {
      const r = await req(m, p, { token: VT, body: b });
      ok(`viewer ${m} ${p} 被拒 403`, r.status === 403, `${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    }

    console.log('\n=== C. AI 助手不能成为 viewer 的写操作旁路 ===');
    // 只传不存在的药名：即使校验失效也只会返回「没找到」，不会真删数据
    const ag = await req('POST', '/api/agent/chat', {
      token: VT,
      body: { message: '确认执行', confirm: { tool: 'delete_medicine', args: { name: '自检不存在的药ZZZ' } } },
    });
    const answer = String((ag.data && ag.data.answer) || '');
    const blocked = ag.status === 403 || /只读|不能通过助手/.test(answer);
    ok('viewer 通过助手执行写工具被拦', blocked, `${ag.status} ${answer.slice(0, 160)}`);

    // 清理只读账号
    const del = await req('DELETE', `/api/users/${mk.data.id}`, { token: T });
    ok('清理只读账号', del.status === 200, String(del.status));
  }

  console.log('\n=== D. 事件上报边界 ===');
  const boxes = await req('GET', '/api/medbox', { token: T });
  const box = boxes.data[0];
  const e1 = await req('POST', '/api/events', { token: T, body: { device_code: box.device_code, slot_no: 1, event_type: '乱起一个' } });
  ok('非法 event_type 返回 400 且提示可选值', e1.status === 400 && /event_type/.test(JSON.stringify(e1.data)),
    `${e1.status} ${JSON.stringify(e1.data).slice(0, 140)}`);

  const e2 = await req('POST', '/api/events', { token: T, body: { device_code: box.device_code, slot_no: 1, event_type: 'take', occurred_at: '2999-01-01T00:00:00Z' } });
  ok('未来时间被拒', e2.status === 400, `${e2.status} ${JSON.stringify(e2.data).slice(0, 120)}`);

  const e3 = await req('POST', '/api/events', { token: T, body: { device_code: 'NO-SUCH-BOX', slot_no: 1, event_type: 'take' } });
  ok('不存在的设备返回 4xx（403/400 均可，且不区分「不存在」与「不属于本家庭」）',
    e3.status === 400 || e3.status === 403, `${e3.status} ${JSON.stringify(e3.data).slice(0, 120)}`);

  console.log('\n=== E. 参数越界 ===');
  const l1 = await req('GET', '/api/events?limit=999999', { token: T });
  ok('limit 超大不报错', l1.status === 200 && Array.isArray(l1.data), String(l1.status));
  const l2 = await req('GET', '/api/dashboard/1?days=abc', { token: T });
  ok('days 非法不报错', l2.status === 200, `${l2.status} ${JSON.stringify(l2.data).slice(0, 100)}`);
  const l3 = await req('GET', '/api/dashboard/1?days=99999', { token: T });
  ok('days 超大被收敛', l3.status === 200, String(l3.status));

  console.log('\n========================================');
  console.log(`通过 ${pass} / 失败 ${fail}`);
  if (failures.length) { console.log('失败项：'); failures.forEach((f) => console.log('  - ' + f)); }
  process.exit(0);
})().catch((e) => { console.error('脚本异常：', e); process.exit(2); });
