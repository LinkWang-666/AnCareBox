/**
 * 数据库连通性自检
 * ---------------------------------------------
 * 作用：启动 Web 服务之前，先确认「能不能真的连上 MySQL」。
 *
 * 为什么不用 `sc query MySQL80` 查服务状态：
 *   服务显示 RUNNING 不代表能连通 —— 密码错了、端口改了、库没建，
 *   都会连不上。直接试连一次才是真的准。
 *
 * 输出一律用英文：因为调用方是 .bat（GBK 代码页），
 * 中文会被 cmd 按错的代码页解析成乱码。
 *
 * 退出码：0 = 正常；1 = 库里没表；2 = 连不上
 *
 * 用法：node scripts/check-db.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mysql = require('mysql2/promise');

const CFG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'smart_medbox',
  connectTimeout: 5000,
};

// 每种错误码对应一句「人话」，直接告诉用户下一步该干嘛
const HINT = {
  ECONNREFUSED: 'MySQL service is not running -> Start-Service MySQL80',
  ER_ACCESS_DENIED_ERROR: 'Wrong user or password -> check DB_USER / DB_PASSWORD in .env',
  ER_BAD_DB_ERROR: 'Database not found -> run: npm run init-db',
  ETIMEDOUT: 'Connection timed out -> check DB_HOST / DB_PORT in .env',
  ENOTFOUND: 'Host not resolvable -> check DB_HOST in .env',
  ECONNRESET: 'Connection reset -> check MySQL is alive',
};

(async () => {
  let conn;
  try {
    conn = await mysql.createConnection(CFG);
    await conn.execute('SELECT 1');

    // 顺带确认业务表真的建好了，避免「连上了但库是空的」
    const [tables] = await conn.execute(
      'SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = ?',
      [CFG.database]
    );
    const n = Number(tables[0].c);
    if (n === 0) {
      console.log(`DB EMPTY: ${CFG.database} has no table -> run: npm run init-db`);
      process.exitCode = 1;
      return;
    }
    console.log(`DB OK: ${CFG.database} (${n} tables)`);
    process.exitCode = 0;
  } catch (e) {
    const code = e.code || 'UNKNOWN';
    console.log(`DB FAIL: ${code} - ${HINT[code] || e.message}`);
    process.exitCode = 2;
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
})();
