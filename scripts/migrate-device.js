/**
 * 设备对接层迁移：给「已经有数据的库」补齐设备接口需要的字段和表。
 *
 * 为什么单独一个脚本，而不是并进 init-db：
 *   init-db 会 DROP 重建全部表，等于把演示数据洗掉。
 *   实物药箱要接的时候，库里已经有老人、计划、历史服药记录，
 *   这时只能增量升级。sql/13_device_api.sql 是幂等的，跑几遍都不会坏。
 *
 * 用法：npm run migrate:device
 */
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SQL_FILE = path.join(__dirname, '..', 'sql', '13_device_api.sql');
const DB_NAME = process.env.DB_NAME || 'smart_medbox';

(async function main() {
  console.log('==================================================');
  console.log('  设备对接层迁移（13_device_api.sql）');
  console.log('==================================================');

  if (!fs.existsSync(SQL_FILE)) {
    console.error(`  找不到脚本：${SQL_FILE}`);
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB_NAME,
    multipleStatements: true,     // 整个文件一次执行
    charset: 'utf8mb4',
  });

  try {
    await conn.query(fs.readFileSync(SQL_FILE, 'utf8'));
    console.log('  ✓ 迁移执行完成');
  } catch (e) {
    console.error(`  ✗ 迁移失败：${e.message}`);
    await conn.end();
    process.exit(1);
  }

  // 验收：把设备相关的列与表列出来，一眼看出有没有补齐
  const [cols] = await conn.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND ((TABLE_NAME = 'medbox' AND COLUMN_NAME = 'hardware_model')
          OR (TABLE_NAME = 'compartment' AND COLUMN_NAME IN ('stock_ratio','is_empty','sensor_ok','reported_at'))
          OR (TABLE_NAME = 'intake_event' AND COLUMN_NAME = 'client_event_id'))
      ORDER BY TABLE_NAME, COLUMN_NAME`,
    [DB_NAME]
  );
  const [idx] = await conn.query(
    `SELECT INDEX_NAME AS n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'intake_event' AND INDEX_NAME = 'uk_ev_client'
      LIMIT 1`,
    [DB_NAME]
  );
  const [tables] = await conn.query(
    `SELECT TABLE_NAME AS t FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('device_command','device_status','device_firmware','device_log')
      ORDER BY TABLE_NAME`,
    [DB_NAME]
  );

  console.log('--------------------------------------------------');
  console.log(`  新增字段：${cols.length} 个`);
  cols.forEach((r) => console.log(`    ${r.t}.${r.c}`));
  console.log(`  幂等索引：${idx.length ? 'uk_ev_client 已存在' : '缺失！'}`);
  console.log(`  设备表  ：${tables.map((r) => r.t).join(', ') || '缺失！'}`);
  console.log('==================================================');
  console.log(cols.length === 6 && idx.length === 1 && tables.length === 4
    ? '  设备对接层已就绪，实物药箱接上即可对接。'
    : '  ⚠ 有项目未补齐，请检查上面的输出。');
  console.log('==================================================');

  await conn.end();
  process.exit(0);
})();
