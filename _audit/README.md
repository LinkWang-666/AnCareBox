# _audit —— 交付前自检脚本

这五个脚本用于交付前的系统自查，全部可重复运行。它们不属于业务代码，
打包给评委时不影响启动；删掉也不影响系统运行。

## 运行前提

1. 数据库 `smart_medbox` 已建好并导入种子数据；
2. `.env` 配置正确（尤其是 DB_PASSWORD）；
3. 先启动服务：双击项目根目录的 `双击启动Web应用.bat`，或 `npm start`。

## 五个脚本

| 脚本 | 检查内容 | 期望结果 |
|---|---|---|
| `smoke.js` | 登录/鉴权、7 个主要读接口、非法参数不出 500、跨家庭越权、上传路径穿越、事件上报鉴权 | 30 项全过 |
| `probe2.js` | `occurred_at` 边界、时间窗传 0、跨家庭隔间绑定、重复 `device_code`、设备令牌导出家庭数据 | 9 项全过 |
| `probe3.js` | viewer 角色写接口全拒、AI 助手不能旁路写操作、事件类型与未来时间、`limit`/`days` 越界收敛 | 14 项全过 |
| `consistency.js` | HTML 重复 id、前端 fetch 路径是否都有后端路由、HTML 引用的 js/css 是否存在（纯静态，不需要起服务） | 0 问题 |
| `fe.js` | 用 CDP 真实打开子女端/老人端/手机端，收集 console 错误、未捕获异常、失败请求，并检查关键区域是否渲染出内容 | 0 错误 |

## 跑法

```bash
node _audit/smoke.js
node _audit/probe2.js
node _audit/probe3.js
node _audit/consistency.js
```

`fe.js` 需要额外准备：Chrome 以 `--remote-debugging-port=9222` 启动（无头即可），
并且服务运行在 3000 端口。

```bash
# 示例
"C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=9222 --user-data-dir=%TEMP%\cdp-prof about:blank
node _audit/fe.js
```

## 说明

脚本里出现的测试账号（owner / member / 李家 / 王家）都是种子数据里自带的演示账号，
密码从 `.env` 或 `README.md` 的演示账号表格读取，不硬编码在脚本中。
`probe2.js` / `probe3.js` 会创建临时计划、临时只读账号，跑完自动清理。
