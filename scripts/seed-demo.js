/**
 * seed-demo.js —— 生成两家近 14 天的演示服药记录
 * ============================================================
 * 配合 sql/04_demo_data.sql 使用（先跑 SQL 补配置，再跑本脚本补历史）。
 *
 * 干什么：
 *   1. 清空 intake_event / alert 里的旧演示数据
 *   2. 按两家老人各自的"依从性人设"，生成近 14 天每天每顿的服药事件：
 *        王秀英：依从性好（约 92% 按时）——看板曲线漂亮
 *        李奶奶：依从性一般（约 72% 按时）——漏服多、告警多，和王某形成对比
 *   3. 漏服/重复服药自动生成对应告警；3 天前的标记已读，近 3 天的未读
 *      （子女端登录后能看到"未读告警"红点，演示效果真实）
 *   4. 连续两次漏服同一顿 → 生成 repeat_missed 紧急告警（真实逻辑）
 *
 * 两个值得看的实现细节：
 *   【固定种子伪随机】mulberry32(种子) —— 每次跑生成的"随机"序列完全一样，
 *   演示数据可复现。答辩时重跑一遍，曲线形状不变。
 *   【本地时区格式化】pad() 用 getFullYear/getHours 等"本地"方法拼时间字符串。
 *   千万别用 toISOString()——它是 UTC，北京时间 12:00 会变成 04:00，
 *   这是本项目真实踩过的坑（详见记忆 2026-10-20）。
 *
 * 用法：npm run seed-demo
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { query, queryOne, exec, pool } = require('../server/db');

/* ---------- 固定种子伪随机（mulberry32 算法，32 行实现，够用且可复现） ---------- */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20261020); // 固定种子：换一个数就是另一套数据

/* ---------- 本地时区格式化：Date -> 'YYYY-MM-DD HH:MM:SS' ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
function fmt(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function addMin(d, m) { return new Date(d.getTime() + m * 60000); }

/* ---------- 两家人的"依从性人设" ----------
 * 累计概率表：r = rnd() 落在哪个区间就走哪条分支。
 * 想调整演示效果，改这里就行。 */
const PERSONA = {
  1: { on_time: 0.92, late: 0.96, missed: 0.99 },  // 王秀英：92% 按时，4% 迟到，3% 漏服，1% 重复
  2: { on_time: 0.72, late: 0.86, missed: 0.97 },  // 李奶奶：72% 按时，14% 迟到，11% 漏服，3% 重复
};
const DAYS = 14;

async function main() {
  console.log('==== 演示数据生成器 ====');

  /* 第 1 步：读取两位老人 + 各自的全部计划 */
  const elders = await query(
    `SELECT e.id, e.name, e.family_id, e.timeout_minutes, e.duplicate_window_minutes
       FROM elder e WHERE e.status = 'active'`
  );
  const schedules = await query(
    `SELECT s.id, s.elder_id, s.compartment_id, s.dose_time, s.time_label,
            s.window_before_min, s.window_after_min,
            c.medbox_id,
            (SELECT COALESCE(SUM(si.dose_qty), 1) FROM schedule_item si WHERE si.schedule_id = s.id) AS dose_qty
       FROM schedule s
       LEFT JOIN compartment c ON c.id = s.compartment_id
      WHERE s.status = 'active'
      ORDER BY s.elder_id, s.dose_time`
  );
  console.log(`老人 ${elders.length} 位，计划 ${schedules.length} 条`);

  /* 第 2 步：清空旧的演示事件与告警（保留配置类数据不动） */
  const [oe] = await pool.query('SELECT COUNT(*) c FROM intake_event');
  const [oa] = await pool.query('SELECT COUNT(*) c FROM alert');
  console.log(`清空旧数据：事件 ${oe[0].c} 条，告警 ${oa[0].c} 条`);
  await exec('SET FOREIGN_KEY_CHECKS=0');
  await exec('DELETE FROM alert');
  await exec('DELETE FROM intake_event');
  await exec('SET FOREIGN_KEY_CHECKS=1');

  /* 第 3 步：逐天逐顿生成事件 */
  const now = new Date();
  let evCount = 0, alertCount = 0;
  const stat = {};          // {elderId: {on_time, total}}
  const missStreak = {};    // 连续漏服计数（同一计划连续 miss → repeat_missed）
  const alertsToInsert = [];

  for (let d = DAYS - 1; d >= 0; d--) {
    const day = new Date(now.getTime() - d * 86400000);

    for (const s of schedules) {
      // 今天的这一顿：计划时间还没到就跳过（不编造未来数据）
      const [hh, mm] = s.dose_time.split(':').map(Number);
      const due = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0);
      if (due > now) continue;

      const elder = elders.find(e => e.id === s.elder_id);
      const persona = PERSONA[s.elder_id] || PERSONA[1];
      const r = rnd();
      const key = `${s.elder_id}-${s.id}`;
      stat[s.elder_id] = stat[s.elder_id] || { on_time: 0, total: 0 };
      stat[s.elder_id].total++;

      const base = {
        elder_id: s.elder_id,
        medbox_id: s.medbox_id,
        compartment_id: s.compartment_id,
        schedule_id: s.id,
        source: 'simulator',
        raw_payload: JSON.stringify({ demo: true, generator: 'seed-demo' }),
      };

      if (r < persona.on_time) {
        /* ---- 按时服药：计划时间前 0 ~ window_before 分钟内开箱 ---- */
        const offset = Math.floor(rnd() * s.window_before_min); // 提前量随机
        const t = addMin(due, -offset);
        if (t > now) continue;
        await exec(
          `INSERT INTO intake_event (elder_id, medbox_id, compartment_id, schedule_id,
             event_type, result, dose_qty, occurred_at, source, raw_payload)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [base.elder_id, base.medbox_id, base.compartment_id, base.schedule_id,
           'take', 'on_time', s.dose_qty, fmt(t), base.source, base.raw_payload]
        );
        evCount++;
        stat[s.elder_id].on_time++;
        missStreak[key] = 0;

        /* 小概率追加"重复开箱"（当场被语音拦下） */
        if (rnd() < (s.elder_id === 2 ? 0.06 : 0.02)) {
          const t2 = addMin(t, 1 + Math.floor(rnd() * 2)); // 1-2 分钟内再次开箱
          if (t2 <= now) {
            await exec(
              `INSERT INTO intake_event (elder_id, medbox_id, compartment_id, schedule_id,
                 event_type, result, dose_qty, occurred_at, source, raw_payload)
               VALUES (?,?,?,?,?,?,?,?,?,?)`,
              [base.elder_id, base.medbox_id, base.compartment_id, base.schedule_id,
               'duplicate_refused', 'duplicate', null, fmt(t2), base.source, base.raw_payload]
            );
            evCount++;
            alertsToInsert.push({
              elder_id: s.elder_id, alert_type: 'duplicate', level: 'warning',
              content: `${elder.name} ${s.time_label} ${s.dose_time.slice(0, 5)} 的药短时间内重复开箱，药箱已语音提醒"请勿重复服用"`,
              at: t2,
            });
          }
        }
      } else if (r < persona.late) {
        /* ---- 迟到：窗口结束后 5-40 分钟才吃 ---- */
        const t = addMin(due, s.window_after_min + 5 + Math.floor(rnd() * 35));
        if (t > now) continue;
        await exec(
          `INSERT INTO intake_event (elder_id, medbox_id, compartment_id, schedule_id,
             event_type, result, dose_qty, occurred_at, source, raw_payload)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [base.elder_id, base.medbox_id, base.compartment_id, base.schedule_id,
           'take', 'late', s.dose_qty, fmt(t), base.source, base.raw_payload]
        );
        evCount++;
        missStreak[key] = 0;
      } else if (r < persona.missed) {
        /* ---- 漏服：超时仍没开箱，判定 missed，发告警 ---- */
        const t = addMin(due, elder.timeout_minutes);
        if (t > now) continue;
        await exec(
          `INSERT INTO intake_event (elder_id, medbox_id, compartment_id, schedule_id,
             event_type, result, dose_qty, occurred_at, source, raw_payload)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [base.elder_id, base.medbox_id, base.compartment_id, base.schedule_id,
           'timeout', 'missed', null, fmt(t), base.source, base.raw_payload]
        );
        evCount++;
        missStreak[key] = (missStreak[key] || 0) + 1;

        const isRepeat = missStreak[key] >= 2; // 连续第二顿漏服 → 升级为紧急
        alertsToInsert.push({
          elder_id: s.elder_id,
          alert_type: isRepeat ? 'repeat_missed' : 'missed',
          level: isRepeat ? 'urgent' : 'warning',
          content: `${elder.name} ${s.time_label} ${s.dose_time.slice(0, 5)} 的药未在时间窗内服用` +
                   (isRepeat ? '（连续漏服，请尽快电话确认）' : `，已超时 ${elder.timeout_minutes} 分钟`),
          at: t,
        });
      } else {
        /* ---- 剩下的小概率：错峰开箱被拦（wrong_time_refused） ---- */
        const t = addMin(due, -(20 + Math.floor(rnd() * 60))); // 提前很久开错格子
        if (t <= now) {
          await exec(
            `INSERT INTO intake_event (elder_id, medbox_id, compartment_id, schedule_id,
               event_type, result, dose_qty, occurred_at, source, raw_payload)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [base.elder_id, base.medbox_id, base.compartment_id, base.schedule_id,
             'wrong_time_refused', 'abnormal', null, fmt(t), base.source, base.raw_payload]
          );
          evCount++;
        }
        stat[s.elder_id].on_time += 0; // 这顿算异常，不计按时
      }
    }
  }

  /* 第 4 步：写入告警（3 天前的已读、近 3 天未读） + 一条低库存告警 */
  const cutoff = addMin(now, -3 * 1440);
  for (const a of alertsToInsert) {
    const isOld = a.at < cutoff;
    await exec(
      `INSERT INTO alert (elder_id, intake_event_id, alert_type, level, content, channel, is_read, handled_at, handle_note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [a.elder_id, null, a.alert_type, a.level, a.content, 'web',
       isOld ? 1 : 0,
       isOld ? fmt(a.at) : null,
       isOld ? '已电话确认，老人忘记服药属正常情况' : null,
       fmt(a.at)]
    );
    alertCount++;
  }

  // 李奶奶的美托洛尔库存 5 片 < 警戒线 7 片 —— 一条未读的低库存告警
  await exec(
    `INSERT INTO alert (elder_id, alert_type, level, content, channel, is_read, created_at)
     VALUES (?,?,?,?,?,0,?)`,
    [2, 'stock_low', 'warning',
     '酒石酸美托洛尔缓释片 仅剩 5 片，低于警戒线 7 片，请尽快补药', 'web', fmt(now)]
  );
  alertCount++;

  /* 第 5 步：汇报结果 */
  console.log('---- 生成结果 ----');
  console.log(`事件 ${evCount} 条，告警 ${alertCount} 条`);
  for (const e of elders) {
    const st = stat[e.id] || { on_time: 0, total: 0 };
    const pct = st.total ? ((st.on_time / st.total) * 100).toFixed(1) : '0';
    console.log(`  ${e.name}：${st.total} 顿，按时 ${st.on_time} 顿（按时率 ${pct}%）`);
  }
  console.log('登录子女端即可看到近 14 天的记录与告警。');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('生成失败：', e); process.exit(1); });
