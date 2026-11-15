/**
 * 清理「设备替身」跑测试时写进去的数据
 *
 * 为什么需要它：
 *   npm run device 会真的往库里写服药事件（这是故意的 —— 只有真写进去
 *   才能验证判定、告警、幂等这一整条链路真的通）。但演示前不该让这些
 *   测试流水混进依从率统计，所以给一个只删自己数据的清理脚本。
 *
 * 只删两类东西，绝不动真实数据：
 *   1. intake_event 里 client_event_id 以 agent- 开头的行（设备替身专用前缀）
 *   2. 由这些行触发的 alert（通过 intake_event_id 关联）
 *
 * 用法：npm run clean:agent
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { query, queryOne, exec } = require('../server/db');

(async function main() {
  console.log('==================================================');
  console.log('  清理设备替身测试数据（client_event_id 以 agent- 开头）');
  console.log('==================================================');

  const before = await queryOne(
    `SELECT COUNT(*) AS c FROM intake_event WHERE client_event_id LIKE 'agent-%'`
  );
  console.log(`  待清理的测试事件：${before.c} 条`);

  // 没有测试事件时不要直接退出：--sos 可能还要清 SOS 告警与安抚指令
  let removedAlerts = 0;
  let removedEvents = 0;
  if (Number(before.c)) {
    // 先删告警（外键 intake_event_id 指向事件），再删事件
    const a = await exec(
      `DELETE a FROM alert a
        JOIN intake_event e ON e.id = a.intake_event_id
       WHERE e.client_event_id LIKE 'agent-%'`
    );
    const e = await exec(`DELETE FROM intake_event WHERE client_event_id LIKE 'agent-%'`);
    removedAlerts += a.affectedRows;
    removedEvents += e.affectedRows;
  }

  // 故障上报产生的 fault 告警没有 intake_event_id，按内容特征单独清
  const f = await exec(
    `DELETE FROM alert WHERE alert_type = 'fault' AND content LIKE '%报告设备故障%' AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`
  );
  removedAlerts += f.affectedRows;

  // 替身上传的测试日志（事件名是脚本里写死的那几个）
  const g = await exec(
    `DELETE FROM device_log
      WHERE event IN ('BOOT','WIFI_WEAK','LOCK_FAIL')
        AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`
  );

  console.log(`  已删除告警：${removedAlerts} 条`);
  console.log(`  已删除事件：${removedEvents} 条`);
  console.log(`  已删除测试日志：${g.affectedRows} 条`);

  // --sos：连测试触发的 SOS 求助与现场安抚播报一起清掉。
  // 默认不清，是因为 SOS 告警长得和真实求助一模一样，宁可让人手动确认一次，
  // 也不要在脚本里默认删「紧急求助」这种高敏感记录。
  if (process.argv.includes('--sos')) {
    const s = await exec(
      `DELETE FROM alert WHERE alert_type = 'sos'
         AND content LIKE '%按下了「我不舒服」%'
         AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`
    );
    const c = await exec(
      `DELETE FROM device_command
        WHERE command = 'speak' AND source = 'system'
          AND params LIKE '%已通知家人，请坐下休息%'
          AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`
    );
    console.log(`  已删除测试 SOS 告警：${s.affectedRows} 条`);
    console.log(`  已删除测试安抚播报指令：${c.affectedRows} 条`);
  }

  const after = await queryOne(
    `SELECT COUNT(*) AS c FROM intake_event WHERE client_event_id LIKE 'agent-%'`
  );
  console.log('--------------------------------------------------');
  console.log(after.c === 0 || Number(after.c) === 0 ? '  ✓ 清理完成' : `  ⚠ 还剩 ${after.c} 条`);
  console.log('==================================================');
  process.exit(0);
})().catch((err) => {
  console.error('清理失败：', err.message);
  process.exit(1);
});
