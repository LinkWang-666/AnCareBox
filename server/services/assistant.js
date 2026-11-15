/**
 * AI 用药助手 —— 主动式 Agent 服务层
 *
 * 设计定位（答辩可讲）：
 *   传统「AI 问答」是被动的：用户问一句，机器答一句，答完就结束。
 *   本项目把 Agent 从「问答式」升级为「主动接管」：
 *     1) 持续读取家庭内老人的服药数据（intake_event / alert / schedule）
 *     2) 自己发现异常（漏服模式、重复服药、低库存、依从性下滑）
 *     3) 主动产出「建议」(insight)，而不是等子女来问
 *     4) 子女也可以随时打开「AI 用药助手」窗口主动提问（ask）
 *
 * 本文件实现「主动式用药 Agent」的服务层：
 *   - buildInsights()  主动建议：规则引擎汇总服药数据，产出结构化建议（evidence 可追溯）
 *   - generateAnswer() 问答：优先调用真实大模型（llm.js），失败/无 Key 自动降级规则引擎
 *
 * 为什么「主动建议」用规则引擎、而「问答」才接大模型：
 *   - 主动建议要能追溯到具体数据（漏服次数、库存阈值），必须是可复现的结构化结果；
 *   - 问答需要理解自然语言、自由对话，这才是大模型真正的价值所在；
 *   - 两者返回结构固定，UI（队友）不关心背后是规则还是大模型。
 *
 * 为什么用结构化建议而非直接返回大模型长文本：
 *   - 前端（队友 UI）需要稳定的字段来渲染卡片、图标、优先级标签；
 *   - 建议要能追溯到具体数据（evidence），做到「每条建议有依据」；
 *   - 规则结果可复现、可测试，不依赖外部 API 稳定性。
 */

const { query, queryOne, exec } = require('../db');
const llm = require('./llm');

/** 建议优先级：critical > warn > info */
const PRIORITY = { CRITICAL: 'critical', WARN: 'warn', INFO: 'info' };

/** 建议类型：漏服 / 依从性下滑 / 重复服药 / 库存 / 时段 / 通用提醒 / 用药冲突 */
const TYPE = {
  MISSED: 'missed',
  ADHERENCE_DROP: 'adherence_drop',
  DUPLICATE: 'duplicate',
  STOCK_LOW: 'stock_low',
  TIME_IRREGULAR: 'time_irregular',
  REMINDER: 'reminder',
  DRUG_INTERACTION: 'drug_interaction',
  EXPIRING: 'expiring',
};

/**
 * 用药相互作用规则库（主动冲突检测用）。
 *
 * 设计说明（答辩可讲）：
 *   - v1 只能按「药名」关键词匹配，容易漏（商品名五花八门）；
 *   - v2 升级为「成分级」匹配：优先用 medicine.active_ingredient 比对，
 *     没填成分时回退到药名关键词，覆盖面更广、误报更少；
 *   - 规则保守：命中只提示「可能相互作用，请核对说明书/咨询药师」，不做诊断；
 *   - 本地规则引擎（可复现、可溯源、离线可用），命中后再交大模型二次研判（见 buildInsights）。
 *
 * 规则结构：{ id, title, severity, pairs:[{ left:{label,kw[]}, right:{label,kw[]} }], hint }
 *   kw 匹配的是「成分名」（首选）或「药名关键词」（回退）。
 */
const DRUG_INTERACTIONS = [
  {
    // 降糖药联用 → 低血糖风险叠加
    id: 'hypoglycemia',
    title: '降糖药物联用，低血糖风险叠加',
    severity: 'warn',
    pairs: [
      {
        left: { label: '磺脲类/格列奈类', kw: ['格列美脲', '格列齐特', '格列吡嗪', '格列本脲', '瑞格列奈', '那格列奈'] },
        right: { label: '双胍类/其他降糖药', kw: ['二甲双胍', '阿卡波糖', '伏格列波糖', '西格列汀', '沙格列汀', '恩格列净', '达格列净'] },
      },
    ],
    hint: '多种降糖药联用会显著增加低血糖风险，建议核对血糖监测频率与剂量，并咨询医生确认联合方案。',
  },
  {
    // 阿司匹林/抗血小板 + 抗凝/NSAID → 出血风险
    id: 'bleeding',
    title: '抗血小板/抗凝/NSAID 联用，出血风险升高',
    severity: 'critical',
    pairs: [
      {
        left: { label: '阿司匹林', kw: ['阿司匹林'] },
        right: { label: '其他抗凝/抗血小板/NSAID', kw: ['华法林', '利伐沙班', '达比加群', '氯吡格雷', '替格瑞洛', '布洛芬', '双氯芬酸', '塞来昔布', '吲哚美辛', '萘普生'] },
      },
      {
        left: { label: '氯吡格雷', kw: ['氯吡格雷'] },
        right: { label: '抗凝药', kw: ['华法林', '利伐沙班', '达比加群', '阿哌沙班'] },
      },
    ],
    hint: '多种影响凝血功能的药物同用会增加消化道出血等风险，务必咨询医生或药师，不要自行叠加。',
  },
  {
    // 他汀类 + 贝特类/大环内酯 → 肌病风险
    id: 'statin',
    title: '他汀类联用需关注肌病/肝损风险',
    severity: 'warn',
    pairs: [
      {
        left: { label: '他汀类降脂药', kw: ['阿托伐他汀', '瑞舒伐他汀', '辛伐他汀', '普伐他汀', '氟伐他汀', '匹伐他汀', '洛伐他汀'] },
        right: { label: '贝特类/大环内酯等', kw: ['非诺贝特', '苯扎贝特', '吉非罗齐', '克拉霉素', '红霉素', '伊曲康唑', '酮康唑'] },
      },
    ],
    hint: '他汀类与上述药物联用可能增加肌病（肌肉酸痛）与肝损风险，建议定期监测肌酸激酶与肝功能。',
  },
  {
    // 硝酸酯类 + PDE5 抑制剂 → 严重低血压（绝对禁忌）
    id: 'nitrate_pde5',
    title: '硝酸酯类与西地那非等同用，可致严重低血压',
    severity: 'critical',
    pairs: [
      {
        left: { label: '硝酸酯类', kw: ['硝酸异山梨酯', '单硝酸异山梨酯', '硝酸甘油'] },
        right: { label: 'PDE5抑制剂', kw: ['西地那非', '他达拉非', '伐地那非'] },
      },
    ],
    hint: '此两类药属绝对禁忌联用，可导致危及生命的低血压，严禁同时服用。',
  },
  {
    // β受体阻滞剂 + 非二氢吡啶类钙拮抗剂 → 心动过缓
    id: 'bradycardia',
    title: 'β受体阻滞剂联用需防心动过缓',
    severity: 'warn',
    pairs: [
      {
        left: { label: 'β受体阻滞剂', kw: ['美托洛尔', '比索洛尔', '普萘洛尔', '阿替洛尔', '卡维地洛'] },
        right: { label: '非二氢吡啶钙拮抗剂', kw: ['维拉帕米', '地尔硫卓', '地尔硫'] },
      },
    ],
    hint: '两类药均减慢心率，联用可能引起严重心动过缓或传导阻滞，需医生评估。',
  },
  {
    // 保钾利尿剂 + ACEI/ARB → 高钾血症
    id: 'hyperkalemia',
    title: '保钾利尿剂联用 ACEI/ARB，高钾血症风险',
    severity: 'warn',
    pairs: [
      {
        left: { label: '保钾利尿剂', kw: ['螺内酯', '氨苯蝶啶'] },
        right: { label: 'ACEI/ARB', kw: ['卡托普利', '依那普利', '贝那普利', '培哚普利', '缬沙坦', '氯沙坦', '厄贝沙坦', '替米沙坦', '坎地沙坦'] },
      },
    ],
    hint: '两者联用可能导致血钾升高，尤其肾功能不全者需定期监测血钾。',
  },
  {
    // ACEI/ARB + 钾补充剂/其他升钾药 → 高钾
    id: 'hyperkalemia_2',
    title: 'ACEI/ARB 与含钾药物联用，注意高钾血症',
    severity: 'warn',
    pairs: [
      {
        left: { label: 'ACEI/ARB', kw: ['卡托普利', '依那普利', '贝那普利', '培哚普利', '缬沙坦', '氯沙坦', '厄贝沙坦', '替米沙坦'] },
        right: { label: '补钾剂/升钾药', kw: ['氯化钾', '枸橼酸钾'] },
      },
    ],
    hint: '同用可能引起血钾过高，建议监测血钾并遵医嘱。',
  },
  {
    // 华法林 + 多种药物 → 出血/INR 波动（广谱提示）
    id: 'warfarin',
    title: '华法林与其他药物联用，需监测 INR',
    severity: 'critical',
    pairs: [
      {
        left: { label: '华法林', kw: ['华法林'] },
        right: { label: '影响凝血/代谢的药物', kw: ['阿司匹林', '布洛芬', '胺碘酮', '甲硝唑', '氟康唑', '左氧氟沙星', '磺胺'] },
      },
    ],
    hint: '华法林治疗窗窄，联用多种药物会显著影响抗凝强度，务必监测 INR 并咨询医生。',
  },
  {
    // 地高辛 + 某些药物 → 地高辛中毒
    id: 'digoxin',
    title: '地高辛与胺碘酮等联用，中毒风险升高',
    severity: 'critical',
    pairs: [
      {
        left: { label: '地高辛', kw: ['地高辛'] },
        right: { label: '升高地高辛浓度的药物', kw: ['胺碘酮', '维拉帕米', '克拉霉素', '伊曲康唑'] },
      },
    ],
    hint: '联用可能升高地高辛血药浓度导致中毒（恶心、心律失常），需监测血药浓度。',
  },
  {
    // 锂盐 + NSAID/噻嗪类 → 锂中毒
    id: 'lithium',
    title: '锂盐与 NSAID/噻嗪类联用，注意锂中毒',
    severity: 'warn',
    pairs: [
      {
        left: { label: '碳酸锂', kw: ['碳酸锂', '锂'] },
        right: { label: 'NSAID/噻嗪类利尿剂', kw: ['布洛芬', '双氯芬酸', '吲哚美辛', '氢氯噻嗪'] },
      },
    ],
    hint: '联用会升高血锂浓度，可能引起锂中毒，需监测血锂浓度。',
  },
  {
    // 重复成分（同成分不同商品名）→ 重复用药
    id: 'duplicate_ingredient',
    title: '含相同成分的药品重复使用，剂量可能超标',
    severity: 'warn',
    pairs: [
      {
        left: { label: '对乙酰氨基酚', kw: ['对乙酰氨基酚', '扑热息痛'] },
        right: { label: '含对乙酰氨基酚的复方感冒药', kw: ['对乙酰氨基酚', '扑热息痛', '氨酚'] },
      },
    ],
    hint: '多种药品含同一成分时易导致该成分日剂量超标，注意核对总剂量。',
  },
  {
    // SSRI/SNRI 抗抑郁 + MAOI → 5-羟色胺综合征（高危）
    id: 'serotonin',
    title: '抗抑郁药联用，警惕 5-羟色胺综合征',
    severity: 'critical',
    pairs: [
      {
        left: { label: 'SSRI/SNRI', kw: ['氟西汀', '舍曲林', '帕罗西汀', '西酞普兰', '艾司西酞普兰', '文拉法辛', '度洛西汀'] },
        right: { label: 'MAOI/其他5-HT能药物', kw: ['吗氯贝胺', '司来吉兰', '曲马多', '圣约翰草'] },
      },
    ],
    hint: '联用可能诱发危及生命的 5-羟色胺综合征（高热、肌强直、意识改变），属高危联用，严禁自行联用。',
  },
  {
    // 糖皮质激素 + NSAID → 消化道出血/溃疡
    id: 'steroid_nsaid',
    title: '糖皮质激素与 NSAID 联用，消化道出血风险升高',
    severity: 'warn',
    pairs: [
      {
        left: { label: '糖皮质激素', kw: ['泼尼松', '甲泼尼龙', '地塞米松', '氢化可的松'] },
        right: { label: 'NSAID', kw: ['布洛芬', '双氯芬酸', '塞来昔布', '吲哚美辛', '萘普生', '阿司匹林'] },
      },
    ],
    hint: '两者联用会显著增加胃肠道溃疡与出血风险，如需长期同用应在医师指导下加胃黏膜保护。',
  },
  {
    // 甲氨蝶呤 + NSAID → 毒性增加
    id: 'methotrexate_nsaid',
    title: '甲氨蝶呤与 NSAID 联用，毒性增加',
    severity: 'critical',
    pairs: [
      {
        left: { label: '甲氨蝶呤', kw: ['甲氨蝶呤'] },
        right: { label: 'NSAID', kw: ['布洛芬', '双氯芬酸', '塞来昔布', '吲哚美辛', '萘普生'] },
      },
    ],
    hint: 'NSAID 会降低甲氨蝶呤排泄，可能引起骨髓抑制等严重毒性，需医生密切监测。',
  },
  {
    // 喹诺酮类 + 含铝镁钙/铁剂 → 吸收下降
    id: 'quinolone_antacid',
    title: '喹诺酮类与抗酸剂/铁钙剂同服，吸收下降',
    severity: 'warn',
    pairs: [
      {
        left: { label: '喹诺酮类', kw: ['左氧氟沙星', '莫西沙星', '环丙沙星', '诺氟沙星'] },
        right: { label: '抗酸剂/铁钙剂', kw: ['铝碳酸镁', '碳酸钙', '硫酸亚铁', '枸橼酸铁', '多糖铁'] },
      },
    ],
    hint: '含铝镁钙铁的药物会与喹诺酮类结合，降低其吸收，建议错开 2 小时以上服用。',
  },
  {
    // 镇静催眠 + 阿片类 → 呼吸抑制（高危）
    id: 'benzo_opioid',
    title: '镇静催眠药与阿片类联用，可致呼吸抑制（高危）',
    severity: 'critical',
    pairs: [
      {
        left: { label: '苯二氮卓/镇静催眠', kw: ['地西泮', '艾司唑仑', '阿普唑仑', '劳拉西泮', '氯硝西泮', '唑吡坦', '佐匹克隆'] },
        right: { label: '阿片类', kw: ['吗啡', '曲马多', '可待因', '羟考酮', '芬太尼', '哌替啶'] },
      },
    ],
    hint: '两类药物均抑制呼吸，联用可能引起重度镇静甚至呼吸抑制，属高危联用，务必遵医嘱。',
  },
  {
    // 左甲状腺素 + 钙/铁剂 → 吸收降低
    id: 'levothyroxine_cation',
    title: '左甲状腺素与钙剂/铁剂同服，吸收降低',
    severity: 'warn',
    pairs: [
      {
        left: { label: '左甲状腺素', kw: ['左甲状腺素', '优甲乐', '甲状腺素'] },
        right: { label: '钙剂/铁剂/抗酸药', kw: ['碳酸钙', '钙尔奇', '硫酸亚铁', '铝碳酸镁'] },
      },
    ],
    hint: '钙剂、铁剂会显著降低左甲状腺素的吸收，建议间隔 4 小时以上服用并定期复查甲状腺功能。',
  },
  {
    // 普萘洛尔 + 磺脲类 → 掩盖低血糖
    id: 'betablocker_hypoglycemia',
    title: '普萘洛尔掩盖低血糖症状，需加强血糖监测',
    severity: 'warn',
    pairs: [
      {
        left: { label: '普萘洛尔', kw: ['普萘洛尔'] },
        right: { label: '磺脲类降糖药', kw: ['格列美脲', '格列齐特', '格列吡嗪', '格列本脲'] },
      },
    ],
    hint: '非选择性β受体阻滞剂会掩盖心慌、出汗等低血糖预警症状，联用时应加密血糖监测。',
  },
  {
    // SSRI + 阿司匹林/NSAID → 出血
    id: 'ssri_bleeding',
    title: 'SSRI 抗抑郁药与抗血小板/NSAID 联用，出血风险升高',
    severity: 'warn',
    pairs: [
      {
        left: { label: 'SSRI/SNRI', kw: ['氟西汀', '舍曲林', '帕罗西汀', '西酞普兰', '艾司西酞普兰', '文拉法辛', '度洛西汀'] },
        right: { label: '阿司匹林/NSAID', kw: ['阿司匹林', '布洛芬', '双氯芬酸', '塞来昔布'] },
      },
    ],
    hint: '两者联用会增加消化道出血风险，尤其老年人，必要时加用胃黏膜保护并监测。',
  },
  {
    // 克拉霉素 + 秋水仙碱 → 毒性
    id: 'clarithro_colchicine',
    title: '克拉霉素与秋水仙碱联用，毒性显著增加',
    severity: 'critical',
    pairs: [
      {
        left: { label: '克拉霉素', kw: ['克拉霉素'] },
        right: { label: '秋水仙碱', kw: ['秋水仙碱'] },
      },
    ],
    hint: '克拉霉素抑制秋水仙碱代谢，联用可致严重的骨髓抑制与多器官毒性，属禁忌联用。',
  },
];

/**
 * 判断某药品是否命中关键词组（成分级：优先用主要成分，回退药名）
 * @param {object} med { name, active_ingredient }
 * @param {string[]} kws 关键词（成分名或药名）
 */
function matchKw(med, kws) {
  // 优先匹配主要成分（更精准），回退药名（兼容未填成分的老数据）
  const ingredient = String(med.active_ingredient || '').trim();
  const name = String(med.name || '');
  return kws.some((k) => {
    const kw = String(k);
    // 成分字段命中
    if (ingredient) {
      const parts = ingredient.split(/[,，、;；\s]+/).filter(Boolean);
      if (parts.some((p) => p === kw || p.includes(kw))) return true;
    }
    // 药名关键词命中
    return name.includes(kw);
  });
}

/**
 * 加载家庭的「全部在库药品 → 归属老人」清单（冲突检测与 LLM 全量研判共用）。
 *
 * 为什么把范围从「已排进服药计划的药」扩大到「家庭全部在库药」：
 *   - 早期只检查「已排进生效中计划的药」，药箱里的备用药、停用计划的药、
 *     以及尚未排进任何计划的药都不会被查，容易出现「两种药同服有冲突却没预警」的漏报；
 *   - 升级后：只要是在库（status='active'）的药都纳入检测，做到「全覆盖」。
 *
 * 归属规则（决定冲突记到哪位老人头上）：
 *   - 已排进某位老人「生效中计划」的药 → 归属该老人（明确服用关系）；
 *   - 未排进任何计划的「家庭备用/共用」药 → 归属家庭内所有老人
 *     （谁吃都可能，因此与任何老人的药组合都值得查）。
 *
 * @param {number} familyId
 * @returns {Promise<{ byElder: Map, meds: Array }>}
 */
async function loadElderMedInventory(familyId) {
  const [medRows, elderRows] = await Promise.all([
    query(
      `SELECT id, name, active_ingredient FROM medicine
        WHERE family_id = ? AND status = 'active'
        ORDER BY id`,
      [familyId]
    ),
    query(`SELECT id, name FROM elder WHERE family_id = ? ORDER BY id`, [familyId]),
  ]);

  const elderIds = elderRows.map((e) => Number(e.id));
  const elderIdSet = new Set(elderIds);

  // 药品与「生效中计划」的关联：medicine → 老人集合
  const medIds = medRows.map((m) => m.id);
  const scheduleRows = medIds.length
    ? await query(
        `SELECT si.medicine_id AS med_id, s.elder_id AS elder_id
           FROM schedule_item si
           JOIN schedule s ON s.id = si.schedule_id
          WHERE s.status = 'active'
            AND si.medicine_id IN (${medIds.map(() => '?').join(',')})`,
        medIds
      )
    : [];

  const medToElders = new Map();
  for (const r of scheduleRows) {
    const eid = Number(r.elder_id);
    if (!elderIdSet.has(eid)) continue;
    const mid = Number(r.med_id);
    if (!medToElders.has(mid)) medToElders.set(mid, new Set());
    medToElders.get(mid).add(eid);
  }

  // 每位老人一份在服（或可能服用）药单
  const byElder = new Map();
  for (const e of elderRows) {
    byElder.set(Number(e.id), { elderId: Number(e.id), name: e.name, meds: new Map() });
  }
  for (const m of medRows) {
    const medObj = { id: Number(m.id), name: m.name, active_ingredient: m.active_ingredient || '' };
    const targets = medToElders.has(Number(m.id)) ? medToElders.get(Number(m.id)) : elderIdSet;
    for (const eid of targets) {
      byElder.get(eid).meds.set(medObj.id, medObj);
    }
  }

  return { byElder, elderIds, meds: medRows };
}

/**
 * 规则引擎冲突匹配：给定每位老人的药单，两两命中 DRUG_INTERACTIONS 即记为冲突。
 * 供 detectDrugConflicts 与 buildInsights 复用（后者再把结果交给 LLM 二次/全量研判）。
 */
function ruleConflictsFromInventory(inventory) {
  const conflicts = [];

  for (const [, elder] of inventory.byElder) {
    const meds = [...elder.meds.values()];
    if (meds.length < 2) continue;

    for (const rule of DRUG_INTERACTIONS) {
      for (const pair of rule.pairs) {
        // 在该老人药品里，分别找出命中 left / right 的药品
        const leftMeds = meds.filter((m) => matchKw(m, pair.left.kw));
        const rightMeds = meds.filter((m) => matchKw(m, pair.right.kw));
        // 同一个药同时命中左右两侧属自我误报，一律跳过；
        // 「重复成分」类规则（左右关键词相同）由两两交叉后按去重键自然去重。
        for (const lm of leftMeds) {
          for (const rm of rightMeds) {
            if (lm.id === rm.id) continue;
            conflicts.push({
              elderId: elder.elderId,
              elderName: elder.name,
              ruleId: rule.id,
              severity: rule.severity,
              title: rule.title,
              drugs: [lm.name, rm.name],
              drugIds: [lm.id, rm.id],
              hint: rule.hint,
            });
          }
        }
      }
    }
  }

  // 去重（同一老人同一规则同一对药只保留一条）
  const seen = new Set();
  return conflicts.filter((c) => {
    const key = [c.elderId, c.ruleId, ...c.drugs.slice().sort()].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 检测家庭内所有老人的用药相互作用（规则引擎，已扩展到「全部在库药」）。
 * @param {number} familyId
 * @param {object} [inventory] 可选：调用方已算好的库存归属，避免重复查询
 * @returns {Promise<Array>} 冲突数组
 */
async function detectDrugConflicts(familyId, inventory) {
  const inv = inventory || (await loadElderMedInventory(familyId));
  return ruleConflictsFromInventory(inv);
}

/**
 * 大模型二次研判系统提示词。
 * 规则引擎命中的「候选冲突」交到这里做二次确认：结合老人的慢病、过敏史、
 * 年龄、以及两药的药理，给出更专业、更谨慎的结论。
 */
const LLM_REVIEW_SYSTEM = `你是「安心格」智能药箱系统的用药安全复核员（面向照护老人的子女，非患者本人）。
你收到的是一份「规则引擎初步命中的用药相互作用候选」，需要你做二次研判。

必须遵守：
1. 只基于给出的老人信息与药品名做药理层面的谨慎判断，不编造剂量、不臆造说明书内容。
2. 明确区分：哪些是「明确的危险联用」、哪些是「需警惕但可监测」、哪些是「规则误报（其实可安全联用）」。
3. 语气专业但说人话，控制在 120 字以内，直接给结论，不要寒暄。
4. 结尾若涉及处方药，提醒「请咨询医生或药师」。
5. 你不做诊断、不开处方。`;

/**
 * 对单条冲突做 LLM 二次研判。
 * @param {object} conflict { elderId, elderName, drugs:[], title, severity }
 * @returns {Promise<object|null>} { verdict, engine:'llm' } 或 null（无 Key/失败时由调用方降级）
 */
async function reviewConflictWithLLM(conflict) {
  if (!llm.isEnabled()) return null;

  // 取老人慢病/过敏/年龄作为上下文
  const elderRow = await query(
    `SELECT name, age, chronic_diseases, allergies FROM elder WHERE id = ?`,
    [conflict.elderId]
  );
  const e = elderRow[0] || {};
  const ctx = [
    `老人：${e.name || conflict.elderName}${e.age ? '（' + e.age + '岁）' : ''}`,
    e.chronic_diseases ? `慢病史：${e.chronic_diseases}` : '慢病史：无记录',
    e.allergies ? `过敏史：${e.allergies}` : '过敏史：无记录',
    `候选冲突药物：「${conflict.drugs.join('」与「')}」`,
    `规则初判：${conflict.title}`,
  ].join('\n');

  const verdict = await llm.chat({
    system: LLM_REVIEW_SYSTEM,
    user: ctx,
    temperature: 0.2,
    maxTokens: 200,
  });

  return { verdict, engine: 'llm' };
}

/** LLM 全量扫描系统提示词：对规则库之外的两两组合做兜底研判 */
const LLM_SCAN_SYSTEM = `你是「安心格」智能药箱的用药安全复核员（面向照护老人的子女）。
你收到一份「两两药品组合」清单，需要判断哪些组合存在有临床意义的用药相互作用。

必须遵守：
1. 只输出「真实存在、值得提醒」的相互作用；无明确相互作用的组合一律忽略，不要硬凑、不要重复。
2. 不编造剂量与说明书内容；不诊断、不开处方。
3. severity 只用两个取值：critical（高危/危险/禁忌联用）、warn（需警惕、可监测）。
4. title 一句结论（≤30字），hint 一段进一步说明与建议。
5. 严格输出 JSON 数组，禁止 Markdown 代码块或任何解释性文字。`;

/** LLM 全量研判结果缓存（家庭级，短 TTL，避免 60s 轮询反复烧 token） */
const LLM_SCAN_CACHE = new Map(); // familyId -> { at, conflicts }
const LLM_SCAN_TTL = 10 * 60 * 1000;

/** 从 LLM 返回文本里稳健地抠出第一个 JSON 数组 */
function extractJsonArray(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

/**
 * LLM 全量研判：对规则库「未命中」的所有两两组合做一次批量复核，补齐规则盲区。
 *
 * 为什么需要这一步：
 *   - 规则库再全也只是有限的关键词组合，覆盖不了所有药品；
 *   - 用一次批量 LLM 调用把「规则没识别的组合」整体扫一遍，能补上规则盲区，实现「全覆盖」；
 *   - 同一「药对」只分析一次，再按「谁可能同服」归属到对应老人；无 Key / 失败时静默降级，只保留规则库结果。
 *
 * @param {number} familyId
 * @param {object} inventory loadElderMedInventory 的返回值
 * @param {Array} ruleConflicts 规则引擎已命中的冲突（这些药对 LLM 不再重复分析）
 * @returns {Promise<Array>} 额外发现的冲突（与规则结果互不重叠）
 */
async function scanUncoveredInteractions(familyId, inventory, ruleConflicts) {
  if (!llm.isEnabled()) return [];

  const cached = LLM_SCAN_CACHE.get(familyId);
  if (cached && Date.now() - cached.at < LLM_SCAN_TTL) return cached.conflicts;

  // 规则已命中的「药对」跳过（按药 ID 去重）
  const covered = new Set();
  for (const c of ruleConflicts) {
    if (Array.isArray(c.drugIds) && c.drugIds.length === 2) {
      covered.add(c.drugIds.slice().sort((a, b) => a - b).join('|'));
    }
  }

  // 收集「同一老人同时可能在服」的所有未覆盖两两组合，并记录该组合归属哪些老人
  const pairOwners = new Map(); // sortedKey -> { a, b, elderIds:Set }
  for (const [, elder] of inventory.byElder) {
    const meds = [...elder.meds.values()];
    if (meds.length < 2) continue;
    for (let i = 0; i < meds.length; i++) {
      for (let j = i + 1; j < meds.length; j++) {
        const a = meds[i];
        const b = meds[j];
        const key = [a.id, b.id].sort((x, y) => x - y).join('|');
        if (covered.has(key)) continue;
        if (!pairOwners.has(key)) pairOwners.set(key, { a, b, elderIds: new Set() });
        pairOwners.get(key).elderIds.add(elder.elderId);
      }
    }
  }

  const pairs = [...pairOwners.values()];
  if (!pairs.length) {
    LLM_SCAN_CACHE.set(familyId, { at: Date.now(), conflicts: [] });
    return [];
  }

  // 兜底上限：防止极端药库导致超长 prompt / 超时（超出部分仍由规则库覆盖）
  if (pairs.length > 150) pairs.length = 150;

  let found = [];
  try {
    const lines = pairs
      .map((p, idx) => {
        const d = (m) => m.name + (m.active_ingredient ? `（成分：${m.active_ingredient}）` : '');
        return `${idx + 1}. ${d(p.a)} 与 ${d(p.b)}`;
      })
      .join('\n');

    const raw = await llm.chat({
      system: LLM_SCAN_SYSTEM,
      user: `请判断下列两两药品组合中哪些存在有临床意义的用药相互作用，并只返回 JSON 数组。\n\n${lines}\n\n返回格式示例（不要任何多余文字）：\n[{"pairIndex":1,"severity":"critical","title":"简短结论","hint":"进一步说明与建议"}]`,
      temperature: 0.1,
      maxTokens: 1500,
    });

    found = extractJsonArray(raw);
  } catch (e) {
    console.warn('[assistant] LLM 全量用药研判失败，仅保留规则库结果：', e.code || e.message);
  }

  const conflicts = [];
  for (const item of found) {
    const idx = Number(item.pairIndex);
    if (!Number.isInteger(idx) || idx < 1 || idx > pairs.length) continue;
    const p = pairs[idx - 1];
    const severity = item.severity === 'critical' ? 'critical' : 'warn';
    const title = String(item.title || '发现潜在用药相互作用').slice(0, 80);
    const hint = String(item.hint || '建议核对药品说明书，或咨询医生/药师。').slice(0, 200);
    for (const eid of p.elderIds) {
      const elder = inventory.byElder.get(eid);
      conflicts.push({
        elderId: eid,
        elderName: elder ? elder.name : '',
        ruleId: 'llm_scan',
        severity,
        title,
        drugs: [p.a.name, p.b.name],
        drugIds: [p.a.id, p.b.id],
        hint,
        engine: 'llm_scan',
      });
    }
  }

  const result = conflicts.length ? conflicts : [];
  LLM_SCAN_CACHE.set(familyId, { at: Date.now(), conflicts: result });
  return result;
}

/**
 * 把用药冲突同步进「告警中心」（alert 表）。
 *
 * 为什么单独做一步落库：
 *   - buildInsights 是「读时计算」的，不落库的话冲突只在 AI 助手窗口里一闪而过；
 *   - 落进 alert 表后，子女端告警中心能看到、实时轮询能触发提醒、还能标记已处理；
 *   - 与 SOS/漏服/夜间开箱走同一套告警机制，UI 零额外适配（除了加一个类型文案）。
 *
 * 去重策略：同一老人 + 同一对药 + 同一规则，且「尚未处理/已读」的不重复插入；
 * 子女处理过（is_read=1）后，若冲突仍存在会再次告警（合理：说明问题没解决）。
 *
 * @param {object} conflict detectDrugConflicts 产出的单条冲突
 * @param {string} body 规则结论文本（告警正文用短、稳定的规则版，不用 LLM 长文本）
 */
async function syncDrugConflictAlerts(conflict, body) {
  const drugsKey = conflict.drugs.slice().sort().join('+');
  const content = `用药相互作用提醒：「${conflict.drugs.join('」与「')}」可能相互作用，请核对说明书并咨询医生或药师。`;

  // 已有未处理、或 12 小时内刚处理过的同类冲突告警则跳过（去重 + 静默期）
  if (await alertSnoozed(conflict.elderId, 'drug_conflict')) return null;

  // 通知对象：该家庭的 owner（同 SOS 逻辑）
  const elderRow = await queryOne('SELECT family_id FROM elder WHERE id = ?', [conflict.elderId]);
  const owner = await queryOne(
    'SELECT id FROM user WHERE family_id = ? ORDER BY FIELD(role,"owner","member","viewer") LIMIT 1',
    [elderRow.family_id]
  );

  const { insertId } = await exec(
    `INSERT INTO alert (elder_id, alert_type, level, content, channel, sent_to_user_id)
     VALUES (?,?,?,?,?,?)`,
    [
      conflict.elderId,
      'drug_conflict',
      conflict.severity === 'critical' ? 'urgent' : 'warning',
      content,
      'web',
      owner ? owner.id : null,
    ]
  );
  return insertId;
}

/**
 * 把主动建议命中的异常同步进「告警中心」（alert 表）。
 *
 * 设计说明（答辩可讲）：
 *   - buildInsights 是「读时计算」，不落库的话异常只在 AI 助手窗口一闪而过；
 *   - 落进 alert 表后，子女端告警中心能看到、实时轮询能触发提醒、还能标记已处理；
 *   - 与 SOS/漏服/夜间开箱/用药冲突走同一套告警机制，UI 零额外适配。
 *
 * 去重策略：同一老人 + 同一类型 + 且「尚未处理/已读」的不重复插入；
 * 子女处理过（is_read=1）后，若异常仍存在会再次告警（合理：说明问题没解决）。
 *
 * @param {number} elderId 老人 ID
 * @param {string} type alert_type（repeat_missed / stock_low / ...）
 * @param {'urgent'|'warning'|'info'} level 告警等级
 * @param {string} content 告警正文（短、稳定）
 */
/**
 * 同类告警是否处于「静默期」。
 *
 * 判定：该老人该类型只要满足下面任一条，就不再重复插入
 *   1) 还有一条没处理的（is_read = 0）；
 *   2) 最近 hours 小时内刚被处理过（handled_at 在窗口内）。
 *
 * 为什么要有第 2 条：告警是「读时计算」的，来源异常（药品过期、设备离线、
 * 两药冲突）天天写在数据库里。如果只按 is_read = 0 去重，用户点完
 * 「全部处理」下一轮分析就原样再塞一条，看起来像按钮没生效。
 * 加静默期后：处理过的当天不再打扰，隔天条件还在会重新提醒。
 */
async function alertSnoozed(elderId, type, hours = 12) {
  const row = await queryOne(
    `SELECT id FROM alert
      WHERE elder_id = ? AND alert_type = ?
        AND ( is_read = 0
              OR (handled_at IS NOT NULL AND handled_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)) )
      ORDER BY created_at DESC LIMIT 1`,
    [elderId, type, hours]
  );
  return !!row;
}

async function syncAlert(elderId, type, level, content) {
  if (await alertSnoozed(elderId, type)) return null;

  const elderRow = await queryOne('SELECT family_id FROM elder WHERE id = ?', [elderId]);
  const owner = await queryOne(
    'SELECT id FROM user WHERE family_id = ? ORDER BY FIELD(role,"owner","member","viewer") LIMIT 1',
    [elderRow.family_id]
  );

  const { insertId } = await exec(
    `INSERT INTO alert (elder_id, alert_type, level, content, channel, sent_to_user_id)
     VALUES (?,?,?,?,?,?)`,
    [elderId, type, level, content, 'web', owner ? owner.id : null]
  );
  return insertId;
}

/**
 * 生成一条结构化建议对象（对外统一契约，UI 依赖此结构）
 * @param {object} o { type, priority, title, body, elderId, evidence }
 */
/**
 * 「增强项」的时间预算。
 *
 * 为什么需要它：
 *   这套建议分两层 —— 规则引擎（本地计算，几十毫秒出结果）和 LLM 增强
 *   （二次研判 + 全量组合扫描，每次往返 4~10 秒，慢的时候更长）。
 *   增强项属于锦上添花，但只要它在，接口就得等它；手机端首页把 insights
 *   和总览数据放在同一个 Promise.all 里，于是一个慢请求把整屏拖成
 *   「正在连接…」的骨架屏，看起来像系统挂了。
 *   所以给增强单独设预算：超时就退回规则结论（evidence.reviewed 会是 'rule'，
 *   仍然可溯源），页面永远先拿到可用结果。
 */
const ENHANCE_BUDGET_MS = Number(process.env.ASSISTANT_LLM_BUDGET_MS || 2500);

/** 给 promise 套一个上限：到点就返回 fallback，不抛错、不阻塞调用方 */
function withBudget(promise, ms, fallback) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise.catch(() => fallback), timeout])
    .finally(() => clearTimeout(timer));
}

function insight(o) {
  return {
    type: o.type,
    priority: o.priority,
    title: o.title,
    body: o.body,
    elderId: o.elderId || null,
    evidence: o.evidence || [],          // 支撑这条建议的数据点（可追溯）
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 主动建议核心：汇总某家庭近 N 天服药数据，产出洞察
 * @param {number} familyId 家庭 ID（来自令牌，绝不信任前端传值）
 * @param {number} days 回看天数，默认 7
 * @returns {Promise<object>} { insights: [], summary: {...} }
 */
async function buildInsights(familyId, days = 7) {
  // 该家庭所有老人
  const elders = await query(
    `SELECT id, name FROM elder WHERE family_id = ? ORDER BY id`,
    [familyId]
  );
  const elderIds = elders.map((e) => e.id);

  if (!elderIds.length) {
    return { insights: [], summary: { elders: 0, notes: '该家庭还没有老人档案' } };
  }

  const placeholders = elderIds.map(() => '?').join(',');
  const insights = [];

  // ---------- 1. 近 N 天漏服统计 ----------
  // 漏服 = result='missed' 的事件；按老人聚合
  const missedRows = await query(
    `SELECT e.id, e.name AS elder_name, COUNT(*) AS cnt
       FROM intake_event ev
       JOIN elder e ON ev.elder_id = e.id
      WHERE ev.elder_id IN (${placeholders})
        AND ev.result = 'missed'
        AND ev.occurred_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY ev.elder_id, e.id, e.name`,
    [...elderIds, days]
  );

  for (const r of missedRows) {
    if (r.cnt > 0) {
      insights.push(
        insight({
          type: TYPE.MISSED,
          priority: r.cnt >= 3 ? PRIORITY.CRITICAL : PRIORITY.WARN,
          title: `${r.elder_name} 近 ${days} 天漏服 ${r.cnt} 次`,
          body:
            r.cnt >= 3
              ? '漏服较频繁，建议核对药箱指示灯与语音是否正常，必要时电话提醒老人。'
              : '存在少量漏服，建议关注是否与固定作息冲突。',
          elderId: r.id,
          evidence: [{ metric: 'missed_count', value: r.cnt, windowDays: days }],
        })
      );

      // 连续多日漏服（≥3次）→ 同步进告警中心（去重，失败不影响主流程）
      if (r.cnt >= 3) {
        try {
          await syncAlert(
            r.id,
            'repeat_missed',
            'warning',
            `${r.elder_name} 近 ${days} 天已漏服 ${r.cnt} 次，属连续漏服，请及时联系确认。`
          );
        } catch (err) {
          console.warn('[assistant] 连续漏服告警落库失败：', err.message);
        }
      }
    }
  }

  // ---------- 2. 重复服药风险 ----------
  const dupRows = await query(
    `SELECT e.id, e.name AS elder_name, COUNT(*) AS cnt
       FROM intake_event ev
       JOIN elder e ON ev.elder_id = e.id
      WHERE ev.elder_id IN (${placeholders})
        AND ev.result IN ('duplicate','abnormal')
        AND ev.occurred_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      GROUP BY ev.elder_id, e.id, e.name`,
    [...elderIds, days]
  );

  for (const r of dupRows) {
    insights.push(
      insight({
        type: TYPE.DUPLICATE,
        priority: PRIORITY.CRITICAL,
        title: `${r.elder_name} 出现 ${r.cnt} 次重复/异常服药`,
        body: '重复服药可能带来过量风险，建议确认是否误开其他隔间，或联系老人核实。',
        elderId: r.id,
        evidence: [{ metric: 'duplicate_count', value: r.cnt, windowDays: days }],
      })
    );
  }

  // ---------- 3. 低库存预警 ----------
  // 实际字段名：stock_qty（当前库存）、stock_alert_qty（预警阈值）
  const lowStockRows = await query(
    `SELECT m.id AS medicine_id, m.name AS medicine_name, m.stock_qty, m.stock_alert_qty,
            e.id AS elder_id, e.name AS elder_name
       FROM medicine m
       JOIN schedule_item si ON si.medicine_id = m.id
       JOIN schedule s ON s.id = si.schedule_id
       JOIN elder e ON e.id = s.elder_id
      WHERE e.family_id = ?
        AND m.stock_qty IS NOT NULL
        AND m.stock_alert_qty IS NOT NULL
        AND m.stock_qty <= m.stock_alert_qty
      GROUP BY m.id, m.name, m.stock_qty, m.stock_alert_qty, e.id, e.name`,
    [familyId]
  );

  for (const r of lowStockRows) {
    insights.push(
      insight({
        type: TYPE.STOCK_LOW,
        priority: PRIORITY.WARN,
        title: `「${r.medicine_name}」库存不足`,
        body: `当前剩余 ${r.stock_qty}，已低于阈值 ${r.stock_alert_qty}，建议及时补药。`,
        elderId: r.elder_id,
        evidence: [{ metric: 'stock_qty', value: r.stock_qty, threshold: r.stock_alert_qty }],
      })
    );

    // 库存不足 → 同步进告警中心（去重，失败不影响主流程）
    try {
      await syncAlert(
        r.elder_id,
        'stock_low',
        'warning',
        `「${r.medicine_name}」库存不足（剩余 ${r.stock_qty}，阈值 ${r.stock_alert_qty}），请及时补药。`
      );
    } catch (err) {
      console.warn('[assistant] 库存不足告警落库失败：', err.message);
    }
  }

  // ---------- 4. 依从性下滑趋势（近 14 天 vs 再往前 14 天）----------
  for (const elder of elders) {
    const recent = await query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN result='on_time' OR result='early' OR result='late' THEN 1 ELSE 0 END) AS taken
         FROM intake_event
        WHERE elder_id = ? AND result <> 'unknown'
          AND occurred_at >= DATE_SUB(NOW(), INTERVAL 14 DAY)`,
      [elder.id]
    );
    const prev = await query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN result='on_time' OR result='early' OR result='late' THEN 1 ELSE 0 END) AS taken
         FROM intake_event
        WHERE elder_id = ? AND result <> 'unknown'
          AND occurred_at >= DATE_SUB(NOW(), INTERVAL 28 DAY)
          AND occurred_at <  DATE_SUB(NOW(), INTERVAL 14 DAY)`,
      [elder.id]
    );

    const curRate = recent[0].total ? recent[0].taken / recent[0].total : null;
    const prevRate = prev[0].total ? prev[0].taken / prev[0].total : null;

    if (curRate !== null && prevRate !== null && curRate < prevRate - 0.15) {
      insights.push(
        insight({
          type: TYPE.ADHERENCE_DROP,
          priority: PRIORITY.WARN,
          title: `${elder.name} 的按时服药率出现下滑`,
          body: `近 14 天按时率 ${(curRate * 100).toFixed(0)}%，较此前（${(prevRate * 100).toFixed(0)}%）下降明显，建议关注原因。`,
          elderId: elder.id,
          evidence: [
            { metric: 'adherence_recent', value: curRate },
            { metric: 'adherence_prev', value: prevRate },
          ],
        })
      );
    }
  }

  // ---------- 5. 用药相互作用（规则引擎全库检测 + LLM 二次研判 + LLM 全量兜底） ----------
  const inventory = await loadElderMedInventory(familyId);
  const ruleConflicts = await detectDrugConflicts(familyId, inventory);

  // 两个增强步骤共享一个总预算（deadline），而不是各给一份。
  // 各给一份会叠加：扫描 2.5s + 研判 2.5s = 5s，等于预算翻倍。
  const deadline = Date.now() + ENHANCE_BUDGET_MS;
  const remain = () => Math.max(0, deadline - Date.now());

  // 全量扫描要调一次大模型（结果有 10 分钟缓存），最多用掉预算的前 40%，
  // 把大头留给「规则冲突的二次研判」—— 后者直接关系每条建议的措辞质量。
  const extraConflicts = await withBudget(
    scanUncoveredInteractions(familyId, inventory, ruleConflicts),
    Math.min(Math.round(ENHANCE_BUDGET_MS * 0.4), remain()),
    []
  );
  const conflicts = [...ruleConflicts, ...extraConflicts];

  // 二次研判改为「并行 + 总预算」。
  // 原来是 for 循环里一条一条 await，3 条冲突就是 3 次串行往返，
  // 耗时随冲突数线性增长 —— 这正是首页越用越慢的原因。
  const needReview = conflicts.filter((c) => c.engine !== 'llm_scan');
  const reviewedOpinions = new Map();
  if (needReview.length) {
    const results = await withBudget(
      Promise.all(needReview.map((c) => reviewConflictWithLLM(c).catch(() => null))),
      Math.max(300, remain()),   // 剩下的预算全给研判，最低留 300ms 起跑
      needReview.map(() => null)
    );
    needReview.forEach((c, i) => reviewedOpinions.set(c, results[i]));
  }

  for (const c of conflicts) {
    const priority = c.severity === 'critical' ? PRIORITY.CRITICAL : PRIORITY.WARN;

    // 规则结论（保底，可溯源、离线可用）
    const ruleBody = `发现「${c.drugs.join('」与「')}」可能相互作用。${c.hint}`;

    let body = ruleBody;
    let reviewed = false;
    if (c.engine === 'llm_scan') {
      // LLM 全量研判的结果本身已是大模型结论，无需再二次研判
      body = c.hint;
      reviewed = true;
    } else {
      // 大模型二次研判的结果在循环外并行取好了，这里只取不 await。
      // 没取到（无 Key / 超预算 / 断网）就保留规则结论，保证演示不翻车。
      const rev = reviewedOpinions.get(c);
      if (rev && rev.verdict) {
        body = rev.verdict;
        reviewed = true;
      }
    }

    insights.push(
      insight({
        type: TYPE.DRUG_INTERACTION,
        priority,
        title: `${c.elderName}：${c.title}`,
        body,
        elderId: c.elderId,
        evidence: [
          {
            metric: 'interaction',
            drugs: c.drugs,
            ruleId: c.ruleId,
            severity: c.severity,
            reviewed: reviewed ? 'llm' : 'rule',
          },
        ],
      })
    );

    // 同步进告警中心（去重，失败不影响主流程）
    try {
      await syncDrugConflictAlerts(c, ruleBody);
    } catch (err) {
      console.warn('[assistant] 冲突告警落库失败：', err.message);
    }
  }

  // ---------- 6. 效期预警（30 天内到期 / 已过期） ----------
  // 与低库存同思路：按「在服计划」关联到老人，这样告警能落到具体某位老人。
  const expiringRows = await query(
    `SELECT m.id AS medicine_id, m.name AS medicine_name, m.expiry_date, m.stock_qty,
            e.id AS elder_id, e.name AS elder_name
       FROM medicine m
       JOIN schedule_item si ON si.medicine_id = m.id
       JOIN schedule s ON s.id = si.schedule_id
       JOIN elder e ON e.id = s.elder_id
      WHERE e.family_id = ?
        AND m.status = 'active'
        AND m.expiry_date IS NOT NULL
        AND m.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)
      GROUP BY m.id, m.name, m.expiry_date, m.stock_qty, e.id, e.name
      ORDER BY m.expiry_date`,
    [familyId]
  );

  for (const r of expiringRows) {
    // 已过期为负天数、未到期为正天数
    const diff = Math.floor((new Date(r.expiry_date) - new Date()) / 86400000);
    const expired = diff < 0;
    insights.push(
      insight({
        type: TYPE.EXPIRING,
        priority: expired ? PRIORITY.CRITICAL : PRIORITY.WARN,
        title: `「${r.medicine_name}」${expired ? '已过期' : '即将到期'}`,
        body: expired
          ? `已过期 ${-diff} 天，请勿再服用，并提醒 ${r.elder_name} 及时清理。`
          : `距效期还有 ${diff} 天，服用前请留意，必要时提前更换。`,
        elderId: r.elder_id,
        evidence: [{ metric: 'expiry_days', value: diff, threshold: 30 }],
      })
    );

    // 同步进告警中心（去重，失败不影响主流程）
    try {
      await syncAlert(
        r.elder_id,
        'expiry',
        expired ? 'urgent' : 'warning',
        `「${r.medicine_name}」${expired ? `已过期 ${-diff} 天` : `${diff} 天后到期`}，请注意处理。`
      );
    } catch (err) {
      console.warn('[assistant] 效期告警落库失败：', err.message);
    }
  }

  // ---------- 汇总 ----------
  const summary = {
    elders: elders.length,
    missedTotal: missedRows.reduce((s, r) => s + r.cnt, 0),
    duplicateTotal: dupRows.reduce((s, r) => s + r.cnt, 0),
    lowStockCount: lowStockRows.length,
    drugConflictCount: conflicts.length,
    expiringCount: expiringRows.length,
    windowDays: days,
  };

  // 无异常时给一条正面反馈，让界面不空
  if (!insights.length) {
    insights.push(
      insight({
        type: TYPE.REMINDER,
        priority: PRIORITY.INFO,
        title: '近期服药情况良好',
        body: '未发现漏服、重复或库存异常，继续保持。',
        evidence: [{ metric: 'window_days', value: days }],
      })
    );
  }

  // 按优先级排序：critical > warn > info
  const rank = { critical: 0, warn: 1, info: 2 };
  insights.sort((a, b) => rank[a.priority] - rank[b.priority]);

  return { insights, summary };
}

/**
 * 用药助手系统提示词（角色设定 + 安全边界）。
 * 只用于「问答」通道；主动建议(buildInsights)仍由规则引擎产出结构化结果，
 * 保证每条建议有数据依据、可复现、不依赖大模型稳定性。
 */
const LLM_SYSTEM_PROMPT = `你是「智能药箱」家庭用药协同系统里的 AI 用药助手。
你的服务对象是照护家中老人的子女（非患者本人），提供的是用药安全辅助参考，不是诊断。

必须遵守：
1. 语气亲切、简洁、说人话，用中文回答，控制在 200 字以内。
2. 涉及「能否同服」「剂量」「禁忌」时，先提醒核对药品说明书，涉及处方药务必建议咨询医生或药师。
3. 明确声明你不做诊断、不开处方。
4. 只围绕用药与照护相关问题回答；被问到无关话题时礼貌地把话题拉回用药照护。
5. 用户消息里带有「服药概况」，其中已包含今日完成次数、近 7 天漏服/重复、告警与库存。
   被问到「今天吃了没」「最近按时吗」这类问题时，直接引用概况里的数字回答，
   不要声称自己看不到记录；概况里没写到的细节才说「系统里没有这项数据」。
6. 不编造药品说明书内容、不臆造剂量数字；不确定时如实说「建议咨询药师」。`;

/**
 * 问答：优先调用真实大模型，失败或无 Key 时自动降级到规则引擎。
 *
 * 这样设计的原因（答辩可讲）：
 *   - 有 API Key 时，得到的是真正理解语义、能自由对话的回答；
 *   - 竞赛现场可能断网 / 没 Key / 额度用完，自动降级保证功能永远可用、演示不翻车；
 *   - 两种模式返回结构完全一致（answer + sources），UI 零感知。
 *
 * @param {number} familyId 家庭 ID（来自令牌）
 * @param {string} question 子女的提问
 */
// ---------- 问答缓存与去重 ----------
// 同一家庭 + 同一问题在短时间内的重复请求直接复用（省 token、降延迟）；
// 并发中的相同问题合并为同一个请求（inflight 去重），避免打字/双击造成重复调用。
const ANSWER_CACHE = new Map();   // key -> { answer, sources, engine, at }
const INFLIGHT = new Map();       // key -> Promise
const CACHE_TTL = 5 * 60 * 1000;  // 5 分钟
const CACHE_MAX = 200;

function normKey(familyId, q) {
  return familyId + '::' + String(q).replace(/\s+/g, '').toLowerCase();
}

async function generateAnswer(familyId, question) {
  const q = String(question || '').trim();
  if (!q) {
    return { answer: '请描述你的问题，例如「这两个药能一起吃吗」。', sources: [], engine: 'rule' };
  }

  const key = normKey(familyId, q);
  const cached = ANSWER_CACHE.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL) {
    return { answer: cached.answer, sources: cached.sources, engine: cached.engine, cached: true };
  }
  if (INFLIGHT.has(key)) return INFLIGHT.get(key);

  const p = generateAnswerUncached(familyId, q);
  INFLIGHT.set(key, p);
  p.then((r) => {
    ANSWER_CACHE.set(key, { answer: r.answer, sources: r.sources, engine: r.engine, at: Date.now() });
    if (ANSWER_CACHE.size > CACHE_MAX) ANSWER_CACHE.delete(ANSWER_CACHE.keys().next().value);
  }).catch(() => {}).finally(() => INFLIGHT.delete(key));
  return p;
}

async function generateAnswerUncached(familyId, q) {
  // ---- 先尝试真实大模型 ----
  try {
    const context = await buildContext(familyId); // 家庭服药概况，喂给模型当背景
    const text = await llm.chat({
      system: LLM_SYSTEM_PROMPT,
      user: `以下是你当前照护对象的服药概况，供你回答时参考：\n${context}\n\n子女的问题是：${q}`,
      temperature: 0.3,
      maxTokens: 500,
    });

    // 溯源：大模型回答 + 关联当前家庭最相关的一条结构化洞察
    const sources = [{ type: 'llm', label: process.env.LLM_MODEL || 'qwen-plus' }];
    const { insights } = await buildInsights(familyId, 7);
    const top = insights[0];
    if (top && top.priority !== 'info') {
      sources.push({ type: 'insight', label: top.title });
    }
    return { answer: text, sources, engine: 'llm' };
  } catch (e) {
    // 任何失败（无 Key / 超时 / 网络 / 额度耗尽）都静默降级，不打扰用户
    console.warn('[assistant] 大模型调用失败，回退规则引擎：', e.code || e.message);
    return ruleAnswer(familyId, q);
  }
}

/**
 * 流式问答：与 generateAnswer 同一条路线，但答案是「边生成边产出」的增量。
 * 用于 SSE 流式输出；大模型不可用/失败时回退规则引擎，一次性产出整段文本。
 */
async function* streamAnswer(familyId, question) {
  const q = String(question || '').trim();
  if (!q) { yield '请描述你的问题，例如「这两个药能一起吃吗」。'; return; }

  if (llm.isEnabled()) {
    try {
      const context = await buildContext(familyId);
      const gen = llm.streamChat({
        system: LLM_SYSTEM_PROMPT,
        user: `以下是你当前照护对象的服药概况，供你回答时参考：\n${context}\n\n子女的问题是：${q}`,
        temperature: 0.3,
        maxTokens: 500,
      });
      for await (const delta of gen) yield delta;
      return;
    } catch (e) {
      console.warn('[assistant] 流式调用失败，回退规则引擎：', e.code || e.message);
    }
  }
  const r = await ruleAnswer(familyId, q);
  yield r.answer;
}

/**
 * 汇聚家庭服药概况，作为大模型的背景上下文。
 *
 * 为什么不能只给「老人档案 + 在服药品」：
 *   家属最常问的就是「今天吃药了吗」「最近按时吗」。原来的上下文里没有一条
 *   服药流水，模型看不到数据，只能回答「我没有实时用药记录功能」——
 *   而系统里明明有。回答自相矛盾，等于把 AI 助手最该答的两类问题推空。
 *   所以这里把「今日完成情况、近 7 天依从、未处理告警、库存与效期」一并带上，
 *   让模型能直接引用具体数字作答。
 */
async function buildContext(familyId) {
  const elders = await query(
    `SELECT id, name, age, chronic_diseases, allergies FROM elder WHERE family_id = ? ORDER BY id`,
    [familyId]
  );
  if (!elders.length) return '（暂无老人档案）';

  // 每位老人的今日进度 + 近 7 天漏服次数（一条 SQL 取完，避免 N+1）
  const progress = await query(
    `SELECT e.id, e.name,
            (SELECT COUNT(*) FROM schedule s
              WHERE s.elder_id = e.id AND s.status = 'active') AS plan_total,
            (SELECT COUNT(DISTINCT ie.schedule_id) FROM intake_event ie
              WHERE ie.elder_id = e.id AND DATE(ie.occurred_at) = CURDATE()
                AND ie.schedule_id IS NOT NULL
                AND ie.result IN ('on_time','early','late')) AS done_today,
            (SELECT COUNT(*) FROM intake_event ie
              WHERE ie.elder_id = e.id AND ie.result = 'missed'
                AND ie.occurred_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS missed_7d,
            (SELECT COUNT(*) FROM intake_event ie
              WHERE ie.elder_id = e.id AND ie.result = 'duplicate'
                AND ie.occurred_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) AS dup_7d
       FROM elder e WHERE e.family_id = ? ORDER BY e.id`,
    [familyId]
  );
  const pMap = new Map(progress.map((r) => [Number(r.id), r]));

  const lines = elders.map((e) => {
    const parts = [`${e.name}${e.age ? '（' + e.age + '岁）' : ''}`];
    if (e.chronic_diseases) parts.push(`慢病：${e.chronic_diseases}`);
    if (e.allergies) parts.push(`过敏史：${e.allergies}`);
    const p = pMap.get(Number(e.id));
    if (p) {
      parts.push(`今日计划 ${Number(p.plan_total) || 0} 次，已完成 ${Number(p.done_today) || 0} 次`);
      parts.push(`近 7 天漏服 ${Number(p.missed_7d) || 0} 次、重复取药 ${Number(p.dup_7d) || 0} 次`);
    }
    return '· ' + parts.join('，');
  });

  // 当前在服药品清单
  const meds = await query(
    `SELECT DISTINCT m.name
       FROM medicine m
       JOIN schedule_item si ON si.medicine_id = m.id
       JOIN schedule s ON s.id = si.schedule_id
       JOIN elder e ON e.id = s.elder_id
      WHERE e.family_id = ?
      ORDER BY m.name`,
    [familyId]
  );
  if (meds.length) {
    lines.push(`当前在服药品：${meds.map((m) => m.name).join('、')}`);
  }

  // 未处理告警（只给数量与类型，够模型判断「有没有需要关注的事」）
  const alertRow = await queryOne(
    `SELECT COUNT(*) AS cnt FROM alert a
       JOIN elder e ON e.id = a.elder_id
      WHERE e.family_id = ? AND a.is_read = 0`,
    [familyId]
  );
  const kinds = await query(
    `SELECT a.alert_type, COUNT(*) AS cnt FROM alert a
       JOIN elder e ON e.id = a.elder_id
      WHERE e.family_id = ? AND a.is_read = 0
      GROUP BY a.alert_type ORDER BY cnt DESC LIMIT 5`,
    [familyId]
  );
  if (Number(alertRow.cnt)) {
    const k = kinds.map((r) => `${r.alert_type} ${r.cnt} 条`).join('、');
    lines.push(`未处理告警：共 ${alertRow.cnt} 条（${k}）`);
  } else {
    lines.push('未处理告警：无');
  }

  // 库存与效期（只报需要关注的，避免上下文过长）
  const stockRows = await query(
    `SELECT name, stock_qty, stock_alert_qty,
            CASE WHEN expiry_date IS NOT NULL AND expiry_date < CURDATE() THEN '已过期'
                 WHEN expiry_date IS NOT NULL AND expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) THEN '30 天内到期'
                 ELSE NULL END AS expiry_state
       FROM medicine
      WHERE family_id = ? AND status = 'active'
        AND (stock_qty <= stock_alert_qty
             OR (expiry_date IS NOT NULL AND expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY)))
      ORDER BY name LIMIT 10`,
    [familyId]
  );
  if (stockRows.length) {
    lines.push('需要关注药品：' + stockRows.map((r) =>
      `${r.name}（库存 ${r.stock_qty}${r.expiry_state ? '，' + r.expiry_state : ''}）`).join('、'));
  }

  return lines.join('\n');
}

/** 规则引擎问答（降级兜底，保留原有实现） */
function ruleAnswer(familyId, q) {
  const answer = [];
  const sources = [];

  if (/一起吃|同服|冲突|相互作用|禁忌/.test(q)) {
    answer.push(
      '关于药物能否同服，建议：先核对药品说明书的「药物相互作用」章节；不同药品间隔 30 分钟以上服用可降低风险；若涉及处方药，请务必咨询医生或药师，本助手不做诊断。'
    );
    sources.push({ type: 'rule', label: '通用用药安全规范' });
  } else if (/漏服|忘记|没吃|补服/.test(q)) {
    answer.push(
      '漏服后的通用处理：若距下次服药时间较远，可按说明补服；若已接近下次时间，则跳过本次、避免双倍剂量。具体请以药品说明书为准。'
    );
    sources.push({ type: 'rule', label: '漏服处理通用原则' });
  } else if (/血压|血糖|体温|指标/.test(q)) {
    answer.push(
      '生理指标仅作参考，不能替代专业测量与诊断。建议结合连续记录观察趋势，异常请及时就医。'
    );
    sources.push({ type: 'rule', label: '健康数据科普提示' });
  } else {
    answer.push(
      '这个问题我暂时无法给出可靠回答。可尝试更具体地描述药品名称或症状，或咨询药师。'
    );
  }

  // 附上该家庭最近一条相关洞察作为上下文
  return buildInsights(familyId, 7).then(({ insights }) => {
    const top = insights[0];
    if (top && top.priority !== 'info') {
      answer.push(`另外，我注意到近期有一条相关提醒：${top.title}。`);
      sources.push({ type: 'insight', label: top.title });
    }
    return { answer: answer.join(''), sources, engine: 'rule' };
  });
}

module.exports = {
  PRIORITY,
  TYPE,
  DRUG_INTERACTIONS,
  detectDrugConflicts,
  reviewConflictWithLLM,
  syncDrugConflictAlerts,
  syncAlert,
  alertSnoozed,
  buildInsights,
  generateAnswer,
  streamAnswer,
};
