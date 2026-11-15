/**
 * AI 用药助手接口验证脚本
 * 用法：BASE_URL=http://127.0.0.1:3100 node scripts/probe-assistant.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';

async function main() {
  // 1. 子女登录
  const lg = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ASST_TEST_USER || 'wang_owner', password: process.env.ASST_TEST_PASS || 'medbox2026' }),
  });
  const lgData = await lg.json();
  if (!lgData.accessToken) {
    console.log('[FAIL] 登录失败：', JSON.stringify(lgData));
    process.exit(1);
  }
  const token = lgData.accessToken;
  console.log('[OK] 子女登录成功，familyId =', lgData.familyId || '(响应未含，令牌内已带)');

  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  // 2. 主动建议
  const ins = await fetch(BASE + '/api/assistant/insights?days=7', { headers: H });
  const insData = await ins.json();
  console.log('\n=== GET /api/assistant/insights (days=7) → HTTP', ins.status, '===');
  console.log('summary:', JSON.stringify(insData.summary));
  (insData.insights || []).forEach((it, i) => {
    console.log(`  [${i + 1}] ${it.priority} / ${it.type} | ${it.title}`);
    console.log(`       ${it.body}`);
  });

  // 3. 主动问答：药物相互作用
  const q1 = await fetch(BASE + '/api/assistant/ask', {
    method: 'POST', headers: H,
    body: JSON.stringify({ question: '阿司匹林和布洛芬能一起吃吗' }),
  });
  const q1Data = await q1.json();
  console.log('\n=== POST /api/assistant/ask（药物相互作用）→ HTTP', q1.status, '===');
  console.log('answer:', q1Data.answer);
  console.log('sources:', JSON.stringify(q1Data.sources));

  // 4. 主动问答：漏服
  const q2 = await fetch(BASE + '/api/assistant/ask', {
    method: 'POST', headers: H,
    body: JSON.stringify({ question: '我妈今天早上忘记吃药了怎么办' }),
  });
  const q2Data = await q2.json();
  console.log('\n=== POST /api/assistant/ask（漏服）→ HTTP', q2.status, '===');
  console.log('answer:', q2Data.answer);

  // 5. 异常：缺 question
  const q3 = await fetch(BASE + '/api/assistant/ask', {
    method: 'POST', headers: H, body: JSON.stringify({}),
  });
  console.log('\n=== POST /api/assistant/ask（缺 question）→ HTTP', q3.status, '===', await q3.text());

  // 6. 越权：老人端（device）令牌调 insights 应 403
  console.log('\n（device 令牌越权用例见 probe-device-session.js，此处仅验证子女端正常链路）');
}

main().catch((e) => { console.error('[ERR]', e); process.exit(1); });
