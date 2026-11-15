/**
 * AI Agent 服务（自然语言 → 自动执行系统操作）
 *
 * 核心思想：把系统里「查老人、查药品、建计划、查依从、查告警」等能力，
 * 包装成一个个「工具（tool）」，让大模型（qwen-plus，OpenAI 兼容 Function Calling）
 * 自己决定「该调哪个工具、传什么参数」，执行完再把结果翻译成人话。
 *
 * 降级策略（方案 B）：大模型没配 Key / 调用失败时，退回到关键词匹配，
 * 保证「查」类操作在无 AI 环境下也能跑通，演示不翻车。
 *
 * 安全要点：
 *   - 所有查询都以 familyId 为过滤条件，杜绝跨家庭越权；
 *   - 写操作（建计划）只允许操作本家庭内的老人与药品；
 *   - 危险操作（删除/清空）本期不做，AI 无法触发。
 */
const { query, queryOne, exec, pool } = require('../db');
const llm = require('./llm');
const Assistant = require('./assistant');

const SYSTEM_PROMPT = `你是「安心格」智能药箱的用药助手，能直接帮子女自动化地管理家里老人的服药。

你有以下工具可用，遇到需要查数据或执行操作时，务必调用工具获取真实数据，不要凭空编造：
- list_elders：列出家里所有老人
- list_medicines：列出家里的在库药品
- list_schedules：查某位老人的服药计划
- create_schedule：为某位老人新建服药计划
- check_adherence：查某位老人最近一段时间的按时服药情况
- query_alerts：查未处理的告警（漏服、重复取药、异常等）
- check_expiry：查家里药品的效期情况（30 天内到期或已过期）
- check_drug_conflicts：检测某位老人（或全家）的用药相互作用/配伍冲突
- add_medicine：向药箱添加新药品
- update_medicine：修改药品的库存或效期
- add_elder：添加一位老人
- set_reminder_policy：修改老人的提醒策略（音量、语速、提前提醒开关）
- handle_alerts：把告警全部标记为已处理

规则：
1. 优先用工具回答，不要猜测数据。
2. 写操作务必【真正调用工具】：add_medicine / add_elder / create_schedule / update_medicine / set_reminder_policy / handle_alerts 这些工具会按名称自动匹配对象，信息齐全时直接调用它，不要只回复「正在…/已…」却不调用工具，也不要反复查证后空谈。工具执行成功后，再如实告知结果。
3. 一个任务可能需要多步完成（例如「把王秀英的降压药都配好」要先查降压药、再逐条创建计划、再确认隔间），可以连续调用多个工具，一步步自动做完，最后统一汇报。
4. 回答用简洁友好的中文，不用医学术语堆砌；只做提醒、记录与科普，不诊断、不开处方。
5. 如果你判断用户只是闲聊或问常识，直接回答即可，不必调工具。`;

/** 工具定义（OpenAI Function Calling 的 tools 参数） */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_elders',
      description: '列出当前家庭的所有老人（姓名、年龄、听力视力等）',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_medicines',
      description: '列出当前家庭的在库药品（名称、规格、库存、效期）',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_schedules',
      description: '查询某位老人的服药计划（时间、时段、吃什么药）',
      parameters: {
        type: 'object',
        properties: {
          elder_name: { type: 'string', description: '老人姓名，不填则查全部老人' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_schedule',
      description: '为某位老人新建一条服药计划（一个时间点 + 吃哪几种药）',
      parameters: {
        type: 'object',
        properties: {
          elder_name: { type: 'string', description: '老人姓名，必填' },
          time: { type: 'string', description: '服药时间 HH:MM，如 08:00，必填' },
          medicine_names: { type: 'array', items: { type: 'string' }, description: '要吃的药品名列表，必填' },
          time_label: { type: 'string', description: '时段标签：早上/中午/晚上/睡前，可省略' },
        },
        required: ['elder_name', 'time', 'medicine_names'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_adherence',
      description: '查询某位老人最近 N 天的按时服药率与漏服次数',
      parameters: {
        type: 'object',
        properties: {
          elder_name: { type: 'string', description: '老人姓名' },
          days: { type: 'number', description: '统计天数，默认 7' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_alerts',
      description: '查询未处理的告警（漏服、重复取药、夜间异常、设备离线等）',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_expiry',
      description: '查询家里药品的效期情况：30 天内即将到期、或已经过期的药（只读，不修改数据）',
      parameters: {
        type: 'object',
        properties: {
          elder_name: { type: 'string', description: '老人姓名，不填则查全家所有在服药品' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_drug_conflicts',
      description: '检测某位老人（或全家）正在服用药品之间的相互作用/配伍冲突，按成分级规则库匹配（只读）',
      parameters: {
        type: 'object',
        properties: {
          elder_name: { type: 'string', description: '老人姓名，不填则查全家所有在服药品' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_medicine',
      description: '向药箱库存添加一种新药品',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '药品名称，必填' },
          spec: { type: 'string', description: '规格，如「5mg*28片」' },
          unit: { type: 'string', description: '剂量单位：片/粒/袋/ml，默认片' },
          stock_qty: { type: 'number', description: '初始库存数量，默认 0' },
          category: { type: 'string', description: '功能分类：降压/降糖/调脂/心血管/营养补充/其他' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_medicine',
      description: '修改某药品的库存数量或效期（如补药后更新库存）',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '药品名称，必填' },
          stock_qty: { type: 'number', description: '新的库存数量' },
          expiry_date: { type: 'string', description: '新的效期 YYYY-MM-DD' },
          category: { type: 'string', description: '功能分类' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_elder',
      description: '向家庭添加一位老人',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '老人姓名，必填' },
          age: { type: 'number', description: '年龄' },
          gender: { type: 'string', description: '性别：男/女' },
          chronic_diseases: { type: 'string', description: '慢病史，逗号分隔' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder_policy',
      description: '修改某位老人的提醒策略（音量、语速、提前提醒开关等）',
      parameters: {
        type: 'object',
        properties: {
          elder_name: { type: 'string', description: '老人姓名，必填' },
          volume_level: { type: 'number', description: '音量 1-5' },
          speech_rate: { type: 'string', description: '语速：slow/normal/fast' },
          remind_30m: { type: 'boolean', description: '是否提前30分钟提醒' },
          remind_10m: { type: 'boolean', description: '是否提前10分钟提醒' },
          remind_3m: { type: 'boolean', description: '是否提前3分钟提醒' },
        },
        required: ['elder_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'handle_alerts',
      description: '把未处理的告警全部标记为已处理',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_schedule',
      description: '删除某位老人的一条服药计划（危险操作，需要用户二次确认后才能执行）',
      parameters: {
        type: 'object',
        properties: {
          elder_name: { type: 'string', description: '老人姓名，必填' },
          time: { type: 'string', description: '计划时间 HH:MM，必填' },
        },
        required: ['elder_name', 'time'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_medicine',
      description: '删除一种药品（危险操作，需要用户二次确认后才能执行）',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '药品名称，必填' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_elder',
      description: '删除一位老人及其全部服药数据（危险操作，需要用户二次确认后才能执行）',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '老人姓名，必填' } },
        required: ['name'],
      },
    },
  },
];

/** 按姓名找老人（限定本家庭） */
async function findElder(familyId, name) {
  if (!name) return null;
  return queryOne(
    'SELECT id, name FROM elder WHERE family_id = ? AND name = ? AND status = "active" LIMIT 1',
    [familyId, name]
  );
}

/** 按时段推断标签 */
function labelByTime(time) {
  const h = parseInt(String(time).slice(0, 2), 10);
  if (h >= 5 && h < 10) return '早上';
  if (h >= 10 && h < 14) return '中午';
  if (h >= 14 && h < 18) return '下午';
  if (h >= 18 && h < 22) return '晚上';
  return '睡前';
}

/**
 * 会改数据的工具。
 *
 * 为什么需要这份名单：
 *   子女端的 REST 接口都挂了 requireWritable，viewer（只读成员）改不了任何配置。
 *   但 AI 助手是另一条路 —— 模型自己决定调哪个工具，直接穿透到数据库，
 *   完全没经过那层角色校验。结果是「界面上按钮是灰的，跟助手说一句话就改了」。
 *   这里把写工具列出来，在入口统一按角色拦，两条路的口径才一致。
 */
const WRITE_TOOLS = new Set([
  'create_schedule', 'add_medicine', 'update_medicine', 'add_elder',
  'set_reminder_policy', 'handle_alerts',
  'delete_schedule', 'delete_medicine', 'delete_elder',
]);

/**
 * 工具执行器：返回结构化结果（会 JSON 化后回传给 LLM）
 * @param {object} [actor] 调用者身份 { role, userId }，用于角色校验
 */
async function executeTool(name, args, familyId, actor = null) {
  if (actor && actor.role === 'viewer' && WRITE_TOOLS.has(name)) {
    return { error: '当前账号是「只读成员」，不能通过助手修改数据；请让家庭主配置人或照护成员操作。' };
  }

  switch (name) {
    case 'list_elders': {
      const rows = await query(
        `SELECT name, age, gender, hearing_level, vision_level,
                IFNULL(chronic_diseases,'') AS chronic_diseases
         FROM elder WHERE family_id = ? AND status = 'active' ORDER BY id`,
        [familyId]
      );
      return { elders: rows.map((r) => ({ name: r.name, age: r.age, gender: r.gender === 'male' ? '男' : r.gender === 'female' ? '女' : '未知', chronic_diseases: r.chronic_diseases || '无' })) };
    }

    case 'list_medicines': {
      const rows = await query(
        `SELECT name, spec, unit, stock_qty, expiry_date, category
         FROM medicine WHERE family_id = ? AND status = 'active' ORDER BY name`,
        [familyId]
      );
      return { medicines: rows.map((r) => ({ name: r.name, spec: r.spec || '', stock_qty: r.stock_qty, expiry_date: r.expiry_date || '', category: r.category || '' })) };
    }

    case 'list_schedules': {
      let elderFilter = '';
      let elderId = null;
      if (args && args.elder_name) {
        const e = await findElder(familyId, args.elder_name);
        if (!e) return { error: `没有找到叫「${args.elder_name}」的老人` };
        elderFilter = 'AND s.elder_id = ?';
        elderId = e.id;
      }
      const params = elderId ? [familyId, elderId] : [familyId];
      const rows = await query(
        `SELECT el.name AS elder_name, s.dose_time, s.time_label, s.window_before_min, s.window_after_min
         FROM schedule s
         JOIN elder el ON el.id = s.elder_id
         WHERE el.family_id = ? ${elderFilter} AND s.status = 'active'
         ORDER BY el.name, s.dose_time`,
        params
      );
      return { schedules: rows.map((r) => ({ elder: r.elder_name, time: String(r.dose_time).slice(0, 5), label: r.time_label || '', window: `前${r.window_before_min}/后${r.window_after_min}分` })) };
    }

    case 'create_schedule': {
      const elderName = (args && args.elder_name) || '';
      const time = (args && args.time) || '';
      const names = (args && args.medicine_names) || [];
      if (!elderName) return { error: '缺少老人姓名' };
      if (!time) return { error: '缺少服药时间' };
      if (!names.length) return { error: '缺少药品名称' };

      const elder = await findElder(familyId, elderName);
      if (!elder) return { error: `没有找到叫「${elderName}」的老人，请先确认姓名` };

      // 药品：逐一匹配，找不到的记录下来
      const meds = [];
      const notFound = [];
      for (const mn of names) {
        const m = await queryOne(
          'SELECT id, name FROM medicine WHERE family_id = ? AND name = ? AND status = "active" LIMIT 1',
          [familyId, mn]
        );
        if (m) meds.push(m); else notFound.push(mn);
      }
      if (!meds.length) return { error: `没有找到这些药品：${notFound.join('、')}，请先在「药箱库存」添加` };

      const doseTime = /^\d{1,2}:\d{2}$/.test(time) ? time + ':00' : time;
      const timeLabel = (args && args.time_label) || labelByTime(time);

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.execute(
          `INSERT INTO schedule (elder_id, dose_time, time_label, window_before_min, window_after_min)
           VALUES (?,?,?,?,?)`,
          [elder.id, doseTime, timeLabel, 10, 30]
        );
        const scheduleId = r.insertId;
        for (const m of meds) {
          await conn.execute(
            'INSERT INTO schedule_item (schedule_id, medicine_id, dose_qty) VALUES (?,?,1)',
            [scheduleId, m.id]
          );
        }
        await conn.commit();
        const warn = notFound.length ? `（未找到：${notFound.join('、')}，已跳过）` : '';
        return { ok: true, created: `已为${elderName}新建计划：${String(doseTime).slice(0, 5)} ${timeLabel} 服用 ${meds.map((m) => m.name).join('、')}` + warn };
      } catch (e) {
        await conn.rollback();
        return { error: '创建计划失败：' + e.message };
      } finally {
        conn.release();
      }
    }

    case 'check_adherence': {
      let elderFilter = '';
      const params = [familyId];
      if (args && args.elder_name) {
        const e = await findElder(familyId, args.elder_name);
        if (!e) return { error: `没有找到叫「${args.elder_name}」的老人` };
        elderFilter = 'AND ie.elder_id = ?';
        params.push(e.id);
      }
      const days = Math.min(Math.max(parseInt((args && args.days) || 7, 10) || 7, 1), 30);
      params.push(days);
      const row = await queryOne(
        `SELECT COUNT(*) AS total,
                SUM(ie.result IN ('on_time','early','late')) AS taken,
                SUM(ie.result = 'missed') AS missed
         FROM intake_event ie
         JOIN elder el ON el.id = ie.elder_id
         WHERE el.family_id = ? ${elderFilter} AND ie.schedule_id IS NOT NULL
           AND ie.occurred_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
        params
      );
      const total = Number(row.total) || 0;
      const taken = Number(row.taken) || 0;
      const missed = Number(row.missed) || 0;
      const rate = total ? Math.round((taken / total) * 100) : 0;
      return { days, total, taken, missed, rate: rate + '%' };
    }

    case 'query_alerts': {
      const rows = await query(
        `SELECT el.name AS elder_name, a.alert_type, a.level, a.content, a.created_at
         FROM alert a
         JOIN elder el ON el.id = a.elder_id
         WHERE el.family_id = ? AND a.is_read = 0
         ORDER BY a.created_at DESC LIMIT 20`,
        [familyId]
      );
      const typeLabel = { missed: '漏服', duplicate: '重复取药', night_open: '夜间异常', repeat_missed: '连续漏服', offline: '设备离线', sos: 'SOS求助', stock_low: '库存不足', drug_conflict: '用药冲突', expiry: '效期预警' };
      return { alerts: rows.map((r) => ({ elder: r.elder_name, type: typeLabel[r.alert_type] || r.alert_type, content: r.content })) };
    }

    case 'check_expiry': {
      let elderFilter = '';
      const params = [familyId];
      if (args && args.elder_name) {
        const e = await findElder(familyId, args.elder_name);
        if (!e) return { error: `没有找到叫「${args.elder_name}」的老人` };
        elderFilter = 'AND e.id = ?';
        params.push(e.id);
      }
      // 只查「在服计划」关联的药（与主动建议同口径）；已过期或 30 天内到期
      const rows = await query(
        `SELECT m.name AS medicine_name, m.expiry_date, m.stock_qty,
                e.name AS elder_name,
                DATEDIFF(m.expiry_date, CURDATE()) AS days_left
         FROM medicine m
         JOIN schedule_item si ON si.medicine_id = m.id
         JOIN schedule s ON s.id = si.schedule_id
         JOIN elder e ON e.id = s.elder_id
         WHERE e.family_id = ? ${elderFilter}
           AND m.status = 'active' AND m.expiry_date IS NOT NULL
           AND m.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
         GROUP BY m.id, m.name, m.expiry_date, m.stock_qty, e.id, e.name
         ORDER BY m.expiry_date`,
        params
      );
      return { expiring: rows.map((r) => ({
        elder: r.elder_name,
        medicine: r.medicine_name,
        expiry_date: r.expiry_date,
        days_left: Number(r.days_left),
        expired: Number(r.days_left) < 0,
      })) };
    }

    case 'check_drug_conflicts': {
      const all = await Assistant.detectDrugConflicts(familyId);
      let list = all;
      if (args && args.elder_name) {
        list = all.filter((c) => c.elderName === args.elder_name);
      }
      const sevLabel = { critical: '高危', warn: '需注意' };
      // 对每条命中冲突做 LLM 二次研判（并行；无 Key / 失败时降级用规则库 title+hint）
      const reviewed = await Promise.all(list.map(async (c) => {
        let verdict = null;
        let reviewedBy = 'rule';
        try {
          const r = await Assistant.reviewConflictWithLLM(c);
          if (r && r.verdict) { verdict = r.verdict; reviewedBy = 'llm'; }
        } catch (e) { /* 降级为规则结论 */ }
        return {
          elder: c.elderName,
          severity: sevLabel[c.severity] || '需注意',
          drugs: c.drugs.join(' + '),
          title: c.title,
          hint: c.hint,
          verdict: verdict || c.hint,
          reviewedBy,
        };
      }));
      return { conflicts: reviewed };
    }

    case 'add_medicine': {
      const name = (args && args.name) || '';
      if (!name) return { error: '缺少药品名称' };
      const exists = await queryOne('SELECT id FROM medicine WHERE family_id = ? AND name = ? LIMIT 1', [familyId, name]);
      if (exists) return { error: `药品「${name}」已存在` };
      await exec(
        'INSERT INTO medicine (family_id, name, spec, unit, stock_qty, category) VALUES (?,?,?,?,?,?)',
        [familyId, name, (args && args.spec) || null, (args && args.unit) || '片', Number(args && args.stock_qty) || 0, (args && args.category) || null]
      );
      return { ok: true, created: `已添加药品「${name}」` };
    }

    case 'update_medicine': {
      const name = (args && args.name) || '';
      if (!name) return { error: '缺少药品名称' };
      const m = await queryOne('SELECT id, name FROM medicine WHERE family_id = ? AND name = ? LIMIT 1', [familyId, name]);
      if (!m) return { error: `没有找到药品「${name}」` };
      const sets = []; const vals = [];
      if (args && args.stock_qty != null) { sets.push('stock_qty = ?'); vals.push(Number(args.stock_qty)); }
      if (args && args.expiry_date) { sets.push('expiry_date = ?'); vals.push(args.expiry_date); }
      if (args && args.category) { sets.push('category = ?'); vals.push(args.category); }
      if (!sets.length) return { error: '没有需要修改的内容' };
      vals.push(m.id);
      await exec(`UPDATE medicine SET ${sets.join(',')} WHERE id = ?`, vals);
      return { ok: true, updated: `已更新药品「${name}」` };
    }

    case 'add_elder': {
      const name = (args && args.name) || '';
      if (!name) return { error: '缺少老人姓名' };
      const exists = await queryOne('SELECT id FROM elder WHERE family_id = ? AND name = ? LIMIT 1', [familyId, name]);
      if (exists) return { error: `老人「${name}」已存在` };
      const gender = (args && args.gender) === '女' ? 'female' : (args && args.gender) === '男' ? 'male' : null;
      await exec(
        'INSERT INTO elder (family_id, name, age, gender, chronic_diseases) VALUES (?,?,?,?,?)',
        [familyId, name, Number(args && args.age) || null, gender, (args && args.chronic_diseases) || null]
      );
      return { ok: true, created: `已添加老人「${name}」` };
    }

    case 'set_reminder_policy': {
      const elderName = (args && args.elder_name) || '';
      if (!elderName) return { error: '缺少老人姓名' };
      const e = await findElder(familyId, elderName);
      if (!e) return { error: `没有找到老人「${elderName}」` };
      const sets = []; const vals = [];
      if (args && args.volume_level != null) { sets.push('volume_level = ?'); vals.push(Math.min(Math.max(Number(args.volume_level), 1), 5)); }
      if (args && args.speech_rate) { sets.push('speech_rate = ?'); vals.push(args.speech_rate); }
      if (args && typeof args.remind_30m === 'boolean') { sets.push('remind_30m = ?'); vals.push(args.remind_30m ? 1 : 0); }
      if (args && typeof args.remind_10m === 'boolean') { sets.push('remind_10m = ?'); vals.push(args.remind_10m ? 1 : 0); }
      if (args && typeof args.remind_3m === 'boolean') { sets.push('remind_3m = ?'); vals.push(args.remind_3m ? 1 : 0); }
      if (!sets.length) return { error: '没有需要修改的提醒设置' };
      vals.push(e.id);
      await exec(`UPDATE elder SET ${sets.join(',')} WHERE id = ?`, vals);
      return { ok: true, updated: `已更新「${elderName}」的提醒策略` };
    }

    case 'handle_alerts': {
      const r = await exec(
        `UPDATE alert SET is_read = 1
         WHERE is_read = 0 AND elder_id IN (SELECT id FROM elder WHERE family_id = ?)`,
        [familyId]
      );
      return { ok: true, handled: r.affectedRows };
    }

    case 'delete_schedule': {
      const elderName = (args && args.elder_name) || '';
      const time = (args && args.time) || '';
      if (!elderName || !time) return { error: '缺少老人姓名或时间' };
      const e = await findElder(familyId, elderName);
      if (!e) return { error: `没有找到老人「${elderName}」` };
      const doseTime = /^\d{1,2}:\d{2}$/.test(time) ? time + ':00' : time;
      const s = await queryOne('SELECT id FROM schedule WHERE elder_id = ? AND dose_time = ? AND status = "active" LIMIT 1', [e.id, doseTime]);
      if (!s) return { error: `没有找到「${elderName}」在 ${time} 的计划` };
      await exec('DELETE FROM schedule WHERE id = ?', [s.id]);
      return { ok: true, deleted: `已删除「${elderName}」${time} 的计划` };
    }

    case 'delete_medicine': {
      const name = (args && args.name) || '';
      if (!name) return { error: '缺少药品名称' };
      const m = await queryOne('SELECT id FROM medicine WHERE family_id = ? AND name = ? LIMIT 1', [familyId, name]);
      if (!m) return { error: `没有找到药品「${name}」` };
      try {
        await exec('DELETE FROM medicine WHERE id = ?', [m.id]);
      } catch (err) {
        if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451) {
          return { error: `药品「${name}」已被服药计划引用，无法直接删除，请先删除相关计划` };
        }
        throw err;
      }
      return { ok: true, deleted: `已删除药品「${name}」` };
    }

    case 'delete_elder': {
      const name = (args && args.name) || '';
      if (!name) return { error: '缺少老人姓名' };
      const e = await findElder(familyId, name);
      if (!e) return { error: `没有找到老人「${name}」` };
      await exec('DELETE FROM elder WHERE id = ?', [e.id]);
      return { ok: true, deleted: `已删除老人「${name}」及其全部服药数据` };
    }

    default:
      return { error: `未知工具 ${name}` };
  }
}

/** 关键词降级路由（方案 B：无 LLM 时保证「查」类可用） */
async function fallback(familyId, input) {
  const t = String(input || '');

  const tryElderName = () => {
    // 从常见句式中摘老人名（粗匹配，够用即可）
    const m = t.match(/(?:给|帮|为|查)\s*([\u4e00-\u9fa5]{2,4})(?:的|老|奶奶|爷爷|妈|爸)/);
    return m ? m[1] : null;
  };

  if (/告警|异常|漏服|提醒|报警/.test(t)) {
    const r = await executeTool('query_alerts', {}, familyId);
    return { answer: formatResult('query_alerts', r), engine: 'rule', actions: [{ tool: 'query_alerts' }] };
  }
  if (/过期|到期|效期|保质/.test(t)) {
    const r = await executeTool('check_expiry', { elder_name: tryElderName() }, familyId);
    return { answer: formatResult('check_expiry', r), engine: 'rule', actions: [{ tool: 'check_expiry' }] };
  }
  if (/冲突|相互作用|配伍|相克|一起.*吃/.test(t)) {
    const r = await executeTool('check_drug_conflicts', { elder_name: tryElderName() }, familyId);
    return { answer: formatResult('check_drug_conflicts', r), engine: 'rule', actions: [{ tool: 'check_drug_conflicts' }] };
  }
  if (/按时|依从|坚持|这周|最近.*吃|吃.*怎么样/.test(t)) {
    const r = await executeTool('check_adherence', { elder_name: tryElderName(), days: 7 }, familyId);
    return { answer: formatResult('check_adherence', r), engine: 'rule', actions: [{ tool: 'check_adherence' }] };
  }
  if (/老人|家里有谁|几位|谁在/.test(t)) {
    const r = await executeTool('list_elders', {}, familyId);
    return { answer: formatResult('list_elders', r), engine: 'rule', actions: [{ tool: 'list_elders' }] };
  }
  if (/药(有|在|库|哪些|什么)|库存|药品/.test(t)) {
    const r = await executeTool('list_medicines', {}, familyId);
    return { answer: formatResult('list_medicines', r), engine: 'rule', actions: [{ tool: 'list_medicines' }] };
  }
  if (/计划|吃什么|几点吃|怎么吃/.test(t)) {
    const r = await executeTool('list_schedules', { elder_name: tryElderName() }, familyId);
    return { answer: formatResult('list_schedules', r), engine: 'rule', actions: [{ tool: 'list_schedules' }] };
  }
  if (/加|新建|创建|新增/.test(t) && /吃|计划|药/.test(t)) {
    return { answer: 'AI 未连接，暂时无法自动创建计划。请到「服药计划」页手动添加，或稍后重试。', engine: 'rule', actions: [] };
  }

  return { answer: 'AI 未连接，我只能做简单的查询。请检查大模型配置后重试，或到对应页面手动操作。', engine: 'rule', actions: [] };
}

/** 把结构化结果渲染成一句可读的话（降级时用） */
function formatResult(tool, r) {
  if (r.error) return r.error;
  switch (tool) {
    case 'list_elders': {
      const list = r.elders || [];
      return list.length
        ? '家里有：' + list.map((e) => `${e.name}${e.age ? `（${e.age}岁）` : ''}`).join('、')
        : '家里还没有添加老人，请到「家庭成员」页添加。';
    }
    case 'list_medicines': {
      const list = r.medicines || [];
      return list.length
        ? '在库药品：' + list.map((m) => `${m.name}（剩${m.stock_qty}）`).join('、')
        : '药箱里还没有药品，请到「药箱库存」页添加。';
    }
    case 'list_schedules': {
      const list = r.schedules || [];
      return list.length
        ? '服药计划：' + list.map((s) => `${s.elder} ${s.time}${s.label ? ' ' + s.label : ''}`).join('；')
        : '还没有服药计划，请到「服药计划」页添加。';
    }
    case 'check_adherence': {
      if (!r.total) return '最近没有服药记录。';
      return `近 ${r.days} 天共 ${r.total} 次计划，按时 ${r.taken} 次、漏服 ${r.missed} 次，按时率 ${r.rate}。`;
    }
    case 'query_alerts': {
      const list = r.alerts || [];
      return list.length
        ? `有 ${list.length} 条未处理告警：` + list.map((a) => `${a.elder}·${a.type}`).join('、')
        : '目前没有未处理的告警。';
    }
    case 'check_expiry': {
      const list = r.expiring || [];
      if (!list.length) return '目前没有 30 天内到期或已过期的药。';
      return list.map((x) => {
        const d = x.expired ? `已过期 ${-x.days_left} 天` : `还有 ${x.days_left} 天到期`;
        return `${x.elder}·${x.medicine}（${d}）`;
      }).join('；');
    }
    case 'check_drug_conflicts': {
      const list = r.conflicts || [];
      if (!list.length) return '未发现用药相互作用（按已录入的成分规则库比对）。';
      return list.map((c) => `${c.elder}：${c.drugs}（${c.severity}）${c.verdict || c.title}`).join('；');
    }
    default:
      return '已完成操作。';
  }
}

/**
 * 主入口：跑一轮 Agent
 * @param {number} familyId 当前家庭
 * @param {string} userInput 用户输入
 * @returns {Promise<{answer:string, actions:Array, engine:'llm'|'rule'}>}
 */
/** 危险工具：删除类操作，执行前必须二次确认 */
const DANGEROUS = new Set(['delete_schedule', 'delete_medicine', 'delete_elder']);

function describeArgs(tool, args) {
  switch (tool) {
    case 'delete_schedule': return `删除计划：${args.elder_name || ''} ${args.time || ''}`;
    case 'delete_medicine': return `删除药品：${args.name || ''}`;
    case 'delete_elder': return `删除老人：${args.name || ''}（含全部服药数据）`;
    default: return tool;
  }
}

async function runAgent(familyId, userInput, confirmed = null, actor = null) {
  // 已确认的删除操作：直接执行对应工具，不再走 LLM（保证确认后必定执行、且不再被 LLM 反问）
  if (confirmed && confirmed.tool && DANGEROUS.has(confirmed.tool)) {
    try {
      const result = await executeTool(confirmed.tool, confirmed.args || {}, familyId, actor);
      if (result.error) {
        return { answer: `删除失败：${result.error}`, actions: [{ tool: confirmed.tool, ok: false, summary: result.error }], engine: 'llm' };
      }
      return { answer: `${result.deleted} ✅`, actions: [{ tool: confirmed.tool, args: confirmed.args || {}, ok: true, summary: result.deleted }], engine: 'llm' };
    } catch (e) {
      return { answer: '删除失败：' + e.message, actions: [], engine: 'llm' };
    }
  }

  // 大模型可用 → Function Calling
  if (llm.isEnabled()) {
    try {
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userInput },
      ];
      const actions = [];
      const pending = [];

      // 多轮循环：每轮都可能继续调用工具，直到 LLM 不再调工具为止（上限 3 轮）
      for (let round = 0; round < 3; round++) {
        const resp = await llm.complete({ messages, tools: TOOLS, maxTokens: 600, temperature: 0.2 });
        const toolCalls = (resp.tool_calls || []).filter((tc) => tc.function && tc.function.name);

        // 不再调工具 → 返回最终回复（若有待确认的删除操作，优先返回待确认）
        if (!toolCalls.length) {
          if (pending.length) {
            return {
              answer: '⚠️ 以下操作需要你确认：\n' + pending.map((p) => '· ' + p.summary).join('\n'),
              pending, needsConfirm: true, actions, engine: 'llm',
            };
          }
          const answer = String(resp.content || '').trim();
          if (answer) return { answer, actions, engine: 'llm' };
          return { answer: actions.length ? '操作已完成。' : '（无回答）', actions, engine: 'llm' };
        }

        // 执行本轮所有工具
        messages.push(resp);
        for (const tc of toolCalls) {
          const fn = tc.function;
          let args = {};
          try { args = JSON.parse(fn.arguments || '{}'); } catch { args = {}; }

          // 危险操作：需二次确认（未确认则暂缓，不执行）
          if (DANGEROUS.has(fn.name)) {
            const isConfirmed = confirmed && confirmed.tool === fn.name &&
              JSON.stringify(confirmed.args || {}) === JSON.stringify(args);
            if (!isConfirmed) {
              pending.push({ tool: fn.name, args, summary: describeArgs(fn.name, args) });
              messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ needsConfirm: true, message: '该删除操作需要用户二次确认，已暂缓执行' }) });
              continue;
            }
          }

          let result;
          try {
            result = await executeTool(fn.name, args, familyId, actor);
          } catch (e) {
            result = { error: '工具执行异常：' + e.message };
          }
          actions.push({ tool: fn.name, args, ok: !result.error, summary: result.created || result.deleted || result.error || '' });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      }

      // 达到最大轮数仍未结束
      if (pending.length) {
        return { answer: '⚠️ 以下操作需要你确认：\n' + pending.map((p) => '· ' + p.summary).join('\n'), pending, needsConfirm: true, actions, engine: 'llm' };
      }
      const last = await llm.complete({ messages, maxTokens: 600, temperature: 0.3 });
      return { answer: String(last.content || '').trim() || '操作已完成。', actions, engine: 'llm' };
    } catch (e) {
      // LLM 调用失败 → 降级
      return fallback(familyId, userInput);
    }
  }

  // 无 LLM → 直接降级
  return fallback(familyId, userInput);
}

module.exports = { runAgent, TOOLS, executeTool, WRITE_TOOLS };
