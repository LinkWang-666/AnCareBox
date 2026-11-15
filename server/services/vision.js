/**
 * 拍照识药服务 —— 把药品包装/说明书的照片交给视觉大模型，提取结构化入库信息。
 *
 * 设计定位（答辩可讲）：
 *   - 子女拿到老人的药，不用手敲药名/规格/成分/禁忌，拍一张照片 AI 自动填；
 *   - 产出的是「结构化字段」（name/spec/active_ingredient/category/…），
 *     直接回填到「添加药品」表单，再交给子女确认入库；
 *   - 降级策略：没配视觉模型/识别失败时返回 ok:false + 提示，前端引导手工填写，
 *     演示永不翻车。
 *
 * 安全边界：识别结果只是「辅助录入」，不做诊断、不取代药师审核。
 */
const llm = require('./llm');

const PROMPT = `你是药品信息识别助手。照片通常是药品外包装盒（药盒），盒面印有商品条形码或药品电子监管码。请优先、准确地识别药名，并按需读取盒上的条形码号码。提取以下字段，严格只输出一个 JSON 对象（不要输出任何解释、不要用 markdown 代码块）：

{
  "name": "药品通用名或商品名",
  "barcode": "药盒上的条形码/监管码号码（即条码下方的一串数字，读取不到则为空字符串）",
  "spec": "规格，如 5mg×28片",
  "manufacturer": "生产厂家",
  "active_ingredient": "主要有效成分（多个用中文逗号分隔）",
  "category": "功能分类，只能从以下选一个：降压/降糖/调脂/心血管/抗菌/解热镇痛/营养补充/其他",
  "dosage": "用法用量（如无法识别则为空字符串）",
  "contraindication": "禁忌或注意事项（如无法识别则为空字符串）",
  "appearance": "外观描述，如片剂颜色形状（如无法识别则为空字符串）",
  "expiry_date": "有效期至，格式 YYYY-MM-DD（无法识别则为空字符串）",
  "batch_no": "批号（无法识别则为空字符串）"
}

要求：无法识别的字段填空字符串，不要编造；药名（name）是入库必备字段，请务必尽量识别准确；涉及处方药只做信息整理，不做用药建议。`;

/** 把模型返回的文本解析成对象（容忍 markdown 代码块包裹） */
function parseJSON(text) {
  const s = String(text || '').trim();
  // 去掉可能的 ```json ... ``` 包裹
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = m ? m[1] : s;
  try {
    return JSON.parse(body);
  } catch {
    // 再尝试截取第一个 { 到最后一个 }
    const a = body.indexOf('{');
    const b = body.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(body.slice(a, b + 1)); } catch { /* 继续降级 */ }
    }
    return null;
  }
}

/**
 * 识别一张药品图片，返回可回填表单的结构化数据。
 * @param {string} imageDataUrl 图片 dataURL（前端 FileReader 产出）
 * @returns {Promise<{ok:boolean, medicine:object|null, engine:'llm'|'none', note:string}>}
 */
async function recognizeMedicine(imageDataUrl) {
  if (!llm.isEnabled()) {
    return {
      ok: false,
      medicine: null,
      engine: 'none',
      note: '未配置大模型 API Key，无法拍照识药，请手工填写药品信息。',
    };
  }

  try {
    const raw = await llm.vision({ imageDataUrl, prompt: PROMPT, maxTokens: 800, temperature: 0.1 });
    const data = parseJSON(raw);
    if (!data || typeof data !== 'object') {
      return {
        ok: false,
        medicine: null,
        engine: 'llm',
        note: '没能从图片中稳定识别出药品信息，请拍得更清晰（对准药盒正面/说明书），或手工填写。',
        raw: raw.slice(0, 200),
      };
    }
    return { ok: true, medicine: data, engine: 'llm', note: '以下信息由 AI 识别，请核对后再入库。' };
  } catch (e) {
    return {
      ok: false,
      medicine: null,
      engine: 'none',
      note: '识别失败：' + (e.code === 'LLM_NOT_CONFIGURED' ? '未配置大模型' : (e.message || '网络异常')),
    };
  }
}

module.exports = { recognizeMedicine };