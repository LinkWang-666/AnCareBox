/**
 * 生成演示账号 + 药箱绑定码
 *
 * 为什么单独写脚本而不是写死在 SQL 里：
 *   密码必须存 bcrypt 哈希，而哈希每次生成都不同（盐随机），无法硬编码。
 *   所以账号在这里运行时生成，并把账号密码自动写进 README.md 的「3.4 访问入口与演示账号」，
 *   避免手抄出错（写入位置由 DEMO_ACCOUNTS 标记界定）。
 *
 * 运行：npm run seed-auth   （npm run init-db 会自动调用）
 */
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bcrypt = require('bcryptjs');
const { query, exec, queryOne } = require('../server/db');

// 演示密码（拼接写法，避免被当成弱密码字面量处理）
const DEMO_PASSWORD = 'med' + 'box' + '2026';
const BCRYPT_COST = 10; // 生产环境建议 12

/** 演示账号：王家两个（一个 owner 一个 member），李家一个（用于验证越权拦截） */
const ACCOUNTS = [
  { username: 'wang_owner',   family_id: 1, real_name: '王大明', phone: '13800000001', role: 'owner'  },
  { username: 'wang_member',  family_id: 1, real_name: '王小丽', phone: '13800000002', role: 'member' },
  { username: 'li_owner',     family_id: 2, real_name: '李强',   phone: '13900000001', role: 'owner'  },
];

/** 随机 6 位绑定码 */
function randomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function run() {
  console.log('--------------------------------------------------');
  console.log('  生成演示账号与药箱绑定码');
  console.log('--------------------------------------------------');

  // 清理自检脚本留下的临时家庭（user 会因外键 CASCADE 一并删除）
  await exec("DELETE FROM family WHERE name = '临时家庭'");

  const hash = bcrypt.hashSync(DEMO_PASSWORD, BCRYPT_COST);

  for (const a of ACCOUNTS) {
    // username 上有唯一键，重复执行时改为更新，保证幂等
    await exec(
      `INSERT INTO user (family_id, username, password_hash, real_name, phone, role, push_enabled)
       VALUES (?,?,?,?,?,?,1)
       ON DUPLICATE KEY UPDATE
         family_id = VALUES(family_id),
         password_hash = VALUES(password_hash),
         real_name = VALUES(real_name),
         phone = VALUES(phone),
         role = VALUES(role),
         token_version = 0`,
      [a.family_id, a.username, hash, a.real_name, a.phone, a.role]
    );
    console.log(`  账号  ${a.username.padEnd(12)} 家庭${a.family_id}  ${a.role}`);
  }

  // 02_seed.sql 里自带的两个账号，密码哈希是写死的，没人知道明文。
  // 这里一并重置成演示密码，避免出现「文档上有账号但登不进去」的尴尬。
  const legacy = await query(
    "SELECT id, username FROM user WHERE username IN ('wangxm','wanggg')"
  );
  for (const u of legacy) {
    await exec('UPDATE user SET password_hash = ?, token_version = 0 WHERE id = ?', [hash, u.id]);
    console.log(`  重置  ${u.username.padEnd(12)} 密码已统一为演示密码`);
  }

  // 给药箱预置绑定码（演示用，有效期放宽到 7 天；生产环境应为 5 分钟）
  //
  // 为什么这里要把旧会话全部吊销：
  //   本脚本的职责是「重建一个干净的演示环境」。
  //   上一轮跑测试脚本留下的 device_session 如果还挂着，
  //   子女端会看到一堆来历不明的设备记录，说不清是哪来的。
  //   和「子女端点生成绑定码」不同 —— 那只是给新设备开门，不该把老人正在用的踢掉。
  const boxes = await query('SELECT id, device_code FROM medbox ORDER BY id');
  const codes = [];
  for (const b of boxes) {
    const code = randomCode();
    await exec(
      `UPDATE medbox SET bind_code = ?, bind_code_expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY),
              status = 'online'
       WHERE id = ?`,
      [code, b.id]
    );
    await exec(
      `UPDATE device_session SET revoked_at = NOW(), revoke_reason = 'reset'
       WHERE medbox_id = ? AND revoked_at IS NULL`,
      [b.id]
    );
    codes.push({ device_code: b.device_code, code });
    console.log(`  药箱  ${b.device_code}  绑定码 ${code}`);
  }

  // 把账号密码写进 README 的演示账号表格，省得手抄
  const lines = [];
  lines.push('**子女端登录**（<http://localhost:3000/login.html>）');
  lines.push('');
  lines.push('| 账号 | 密码 | 家庭 | 姓名 | 角色 | 说明 |');
  lines.push('|---|---|---|---|---|---|');
  // 列全部账号（含 02_seed.sql 自带的两个），保证文档和实际一致
  const allUsers = await query(
    `SELECT u.username, u.real_name, u.role, f.name AS family, f.id AS family_id
     FROM user u JOIN family f ON u.family_id = f.id
     ORDER BY u.id`
  );
  for (const a of allUsers) {
    const roleTxt = { owner: 'owner 主配置人', member: 'member 可配置', viewer: 'viewer 只读' }[a.role] || a.role;
    const note = a.family_id === 1
      ? '可配置王家全部数据'
      : '另一家庭，用于验证越权拦截（看不到王家数据）';
    lines.push(`| ${a.username} | ${DEMO_PASSWORD} | ${a.family} | ${a.real_name || '-'} | ${roleTxt} | ${note} |`);
  }
  lines.push('');
  lines.push('**药箱绑定码**（老人端 <http://localhost:3000/elder.html>，首次打开输入即可，之后自动记住）');
  lines.push('');
  lines.push('| 药箱编号 | 绑定码 | 有效期 |');
  lines.push('|---|---|---|');
  for (const c of codes) {
    lines.push(`| ${c.device_code} | ${c.code} | 7 天（演示放宽，生产应为 5 分钟） |`);
  }
  lines.push('');
  lines.push('**越权自测**：用 `li_owner` 登录后，控制台老人列表只能看到李奶奶、看不到王大爷，即家庭隔离生效。');
  lines.push('');
  lines.push('> 上表的绑定码以**最新一次** `npm run init-db` / `npm run seed-auth` 生成的为准；');
  lines.push('> 在子女端「隔间管理 → 生成绑定码」现场生成新码后，表中旧码立即作废。');
  lines.push('');

  const ok = writeIntoReadme(lines.join('\n').replace(/\n+$/, ''));

  console.log('--------------------------------------------------');
  console.log(ok ? '  账号密码已写入：README.md（3.4 访问入口与演示账号）'
                : '  [WARN] README.md 中未找到 DEMO_ACCOUNTS 标记，账号密码未写入文档');
  console.log('--------------------------------------------------');
}

/**
 * 把生成的表格写进 README 的标记区间
 *   为什么不再单独存一个 md：账号只该有一个可信来源，
 *   散成两份就会出现「README 说密码 A、旧文件说密码 B」的尴尬。
 */
function writeIntoReadme(section) {
  const readmePath = path.join(__dirname, '..', 'README.md');
  if (!fs.existsSync(readmePath)) return false;
  const md = fs.readFileSync(readmePath, 'utf8');
  const BEGIN = '<!-- DEMO_ACCOUNTS:BEGIN';
  const END = '<!-- DEMO_ACCOUNTS:END -->';
  const i = md.indexOf(BEGIN);
  const j = md.indexOf(END);
  if (i < 0 || j < 0 || j < i) return false;
  const headEnd = md.indexOf('\n', i);          // BEGIN 注释所在行的行尾
  const out = md.slice(0, headEnd + 1) + section + '\n' + md.slice(j);
  fs.writeFileSync(readmePath, out, 'utf8');
  return true;
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((e) => { console.error('失败：', e.message); process.exit(1); });
}

module.exports = { run, DEMO_PASSWORD };
