# AI 用药助手 · 接口契约（后端 ↔ UI 联调依据）

> 本文档是**后端与前端（队友 UI）之间的对接契约**。
> 后端已实现，接口已实测通过；队友按此契约实现界面即可，无需了解后端内部逻辑。
>
> 分工约定：**后端 + 数据库 = 王霖城**；**UI = 队友**。本文档是两边的"合同"。

---

## 一、总体定位

「AI 用药助手」是一个**主动式 Agent**，不是传统问答机器人：

- **主动建议**：Agent 自己读取家庭内老人的服药数据，发现异常后主动推送建议，不等子女提问。
- **主动问答**：子女仍可在「助手窗口」里主动提问。

两个能力由**两个独立接口**提供，共用一个数据底座。

---

## 二、接口清单

| 方法 | 路径 | 用途 | 调用方 |
|---|---|---|---|
| `GET` | `/api/assistant/insights` | 拉取主动建议列表 | 子女端（登录后） |
| `POST` | `/api/assistant/ask` | 提交问题、获取回答 | 子女端（登录后） |

- **鉴权**：两个接口都要求 `Authorization: Bearer <accessToken>`（子女身份，`type=user`）。
- **老人端（device 令牌）不可调用**，会返回 403。
- **家庭隔离**：服务端从令牌取 `family_id`，前端传的会被忽略（防横向越权）。

---

## 三、接口 1：主动建议

### 请求

```
GET /api/assistant/insights?days=7
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `days` | number | 否 | 回看天数，默认 7，范围 1~30 |

### 响应（200）

```json
{
  "ok": true,
  "summary": {
    "elders": 1,
    "missedTotal": 0,
    "duplicateTotal": 0,
    "lowStockCount": 1,
    "windowDays": 7
  },
  "insights": [
    {
      "type": "stock_low",
      "priority": "warn",
      "title": "「格列美脲片」库存不足",
      "body": "当前剩余 10，已低于阈值 10，建议及时补药。",
      "elderId": 1,
      "evidence": [
        { "metric": "stock_qty", "value": 10, "threshold": 10 }
      ],
      "generatedAt": "2026-10-21T11:00:00.000Z"
    }
  ]
}
```

### 字段说明（UI 渲染用）

| 字段 | 类型 | 说明 | UI 建议 |
|---|---|---|---|
| `insights[]` | array | 建议列表，已按优先级排序 | 逐条渲染卡片 |
| `insights[].type` | string | 建议类型（见下表） | 决定图标 |
| `insights[].priority` | string | `critical` / `warn` / `info` | 决定颜色/置顶 |
| `insights[].title` | string | 一句话标题 | 卡片主标题 |
| `insights[].body` | string | 详细说明 | 卡片正文 |
| `insights[].elderId` | number|null | 关联的老人 id | 点击跳转老人档案 |
| `insights[].evidence` | array | 支撑数据点 | 可折叠展示"依据" |
| `insights[].generatedAt` | string | 生成时间（ISO） | 显示"多久前" |
| `summary` | object | 汇总统计 | 顶部概览条 |

### 类型枚举（`type`）

| type | 含义 | 建议图标 |
|---|---|---|
| `missed` | 漏服 | ⚠️ |
| `adherence_drop` | 依从性下滑 | 📉 |
| `duplicate` | 重复/异常服药 | 🔴 |
| `stock_low` | 库存不足 | 📦 |
| `time_irregular` | 时段异常（预留） | 🕐 |
| `reminder` | 通用提醒（无异常时的正面反馈） | ✅ |

### 优先级枚举（`priority`）

| priority | 含义 | 颜色建议 |
|---|---|---|
| `critical` | 紧急 | 红 |
| `warn` | 警告 | 橙 |
| `info` | 提示 | 灰/蓝 |

---

## 四、接口 2：主动问答

### 请求

```
POST /api/assistant/ask
Content-Type: application/json

{ "question": "阿司匹林和布洛芬能一起吃吗" }
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `question` | string | 是 | 子女输入的问题 |

### 响应（200）

```json
{
  "ok": true,
  "answer": "关于药物能否同服，建议：先核对药品说明书的「药物相互作用」章节；不同药品间隔 30 分钟以上服用可降低风险；若涉及处方药，请务必咨询医生或药师，本助手不做诊断。另外，我注意到近期有一条相关提醒：「格列美脲片」库存不足。",
  "engine": "rule",
  "sources": [
    { "type": "rule", "label": "通用用药安全规范" },
    { "type": "insight", "label": "「格列美脲片」库存不足" }
  ]
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `answer` | string | 回答正文（纯文本，UI 自行换行排版） |
| `engine` | string | 回答由哪个引擎生成：`llm`（真实大模型）/ `rule`（规则引擎降级）。UI 可据此显示「AI 生成」徽标，不显示也不影响 |
| `sources` | array | 回答的来源出处（溯源设计，必展示） |
| `sources[].type` | string | `rule`（规则库）/ `insight`（关联建议）/ `llm`（大模型） |
| `sources[].label` | string | 来源名称，展示给用户 |

> 注意：回答末尾会**自动附带近期最相关的一条建议**作为上下文（体现「主动接管」与「按需问答」的双向结合），UI 无需特殊处理。

---

## 五、错误响应（统一格式）

| HTTP 状态 | 响应体 | 含义 |
|---|---|---|
| `401` | `{"error":"未登录或令牌失效"}` | 需重新登录 |
| `403` | `{"error":"该接口仅面向子女端","code":"FORBIDDEN"}` | 老人端令牌调用 |
| `400` | `{"error":"请提供 question 字段"}` | 缺 `question` |

所有错误统一返回 `{ "error": string, "code"?: string }`，UI 读 `error` 字段展示即可。

---

## 六、当前实现状态（后端）

- ✅ `GET /api/assistant/insights` — 规则引擎已实现，覆盖：漏服、重复服药、低库存、依从性下滑、无异常正面反馈
- ✅ `POST /api/assistant/ask` — 规则关键词匹配已实现，附来源
- ✅ 大模型已接入：`generateAnswer()` 在配置 `LLM_API_KEY` 后调用模型；未配置或调用失败时回退规则引擎，接口契约不变

### 后端文件位置

```
server/
  services/assistant.js   # 规则引擎（buildInsights + generateAnswer）
  routes/assistant.js     # 两个接口的路由与鉴权
```

---

## 七、UI 侧建议（给队友）

1. **建议流 + 问答框上下布局**：上方是 `insights` 卡片流（定时刷新或进页面拉一次），下方固定一个输入框调 `/ask`。
2. **优先级颜色**：critical 红、warn 橙、info 灰，方便子女一眼看到要紧的事。
3. **溯源必展示**：`sources` 要渲染出来（"参考：通用用药安全规范"），这是方案书的合规卖点。
4. **无异常时不空白**：`insights` 会返回一条 `type=reminder` 的正面反馈（"近期服药情况良好"），UI 正常渲染即可。

---

## 八、联调自检命令（后端已写好）

```bash
# 在源码目录，先起服务（走 3000 或任意端口）
node scripts/probe-assistant.js
```

预期输出里包含：`insights` 返回 200、`ask` 返回 200、缺 `question` 返回 400。
