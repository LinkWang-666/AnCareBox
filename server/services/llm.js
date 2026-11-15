/**
 * 可插拔大模型客户端（OpenAI 兼容协议）
 *
 * 设计目标：把「接哪家大模型」这件事彻底抽离成配置，业务代码不关心。
 * 通义千问 Qwen、DeepSeek、Moonshot Kimi、OpenAI GPT 等凡是走
 * `POST /v1/chat/completions` 协议的服务，都能直接换 baseURL + model 使用，
 * 无需改一行业务代码。
 *
 * 为什么用 Node 原生 fetch 而不是装 SDK：
 *   - Node 18+ 自带全局 fetch，零新增依赖；
 *   - OpenAI 兼容协议本质就是一次 HTTPS POST + JSON，SDK 反而引入体积与版本耦合；
 *   - 便于控制超时、错误，以及「没有 Key 时优雅降级」。
 *
 * 环境变量（.env）：
 *   LLM_API_KEY   大模型 API Key（必填才会真正调用）
 *   LLM_BASE_URL  兼容接口地址，默认 https://dashscope.aliyuncs.com/compatible-mode/v1
 *   LLM_MODEL     模型名，默认 qwen-plus
 *   LLM_TIMEOUT   超时毫秒，默认 15000
 */

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen-plus';

/**
 * 判断是否已配置大模型
 * 没有 Key 时业务层应自动回退到规则引擎，保证演示不翻车。
 */
function isEnabled() {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_API_KEY.trim());
}

/**
 * 底层对话补全：支持完整 messages 数组 + Function Calling 的 tools 参数。
 * 业务层通常不用这个，直接用上面的 chat()；只有 Agent 需要工具调用时才用。
 * @param {object} opts
 *   opts.messages   完整消息数组 [{role, content}]
 *   opts.tools      可选，OpenAI 兼容的 tools 定义（Function Calling）
 *   opts.maxTokens / opts.temperature
 * @returns {Promise<object>} choices[0].message（含 content 与可选的 tool_calls）
 * @throws {Error} 同上
 */
async function complete({ messages, tools = null, maxTokens = 600, temperature = 0.3, model: modelOpt = null } = {}) {
  if (!isEnabled()) {
    const e = new Error('LLM 未配置（缺少 LLM_API_KEY）');
    e.code = 'LLM_NOT_CONFIGURED';
    throw e;
  }

  const base = (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = modelOpt || process.env.LLM_MODEL || DEFAULT_MODEL;
  const timeout = Number(process.env.LLM_TIMEOUT || 15000);

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (tools && tools.length) body.tools = tools;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const e = new Error(`大模型返回 ${res.status}：${text.slice(0, 200)}`);
      e.code = 'LLM_HTTP_ERROR';
      throw e;
    }

    const data = await res.json();
    const message = data?.choices?.[0]?.message;
    if (!message) {
      const e = new Error('大模型响应中缺少 choices[0].message');
      e.code = 'LLM_EMPTY_RESPONSE';
      throw e;
    }
    return message; // { role, content?, tool_calls? }
  } catch (err) {
    if (err.code) throw err; // 已经是我们封装过的错误
    const e = new Error('大模型调用失败：' + (err.name === 'AbortError' ? '请求超时' : err.message));
    e.code = 'LLM_NETWORK_ERROR';
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调用大模型对话补全
 * @param {object} opts
 *   opts.system  系统提示词（角色设定 + 安全边界）
 *   opts.user    用户输入（本次要问的话）
 *   opts.maxTokens  最大返回 token，默认 600
 *   opts.temperature 采样温度，默认 0.3（偏严谨、少跑火车）
 * @returns {Promise<string>} 模型返回的文本
 * @throws {Error} 无 Key / 网络失败 / 非 200 时抛出，由调用方决定降级
 */
async function chat({ system, user, maxTokens = 600, temperature = 0.3 } = {}) {
  const message = await complete({
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    maxTokens,
    temperature,
  });
  return String(message.content || '').trim();
}

/**
 * 多模态视觉理解：识别图片并返回文字结果。
 * 用于「拍照识药」——把药品包装/说明书照片交给视觉大模型提取结构化信息。
 * 默认走 qwen3-vl-plus（通义千问视觉版），可在 .env 用 LLM_VISION_MODEL 覆盖。
 * @param {object} opts { imageDataUrl, prompt, maxTokens, temperature, model }
 * @returns {Promise<string>} 模型返回的文本
 */
async function vision({ imageDataUrl, prompt, maxTokens = 800, temperature = 0.2, model = null } = {}) {
  const m = model || process.env.LLM_VISION_MODEL || 'qwen3-vl-plus';
  const message = await complete({
    model: m,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageDataUrl } },
        ],
      },
    ],
    maxTokens,
    temperature,
  });
  return String(message.content || '').trim();
}

/**
 * 流式对话补全：返回一个 async 生成器，逐段产出文本增量。
 * 用于前端 SSE 流式输出，让回答「边生成边显示」，明显改善等待体验。
 * 底层仍是 OpenAI 兼容协议（stream:true + SSE 解析），零新增依赖。
 * @param {object} opts { system, user, maxTokens, temperature, model }
 * @returns {AsyncGenerator<string>}
 */
async function* streamChat({ system, user, maxTokens = 600, temperature = 0.3, model = null } = {}) {
  if (!isEnabled()) {
    const e = new Error('LLM 未配置（缺少 LLM_API_KEY）');
    e.code = 'LLM_NOT_CONFIGURED';
    throw e;
  }

  const base = (process.env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const m = model || process.env.LLM_MODEL || DEFAULT_MODEL;
  const timeout = Number(process.env.LLM_TIMEOUT || 15000);

  const body = {
    model: m,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    temperature,
    max_tokens: maxTokens,
    stream: true,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const e = new Error('大模型流式调用失败：' + (err.name === 'AbortError' ? '请求超时' : err.message));
    e.code = 'LLM_NETWORK_ERROR';
    throw e;
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    const e = new Error(`大模型返回 ${res.status}：${text.slice(0, 200)}`);
    e.code = 'LLM_HTTP_ERROR';
    throw e;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload);
          const delta = json && json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
          if (delta) yield delta;
        } catch { /* 忽略非 JSON 行 */ }
      }
    }
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* noop */ }
  }
}

module.exports = { chat, complete, vision, streamChat, isEnabled };
