/**
 * 移动端数据层 —— 常量映射 + 全局状态 + 数据拉取
 *
 * 依赖 /js/api.js（与 Web 端共用同一份）：
 *   令牌管理、401 自动续期、toast、esc 都在那里，移动端不重复实现，
 *   保证「同一个账号、同一套数据库、同一套鉴权」。
 *
 * 分层约定：
 *   data.js 只负责「取数据 / 存状态 / 格式化」，不碰 DOM；
 *   app.js 负责「渲染 + 交互」。
 */

/* ==================== 枚举文案 ==================== */
const RESULT_TEXT = {
  on_time: '按时', early: '提前', late: '延迟',
  missed: '漏服', duplicate: '重复', abnormal: '异常', unknown: '未知',
};
const RESULT_TONE = {
  on_time: 'ok', early: 'ok', late: 'warn',
  missed: 'bad', duplicate: 'bad', abnormal: 'bad', unknown: 'mute',
};
const SOURCE_TEXT = {
  device: '药箱自动', manual: '手动确认', alarm: '超时告警', app: '手机确认',
};
const ALERT_TEXT = {
  missed: '漏服', duplicate: '重复取药', night_open: '夜间开箱',
  repeat_missed: '连续漏服', offline: '设备离线', sos: 'SOS 求助',
  stock_low: '库存不足', drug_conflict: '用药冲突', expiry: '效期预警',
  fault: '设备故障',
};
const ALERT_ICON = {
  missed: '⏰', duplicate: '🔁', night_open: '🌙', repeat_missed: '⏰',
  offline: '📴', sos: '🆘', stock_low: '📦', drug_conflict: '⚗️', expiry: '🗓️',
  fault: '🔧',
};
const LEVEL_TEXT = { urgent: '紧急', warning: '警告', info: '提示' };

/**
 * 每类告警的「建议动作」（对应方案书 6.3 异常场景与处理表）
 * 只给行动建议，不给诊断结论；医疗判断一律让家属找医生药师。
 */
const ALERT_ADVICE = {
  missed: '先打电话确认老人是否已服药；联系不上就请邻居或社区网格员上门看一眼。',
  repeat_missed: '连续漏服可能是记性或身体原因，建议当面查看，复诊时把用药记录单带给医生。',
  duplicate: '确认是否真的吃重了；若已重复服用，联系药师评估是否需要处理。',
  night_open: '夜间异常开箱要排查起夜误取、梦游或认知障碍，必要时就诊。',
  sos: '立即回拨；无人接听就尽快联系上门查看，别只发消息等回复。',
  offline: '先检查药箱电源与家里的网络。离线期间提醒仍按本地时钟执行，不会漏。',
  stock_low: '尽快补药，别等吃完再买；断药是漏服最常见的原因。',
  drug_conflict: '核对说明书并咨询医生或药师，不要自行停药或改剂量。',
  expiry: '把过期药从药盒里清理掉，千万别留给老人继续吃。',
  fault: '设备自己报了硬件故障，多半是锁舌卡住、喇叭不响或传感器坏。先看药箱能不能正常开合，别硬掰；提醒功能失效时先改成电话提醒。',
};

/** 计划状态 → 文案/配色 */
const SLOT_STATUS = {
  done: { text: '已服用', tone: 'ok' },
  current: { text: '现在该吃', tone: 'now' },
  overdue: { text: '已超时', tone: 'bad' },
  upcoming: { text: '待服用', tone: 'mute' },
};

/* ==================== 全局状态 ==================== */
const M = {
  me: null,
  elders: [],
  medicines: [],
  medboxes: [],
  schedules: [],
  members: [],
  compartments: [],
  elderId: null,
  lastDash: null,
};

/** 当前老人对象 */
function currentElder() {
  return M.elders.find((e) => Number(e.id) === Number(M.elderId)) || M.elders[0] || null;
}

/**
 * 选定当前查看的老人
 * 移动端只有一个「当前老人」上下文（Web 端有下拉切换），记住在本地，
 * 下次打开还是同一个人，避免每次都要重新选。
 */
function setElder(id) {
  M.elderId = id ? Number(id) : null;
  if (M.elderId) localStorage.setItem('m_elder_id', String(M.elderId));
}

/* ==================== 数据拉取 ==================== */
/**
 * 一次性拉齐移动端所有页面的基础数据。
 * 为什么不做成每页各拉：移动端页面切换频繁，反复请求会让弱网下的体验很差；
 * 这 6 个接口返回量都很小（家庭级数据），一次拉完本地共享最划算。
 */
async function loadAll() {
  const [me, elders, medicines, medboxes, schedules, members] = await Promise.all([
    api.get('/auth/me').catch(() => null),
    api.get('/elders').catch(() => []),
    api.get('/medicines').catch(() => []),
    api.get('/medbox').catch(() => []),
    api.get('/schedules').catch(() => []),
    api.get('/users').catch(() => []),
  ]);
  M.me = me;
  M.elders = elders || [];
  M.medicines = medicines || [];
  M.medboxes = medboxes || [];
  M.schedules = schedules || [];
  M.members = members || [];

  // 隔间数据依赖药箱 id，只能拿到药箱后再拉（一次串行，量很小）
  // 「新增计划选隔间」和「装药清单」都靠它，缺了就没法做防错
  M.compartments = [];
  const box = M.medboxes[0];
  if (box) {
    const rows = await api.get(`/medbox/${box.id}/load-list`).catch(() => []);
    M.compartments = groupCompartments(rows || []);
  }

  // 当前老人：优先本地记忆，其次第一位
  const saved = Number(localStorage.getItem('m_elder_id')) || null;
  const hit = M.elders.find((e) => Number(e.id) === saved);
  setElder(hit ? hit.id : (M.elders[0] && M.elders[0].id) || null);
  return M;
}

/** 某格隔间的占用情况（没占用返回 null） */
function compartmentBySchedule(scheduleId) {
  return M.compartments.find((c) => Number(c.schedule_id) === Number(scheduleId)) || null;
}

/**
 * 把 /medbox/:id/load-list 的「一行一种药」聚合成「一格一条」
 * 后端为了少写循环，把格 × 计划 × 药品直接 JOIN 平铺返回，
 * 一个格有 3 种药就是 3 行，这里合并成 {slot_no, meds:[...]}。
 */
function groupCompartments(rows) {
  const map = new Map();
  rows.forEach((r) => {
    const key = Number(r.slot_no);
    let c = map.get(key);
    if (!c) {
      c = {
        id: r.compartment_id,
        slot_no: key,
        label: r.compartment_label || '',
        schedule_id: r.schedule_id || null,
        dose_time: r.dose_time || null,
        time_label: r.time_label || null,
        elder_name: r.elder_name || null,
        meds: [],
      };
      map.set(key, c);
    }
    if (r.medicine_name) {
      c.meds.push({ name: r.medicine_name, unit: r.unit || '', qty: Number(r.dose_qty) || 1 });
    }
  });
  return [...map.values()].sort((a, b) => a.slot_no - b.slot_no);
}

/** 某个计划关联的药品与剂数（schedule_item 明细） */
function itemsOfSchedule(scheduleId) {
  const s = M.schedules.find((x) => Number(x.id) === Number(scheduleId));
  return (s && s.items) || [];
}

/** 某位老人的计划 */
function schedulesOf(elderId) {
  return M.schedules.filter((s) => Number(s.elder_id) === Number(elderId));
}

/** 主药箱（老人可能共用一台，取第一台） */
function mainBox() {
  return M.medboxes[0] || null;
}

/* ==================== 格式化工具 ==================== */
/** '08:00:00' → '08:00' */
function hhmm(t) {
  return String(t || '').slice(0, 5);
}

/**
 * Date → 本地 'YYYY-MM-DD'
 * 为什么不用 toISOString().slice(0,10)：那是 UTC 日期，东八区早上 8 点前会少算一天，
 * 表现为「今天的记录查不到」。
 */
function localDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** '2026-11-08' → 距今天数（负数=已过期） */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((d - today) / 86400000);
}

/** '2026-11-08' → '11月8日' */
function md(dateStr) {
  if (!dateStr) return '';
  const s = String(dateStr).slice(0, 10).split('-');
  return s.length === 3 ? `${Number(s[1])}月${Number(s[2])}日` : String(dateStr);
}

/** 时间戳 → '今天 08:12' / '10月30日 08:12' */
function relTime(ts) {
  if (!ts) return '';
  const d = new Date(String(ts).replace(' ', 'T'));
  if (isNaN(d.getTime())) return String(ts).slice(0, 16);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `今天 ${hm}`;
  const y = new Date(today.getTime() - 86400000);
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 姓名取末字做头像 */
function avatarText(name) {
  const s = String(name || '').trim();
  return s ? s.slice(-1) : '?';
}

/** 年龄文案 */
function ageText(e) {
  if (!e) return '';
  return e.age ? `${e.age} 岁` : '';
}

/** 性别称呼 */
function elderCall(e) {
  if (!e) return '';
  const g = e.gender === 'male' ? '爷爷' : e.gender === 'female' ? '奶奶' : '';
  return e.name + g;
}

/** 库存是否偏低 */
function isLowStock(m) {
  return Number(m.stock_qty) <= Number(m.stock_alert_qty);
}

/** 效期风险：null 无风险 / 'expired' 已过期 / 'soon' 30 天内 */
function expiryRisk(m) {
  const d = daysUntil(m.expiry_date);
  if (d === null) return null;
  if (d < 0) return 'expired';
  if (d <= 30) return 'soon';
  return null;
}
