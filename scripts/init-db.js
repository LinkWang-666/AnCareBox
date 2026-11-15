/**
 * 一键初始化数据库：建库 → 建表 → 灌入演示数据
 * 用法：npm run init-db
 */
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SQL_DIR = path.join(__dirname, '..', 'sql');
// 04_demo_data.sql：李家完整配置（老人/药品/计划/录音）
const FILES = ['01_schema.sql', '02_seed.sql', '03_auth.sql', '04_demo_data.sql', '05_device_session.sql', '06_shared_medbox.sql', '07_ingredient.sql', '08_drug_conflict_alert.sql', '09_medicine_expiry_category.sql', '10_user_alert_prefs.sql', '11_expiry_alert.sql', '12_medicine_barcode.sql'];
const DB_NAME = process.env.DB_NAME || 'smart_medbox';

(async function main() {
  console.log('==================================================');
  console.log('  初始化数据库');
  console.log('==================================================');

  // 建库阶段不能指定 database，因为库可能还不存在
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,   // 允许一次执行整个 SQL 文件
    charset: 'utf8mb4',
  });

  try {
    const [row] = await conn.query('SELECT VERSION() AS v');
    console.log(`  MySQL 已连接：${row[0].v}`);
  } catch (e) {
    console.error('  连接失败：' + e.message);
    console.error('  请检查 .env 中 DB_PASSWORD，并确认 MySQL80 服务已启动');
    process.exit(1);
  }

  for (const f of FILES) {
    const file = path.join(SQL_DIR, f);
    if (!fs.existsSync(file)) {
      console.error(`  找不到文件：${file}`);
      process.exit(1);
    }
    const sql = fs.readFileSync(file, 'utf8');
    try {
      await conn.query(sql);
      console.log(`  ✓ ${f} 执行成功`);
    } catch (e) {
      console.error(`  ✗ ${f} 执行失败：${e.message}`);
      process.exit(1);
    }
  }

  // 验收：列出表与数据量
  // 注意：information_schema 返回的列名是大写 TABLE_NAME，用别名统一
  const [tables] = await conn.query(
    'SELECT TABLE_NAME AS tname FROM information_schema.tables WHERE table_schema = ? ORDER BY TABLE_NAME',
    [DB_NAME]
  );
  console.log('--------------------------------------------------');
  console.log(`  共建成 ${tables.length} 张表：`);
  for (const t of tables) {
    const [r] = await conn.query(`SELECT COUNT(*) AS c FROM \`${DB_NAME}\`.\`${t.tname}\``);
    console.log(`    ${String(t.tname).padEnd(16)} ${r[0].c} 行`);
  }
  await conn.end();

  // 生成演示账号与药箱绑定码（密码需要 bcrypt 哈希，只能在代码里生成）
  console.log('');
  await require('./seed-auth').run();

  // 生成近 14 天历史事件（两家对比的看板数据）
  // seed-demo.js 是独立脚本（跑完即退出），用子进程调用
  console.log('');
  console.log('---- 生成 14 天历史测试数据 ----');
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'seed-demo.js')], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('  历史数据生成失败，可单独执行 npm run seed-demo 重试');
    process.exit(1);
  }

  console.log('==================================================');
  console.log('  完成。接下来运行：npm start');
  console.log('==================================================');

  // seed-auth 用的是 db.js 的连接池，不主动结束的话进程不会退出
  process.exit(0);
})();
