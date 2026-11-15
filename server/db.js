/**
 * MySQL 连接池
 * 注意：dotenv 必须显式指定 .env 的绝对路径，否则换个目录启动就读不到配置。
 */
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'smart_medbox',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  // 让 DATE/DATETIME 以字符串返回，避免时区被驱动二次转换
  dateStrings: true,
});

/** 查询多条 */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/** 查询单条（无结果返回 null） */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/** 写操作，返回 { insertId, affectedRows } */
async function exec(sql, params = []) {
  const [result] = await pool.execute(sql, params);
  return { insertId: result.insertId, affectedRows: result.affectedRows };
}

/** 健康检查 */
async function ping() {
  const row = await queryOne('SELECT VERSION() AS version, DATABASE() AS db');
  return row;
}

module.exports = { pool, query, queryOne, exec, ping };
