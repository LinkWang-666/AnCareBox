/**
 * 服药事件判定 —— 整个系统最核心的业务逻辑
 *
 * 输入：药箱/模拟器上报的一条事件
 *   { device_code, slot_no, event_type, dose_qty, occurred_at, source, client_event_id }
 *   client_event_id 是幂等键：设备断网补传时靠它保证同一件事只入库一次。
 *
 * 输出：写入 intake_event（判定 result），必要时写入 alert（通知子女）
 *
 * 判定规则（与方案书 6.2 节一致）：
 *   提前取药   发生在 [计划时间 - window_before, 计划时间)      → early
 *   准时取药   发生在 [计划时间, 计划时间 + window_after]        → on_time
 *   超时取药   发生在 计划时间 + window_after 之后               → late
 *   窗口外开箱 完全不在允许区间                                  → abnormal
 *   重复取药   同一计划在 duplicate_window 分钟内已有取药记录     → duplicate
 */
const { query, queryOne, exec } = require('../db');
const { badRequest } = require('./http');

/**
 * 这两个字段在数据库里是 ENUM，传错会直接报 "Data truncated" 的数据库错误，
 * 对调用方来说莫名其妙。所以在进库之前先校验：
 *   event_type 不合法 → 明确报错（这是业务关键字段，不能猜）
 *   source     不合法 → 兜底成 device（只是标记来源，不影响判定）
 */
const VALID_EVENT_TYPES = ['open', 'take', 'close', 'duplicate_refused',
  'wrong_time_refused', 'timeout', 'offline'];
const VALID_SOURCES = ['device', 'simulator', 'manual'];

/**
 * 把 Date 格式化成 MySQL 的 DATETIME 字符串（本地时区）
 * 注意：绝不能用 toISOString()，它会转成 UTC，
 * 北京时间 12:00 会被记成 04:00，导致服药判定全错。
 */
function toMysqlDatetime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 把 TIME 字符串（'08:00:00'）转换成某个日期下的 Date 对象 */
function timeOnDate(dateStr, timeStr) {
  const [h, m, s] = String(timeStr).split(':').map(Number);
  const d = new Date(dateStr);
  d.setHours(h || 0, m || 0, s || 0, 0);
  return d;
}

/**
 * 解析上报时间。
 *
 * 为什么要校验，而不是 new Date() 一把梭：
 *   1) 客户端传 'not-a-date' 时 new Date() 得到 Invalid Date，
 *      getFullYear() 全是 NaN，最终拼出 'NaN-NaN-NaN NaN:NaN:NaN' 塞进数据库，
 *      报错信息对前端毫无意义，排查时也不知道是自己传错了时间。
 *   2) occurred_at 由调用方指定，等于「服药流水的时间轴握在客户端手里」。
 *      不加边界的话，一次请求就能往库里写一条去年的「已服药」，
 *      漏服告警和依从率随之失真 —— 历史流水就不再可信。
 *   边界取值：设备离线补传最多 30 天（电量/网络恢复后再传是正常场景），
 *   人工补录（source=manual）放宽到 180 天；未来时间一律只给 10 分钟时钟误差。
 */
function parseOccurredAt(raw, source) {
  if (raw === null || raw === undefined || raw === '') return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw badRequest(`occurred_at 不是合法时间：${raw}`);
  const skew = d.getTime() - Date.now();
  if (skew > 10 * 60 * 1000) throw badRequest('occurred_at 不能晚于当前时间 10 分钟以上');
  const backDays = source === 'manual' ? 180 : 30;
  if (skew < -backDays * 24 * 3600 * 1000) {
    throw badRequest(`occurred_at 不能早于 ${backDays} 天前`);
  }
  return d;
}

/** 某台药箱关联的全部老人 id（主老人 + medbox_elder 关联，一箱多老人共用） */
async function eldersOfMedbox(medboxId) {
  const rows = await query(
    `SELECT elder_id FROM medbox_elder WHERE medbox_id = ?
     UNION
     SELECT elder_id FROM medbox WHERE id = ? AND elder_id IS NOT NULL`,
    [medboxId, medboxId]
  );
  return rows.map((r) => Number(r.elder_id));
}

/** 找到"此刻该执行"的计划：优先按隔间匹配，其次按时间窗匹配。
 *  一箱多老人共用：计划池是这台药箱所有关联老人的计划合集，
 *  隔间绑定能直接定位老人；仅时间窗匹配时取「离当前时刻最近」的计划。 */
async function matchSchedule(medboxId, compartmentId, occurredAt) {
  const elderIds = await eldersOfMedbox(medboxId);
  if (!elderIds.length) return null;

  const placeholders = elderIds.map(() => '?').join(',');
  const schedules = await query(
    `SELECT s.*, e.timeout_minutes, e.duplicate_window_minutes
     FROM schedule s
     JOIN elder e ON e.id = s.elder_id
     WHERE s.elder_id IN (${placeholders}) AND s.status = 'active'`,
    elderIds
  );

  if (!schedules.length) return null;

  // 1) 隔间精确匹配优先级最高（一个格只绑一条计划 → 直接定位老人）
  if (compartmentId) {
    const byCompartment = schedules.find((s) => s.compartment_id === compartmentId);
    if (byCompartment) return byCompartment;
  }

  // 2) 找时间窗包含当前时刻的计划；多条命中时取离计划时间点最近的
  const now = new Date(occurredAt);
  const datePart = occurredAt.slice(0, 10); // 'YYYY-MM-DD'
  let best = null;
  let bestDiff = Infinity;
  for (const s of schedules) {
    const start = timeOnDate(datePart, s.dose_time);
    start.setMinutes(start.getMinutes() - s.window_before_min);
    const end = timeOnDate(datePart, s.dose_time);
    end.setMinutes(end.getMinutes() + s.window_after_min);
    if (now >= start && now <= end) {
      const doseAt = timeOnDate(datePart, s.dose_time);
      const diff = Math.abs(now - doseAt);
      if (diff < bestDiff) { best = s; bestDiff = diff; }
    }
  }
  return best;
}

/** 判定取药结果 */
function judgeResult(schedule, occurredAt, eventType) {
  // 设备侧已经明确上报的异常类型，直接采信
  if (eventType === 'duplicate_refused') return 'duplicate';
  if (eventType === 'wrong_time_refused') return 'abnormal';
  if (eventType === 'timeout') return 'missed';
  if (eventType !== 'take' && eventType !== 'open') return 'unknown';

  if (!schedule) return 'abnormal';

  const now = new Date(occurredAt);
  const datePart = occurredAt.slice(0, 10);
  const doseAt = timeOnDate(datePart, schedule.dose_time);
  const startAt = new Date(doseAt.getTime() - schedule.window_before_min * 60000);
  const endAt = new Date(doseAt.getTime() + schedule.window_after_min * 60000);

  if (now < startAt) return 'abnormal';
  if (now < doseAt) return 'early';
  if (now <= endAt) return 'on_time';
  return 'late';
}

/**
 * 处理一条上报事件
 * @returns {Promise<{event:object, alert:object|null, message:string}>}
 */
async function handleIntakeEvent(payload) {
  const {
    device_code,
    slot_no,
    event_type = 'take',
    dose_qty = null,
    occurred_at = null,
    source = 'device',
    client_event_id = null,
  } = payload || {};

  if (!device_code) throw badRequest('缺少 device_code');

  if (!VALID_EVENT_TYPES.includes(event_type)) {
    throw badRequest(`event_type 不合法：${event_type}，可选值：${VALID_EVENT_TYPES.join(' / ')}`);
  }
  const src = VALID_SOURCES.includes(source) ? source : 'device';

  // 1. 定位设备
  const medbox = await queryOne(
    'SELECT * FROM medbox WHERE device_code = ?',
    [device_code]
  );
  if (!medbox) throw badRequest(`设备不存在：${device_code}`);
  const boxElderIds = await eldersOfMedbox(medbox.id);
  if (!boxElderIds.length) throw badRequest('该药箱尚未关联老人');

  // 2. 定位隔间
  let compartment = null;
  if (slot_no != null) {
    compartment = await queryOne(
      'SELECT * FROM compartment WHERE medbox_id = ? AND slot_no = ?',
      [medbox.id, Number(slot_no)]
    );
  }

  // 3. 事件时间：未指定则用服务器当前时间（必须按本地时区格式化）
  const occurredAt = toMysqlDatetime(parseOccurredAt(occurred_at, src));

  // 4. 匹配计划
  const schedule = await matchSchedule(
    medbox.id,
    compartment ? compartment.id : null,
    occurredAt
  );

  // 5. 判定结果
  let result = judgeResult(schedule, occurredAt, event_type);

  // 6. 重复服药检测：同一计划短时间内已有取药记录
  //    一箱多老人：事件归属 = 匹配到的计划的老人；匹配不到则记到主老人名下
  //    兜底再退一位：主老人字段可能是 NULL（历史数据只写了 medbox_elder 关联），
  //    这时取关联表的第一位，否则下面 eld.name 会直接空指针崩掉。
  const ownerElderId = schedule ? schedule.elder_id : (medbox.elder_id || boxElderIds[0]);
  const elder = await queryOne('SELECT * FROM elder WHERE id = ?', [ownerElderId]);
  if (!elder) throw badRequest('无法确定这条事件归属哪位老人，请先在子女端把药箱关联到老人');
  if (schedule && (result === 'on_time' || result === 'early')) {
    const dupWindow = elder.duplicate_window_minutes || 2;
    const recent = await queryOne(
      `SELECT id FROM intake_event
       WHERE schedule_id = ? AND result IN ('on_time','early','late')
         AND occurred_at >= DATE_SUB(?, INTERVAL ? MINUTE)
       LIMIT 1`,
      [schedule.id, occurredAt, dupWindow]
    );
    if (recent) result = 'duplicate';
  }

  // 7. 写入事件流水（只追加）
  //
  //    client_event_id 是设备侧的幂等键：断网补传时同一件事可能被重发多次。
  //    uk_ev_client 唯一索引兜住并发——两个请求同时进来，只有一个能插入成功，
  //    race 到的那一个会拿到 1062，转成「已入过库」返回原记录。
  //    这比「先查再插」可靠：先查再插在并发下有一个极窄的窗口会插两条。
  const clientEventId = client_event_id ? String(client_event_id).slice(0, 64) : null;
  let insertId;
  try {
    const r = await exec(
      `INSERT INTO intake_event
         (elder_id, medbox_id, compartment_id, schedule_id,
          event_type, result, dose_qty, occurred_at, source, client_event_id, raw_payload)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        ownerElderId,
        medbox.id,
        compartment ? compartment.id : null,
        schedule ? schedule.id : null,
        event_type,
        result,
        dose_qty,
        occurredAt,
        src,
        clientEventId,
        JSON.stringify(payload),
      ]
    );
    insertId = r.insertId;
  } catch (e) {
    if (clientEventId && (e.errno === 1062 || e.code === 'ER_DUP_ENTRY')) {
      const existed = await queryOne(
        'SELECT * FROM intake_event WHERE medbox_id = ? AND client_event_id = ?',
        [medbox.id, clientEventId]
      );
      if (existed) {
        return { event: existed, alert: null, message: `重复事件已忽略（幂等）：${clientEventId}`, duplicated: true };
      }
    }
    throw e;
  }

  // 8. 需要通知子女的，生成告警
  let alert = null;
  const needAlert = ['missed', 'duplicate', 'abnormal'].includes(result);
  if (needAlert) {
    const label = schedule ? `${schedule.time_label || ''} ${String(schedule.dose_time).slice(0, 5)}` : '非计划时段';
    const map = {
      missed: { type: 'missed', level: 'warning', text: `${elder.name} ${label} 的药超时未取，请及时联系确认。` },
      duplicate: { type: 'duplicate', level: 'urgent', text: `检测到疑似重复取药（${label}），系统已播报拦截话术，请回拨确认。` },
      abnormal: { type: 'night_open', level: 'warning', text: `${elder.name} 在非服药时段开箱（${label}），已保持锁闭。` },
    };
    const cfg = map[result];

    // 找主配置人作为推送对象
    const owner = await queryOne(
      'SELECT id FROM user WHERE family_id = ? ORDER BY FIELD(role,"owner","member","viewer") LIMIT 1',
      [elder.family_id]
    );

    const r = await exec(
      `INSERT INTO alert (elder_id, intake_event_id, alert_type, level, content, channel, sent_to_user_id)
       VALUES (?,?,?,?,?,?,?)`,
      [elder.id, insertId, cfg.type, cfg.level, cfg.text, 'web', owner ? owner.id : null]
    );
    alert = { id: r.insertId, type: cfg.type, level: cfg.level, content: cfg.text };
  }

  // 9. 同步设备心跳
  await exec('UPDATE medbox SET status = "online", last_heartbeat_at = NOW() WHERE id = ?', [medbox.id]);

  const event = await queryOne('SELECT * FROM intake_event WHERE id = ?', [insertId]);
  return { event, alert, message: `判定结果：${result}` };
}

/** 依从性统计：某老人最近 N 天 */
async function adherence(elderId, days = 7) {
  const rows = await query(
    `SELECT DATE(occurred_at) AS d,
            SUM(result IN ('on_time','early','late')) AS taken,
            SUM(result = 'missed') AS missed,
            SUM(result = 'duplicate') AS duplicate,
            SUM(result = 'abnormal') AS abnormal,
            COUNT(*) AS total
     FROM intake_event
     WHERE elder_id = ? AND occurred_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     GROUP BY DATE(occurred_at)
     ORDER BY d DESC`,
    [elderId, days]
  );

  const total = rows.reduce((a, r) => a + Number(r.total), 0);
  const taken = rows.reduce((a, r) => a + Number(r.taken), 0);
  const missed = rows.reduce((a, r) => a + Number(r.missed), 0);

  return {
    days,
    rate: total ? Math.round((taken / total) * 1000) / 10 : 0, // 依从率%，保留1位
    taken,
    missed,
    duplicate: rows.reduce((a, r) => a + Number(r.duplicate), 0),
    abnormal: rows.reduce((a, r) => a + Number(r.abnormal), 0),
    total,
    daily: rows,
  };
}

module.exports = { handleIntakeEvent, adherence, judgeResult, eldersOfMedbox };
