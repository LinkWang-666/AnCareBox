# 安心格 · 设备—云端通信协议（v1）

> **这份文档是给做药箱硬件的人看的。** 实物还没接电脑，接口已经全部留好，
> 接上就能跑，不需要再改后端。
>
> - 所有接口：HTTP + JSON，字符集 UTF-8，路径前缀 `/api`
> - 设备侧统一命名空间：`/api/device/*`（**只认设备令牌**）
> - 服务默认地址：`http://<电脑局域网IP>:3000`
> - 没有实物时，用 `npm run device` 跑一遍「设备替身」，67 项断言全过即代表接口通畅

---

## 0. 一页看懂：设备一生要调哪些接口

| # | 时机 | 接口 | 作用 | 频率 |
|---|---|---|---|---|
| 0 | 首次接入 | `POST /api/auth/device-bind` | 用 6 位绑定码换长期设备令牌 | 一次 |
| 1 | 上电 | `POST /api/device/handshake` | 报到、报能力、对时、拿全量配置 | 每次开机 |
| 2 | 待机 | `POST /api/device/heartbeat` | 证明在线、取指令、看配置有没有变 | 60 秒 |
| 3 | 到点前 | `GET /api/device/tasks` | 拉当天任务单（可离线执行一整天） | 每天 1 次 |
| 4 | 动作发生 | `POST /api/device/events` | 开箱 / 取药 / 关箱，一次一条 | 事件驱动 |
| 5 | 网络恢复 | `POST /api/device/events/batch` | 断网期间攒的事件批量补传（幂等） | 恢复时 |
| 6 | 轮询 | `GET /api/device/commands` | 取云端下发的指令 | 15 秒 |
| 7 | 执行完 | `POST /api/device/commands/:id/ack` | 指令回执 | 跟随 #6 |
| 8 | 定时 | `POST /api/device/slots` | 每格余量 / 是否空 / 传感器好坏 | 每小时 |
| 9 | 定时 | `POST /api/device/status` | 电量 / 信号 / 温度 / 门磁 | 5 分钟 |
| 10 | 老人按键 | `POST /api/device/sos` | 「我不舒服」求助 | 事件驱动 |
| 11 | 硬件异常 | `POST /api/device/fault` | 锁卡死 / 喇叭不响 / 传感器坏 | 事件驱动 |
| 12 | 每天 | `GET /api/device/firmware` | 查有没有新固件（OTA） | 每天 1 次 |
| 13 | 定时 | `GET /api/device/time` | 单独校时 | 每 6 小时 |
| 14 | 首次接入 | `GET /api/device/recordings` | 下载方言录音，本地缓存 | 配置变更时 |
| 15 | 出问题时 | `POST /api/device/logs` | 上传诊断日志（排障用） | 异常时 |

> **配置类**（`GET /api/device/config`）在 #1 的响应里已经整包给全，
> 只有心跳告诉它 `config_changed: true` 时才需要再单独拉一次。

---

## 1. 认证

### 1.1 设备没有账号密码

设备凭「绑定码」换长期令牌：

```http
POST /api/auth/device-bind
Content-Type: application/json

{ "code": "867667" }
```

- `code`：6 位数字，子女在「子女端 → 药箱管理 → 生成绑定码」拿到，**5 分钟有效，用后即焚**
- 成功：

```json
{ "ok": true, "accessToken": "<设备令牌>", "expiresIn": "180d" }
```

- 设备令牌**有效期 180 天**，建议存 Flash，掉电不丢
- 绑定码只能用一次；要重绑就让子女重新生成一个

> 浏览器上打开的老人端走同一接口，服务端会额外种一张 httpOnly Cookie 用于静默续期。
> **真机不需要 Cookie**，把 `accessToken` 存本地即可。

### 1.2 后续所有请求带令牌

```http
Authorization: Bearer <accessToken>
```

### 1.3 三条硬规则

1. **设备身份只认令牌。** 请求体里传的 `device_code` 一律被覆盖，防止抓到报文后冒名上报。
2. **令牌只能碰自己这台药箱关联的老人。** 想开别人家的格子会被 403。
3. **令牌吊销是即时生效的。** 子女在网页上「解绑设备」后，旧令牌下一次请求就失效（服务端带 `jti` 会话校验，不是等它自然过期）。

---

## 2. 上电握手

```http
POST /api/device/handshake
Authorization: Bearer <设备令牌>
```

请求体（字段都可选，但建议全带）：

```json
{
  "api_version": "v1",
  "hardware_model": "MB-8L",
  "firmware_version": "1.0.0",
  "boot_at": "2026-11-15T09:00:00+08:00",
  "battery": 86,
  "charging": 0,
  "rssi": -57,
  "temperature": 27.4,
  "uptime_sec": 3,
  "capabilities": {
    "lock": true, "buzzer": true, "speaker": true,
    "screen": false, "scale": true, "door_sensor": true
  }
}
```

响应（节选）：

```json
{
  "ok": true,
  "server_time": "2026-11-15 09:00:03",
  "server_epoch_ms": 1763168403000,
  "api_version": "v1",
  "config_version": "a2f840e1bc2a",
  "device": { "device_code": "MB-2026-0001", "compartment_count": 7, "status": "online" },
  "policy": {
    "offline_timeout_min": 5,
    "heartbeat_interval_sec": 60,
    "command_poll_interval_sec": 15,
    "config_poll_interval_sec": 300,
    "max_batch_events": 50,
    "max_event_backfill_days": 30
  },
  "config": { "...全量配置，见第 3 节..." },
  "today_tasks": [ "...今天的任务单，见第 4 节..." ],
  "commands": [ "...上次离线期间积压的指令..." ]
}
```

**为什么握手要一次给这么多：** 设备刚上电，网络最可能不稳定。一次往返就把「配置 + 今日任务 + 积压指令」全给全，比连打三个请求安全得多。

**`server_epoch_ms` 必须用来校时。** 设备自己判断「几点该吃药」，时钟慢 20 分钟就等于每次都吃晚。

---

## 3. 全量配置

```http
GET /api/device/config
```

响应结构：

```json
{
  "api_version": "v1",
  "config_version": "a2f840e1bc2a",
  "server_time": "2026-11-15 09:00:03",
  "timezone": "Asia/Shanghai",
  "policy": { "...同上..." },
  "device": {
    "medbox_id": 1, "device_code": "MB-2026-0001",
    "hardware_model": "MB-8L", "firmware_version": "1.0.0",
    "compartment_count": 7, "status": "online", "last_seen_at": "2026-11-15 09:00:03"
  },
  "elders": [
    {
      "elder_id": 1, "name": "王秀英", "gender": "female", "is_primary": true,
      "reminder": {
        "remind_30m": false, "remind_10m": true, "remind_3m": true,
        "volume_level": 3, "speech_rate": "slow", "repeat_times": 2,
        "timeout_minutes": 30, "duplicate_window_minutes": 2,
        "hearing_level": "mild", "vision_level": "normal"
      },
      "sos_contact_user_id": 1
    }
  ],
  "slots": [
    {
      "compartment_id": 1, "slot_no": 1, "label": "第1格", "is_locked": true,
      "elder_id": 1, "schedule_id": 5,
      "stock_ratio": 80, "is_empty": false, "sensor_ok": true,
      "reported_at": "2026-11-15 08:10:00"
    }
  ],
  "schedules": [
    { "schedule_id": 5, "elder_id": 1, "dose_time": "08:30", "time_label": "早上",
      "slot_no": 1, "window": { "before_min": 10, "after_min": 30 }, "status": "active" }
  ],
  "medicines": [
    { "medicine_id": 3, "name": "苯磺酸氨氯地平片", "unit": "片",
      "appearance": "白色小圆片", "category": "降压",
      "stock_qty": 21, "expiry_date": "2027-06-30" }
  ],
  "recordings": [
    { "recording_id": 1, "elder_id": 1, "schedule_id": 5, "title": "早上吃药提醒",
      "dialect": "常州话", "duration_sec": 6,
      "audio_url": "http://192.168.1.5:3000/audio/morning_cz.mp3" }
  ]
}
```

### `config_version` 怎么用

它是一段 12 位摘要，**任何影响设备行为的配置变了它就会变**（老人提醒策略、格位映射、计划时间窗、药品、录音、格数）。

心跳时把上次拿到的值带上去：

```json
{ "config_version": "a2f840e1bc2a" }
```

- 服务器算出来一样 → `config_changed: false`，什么都不用做
- 不一样 → `config_changed: true`，**立刻调 `GET /api/device/config` 重拉**

> 为什么不是「版本号 +1」：那种做法要求每一处改配置的地方都记得 +1，漏一处设备就永远收不到更新，而且极难测出来。摘要方式不需要谁维护，天生不会漏。

---

## 4. 任务单

```http
GET /api/device/tasks?date=2026-11-15
```

- `date` 可选，默认今天；**只允许今天前后 7 天**，超范围返回 400
- 一张任务 = 「几点 + 开哪一格 + 念什么 + 几点算超时」

```json
{
  "date": "2026-11-15",
  "server_time": "2026-11-15 09:00:03",
  "count": 2,
  "tasks": [
    {
      "task_id": "S5-2026-11-15",
      "date": "2026-11-15",
      "schedule_id": 5,
      "elder_id": 1,
      "elder_name": "王秀英",
      "time_label": "早上",
      "dose_time": "08:30",
      "window": { "before_min": 10, "after_min": 30, "start": "08:20", "end": "09:00" },
      "slot_no": 1,
      "compartment_id": 1,
      "compartment_label": "第1格",
      "unlock": true,
      "items": [
        { "medicine_id": 3, "name": "苯磺酸氨氯地平片", "unit": "片",
          "dose_qty": 1, "appearance": "白色小圆片", "note": "饭后服" }
      ],
      "reminders": [
        { "lead_min": 10, "at": "08:20", "mode": "steady_light" },
        { "lead_min": 3,  "at": "08:27", "mode": "beep_and_speak" },
        { "lead_min": 0,  "at": "08:30", "mode": "unlock_and_speak" }
      ],
      "timeout": { "at": "09:30", "minutes": 30 },
      "speech": {
        "text": "王秀英，早上的药该吃了。请打开第 1 格。苯磺酸氨氯地平片 1 片。吃完记得关好箱门。",
        "rate": "slow", "volume": 3, "repeat": 2,
        "audio_url": "http://192.168.1.5:3000/audio/morning_cz.mp3",
        "audio_id": 1
      },
      "status": "pending",
      "result_at": null,
      "overdue": false
    }
  ]
}
```

### 字段说明

| 字段 | 设备怎么用 |
|---|---|
| `reminders[].mode` | `slow_blink` 慢闪 / `steady_light` 柔和常亮 / `beep_and_speak` 蜂鸣+语音 / `unlock_and_speak` 解锁+语音 |
| `reminders` | **只包含老人实际开启的那几档**，没开的不下发，设备不用自己判断 |
| `speech.audio_url` | 有值就优先播家人的方言录音，为 `null` 才用 TTS |
| `speech.text` | 服务端拼好的文案。**不要写死在固件里** —— 文案会改，改完要能立刻生效 |
| `speech.repeat` | 重复播报次数（听力下降的老人会调高） |
| `timeout.at` | 到这个点还没取药 → 上报 `timeout` 事件，云端判漏服 |
| `status` | `pending` 待执行 / `done` 已完成 / `missed` 已判漏服 / `refused` 重复取药被拦 |
| `overdue` | 时间窗已过但还没做。设备可用来决定「要不要补一句提醒」 |

**离线能力：** 这张单子拿到本地就能跑一整天，断网也不漏提醒。这是药箱能不能用的分水岭。

---

## 5. 事件上报

### 5.1 单条

```http
POST /api/device/events
```

```json
{
  "slot_no": 1,
  "event_type": "take",
  "dose_qty": 1,
  "occurred_at": "2026-11-15T08:31:12+08:00",
  "client_event_id": "MB0001-20261115-083112-0001"
}
```

响应：

```json
{
  "event": { "id": 123, "result": "on_time", "...": "..." },
  "alert": null,
  "message": "判定结果：on_time"
}
```

### 5.2 `event_type` 枚举

| event_type | 含义 | 服务端判定 |
|---|---|---|
| `open` | 开箱 | 按时间窗判定 |
| `take` | 取药 | `early` / `on_time` / `late` / `abnormal` |
| `close` | 关箱 | `unknown`（仅记录） |
| `duplicate_refused` | 重复取药被拦截 | `duplicate` → 重复取药告警 |
| `wrong_time_refused` | 非时段开箱被拦 | `abnormal` → 非服药时段开箱告警 |
| `timeout` | 超时未取 | `missed` → 漏服告警 |
| `offline` | 设备离线 | `unknown`（仅记录） |

### 5.3 判定规则

以该格绑定的计划时间窗为基准：

| 条件 | 结果 |
|---|---|
| 早于 `dose_time - window_before` | `abnormal`（异常） |
| 在 `[dose_time - before, dose_time)` 内 | `early`（提前） |
| 在 `[dose_time, dose_time + after]` 内 | `on_time`（按时） |
| 晚于 `dose_time + after` | `late`（延迟） |
| 设备上报 `timeout` | `missed`（漏服） |
| 同一计划 `duplicate_window_minutes` 内又取一次 | `duplicate`（重复） |

### 5.4 `occurred_at` 的边界

- 缺省 → 用服务器当前时间
- 不能晚于当前时间 10 分钟以上（防设备时钟错乱）
- 不能早于 30 天前（离线补传的合理上限）
- 格式：ISO 8601 或 `YYYY-MM-DD HH:mm:ss` 都行

---

## 6. 离线补传与幂等

断网期间把每条事件存本地队列，联网后一次性补传：

```http
POST /api/device/events/batch
```

```json
{
  "events": [
    { "client_event_id": "MB0001-20261115-201500-0007", "slot_no": 4, "event_type": "open",  "occurred_at": "2026-11-15T20:15:00+08:00" },
    { "client_event_id": "MB0001-20261115-201512-0008", "slot_no": 4, "event_type": "take",  "occurred_at": "2026-11-15T20:15:12+08:00", "dose_qty": 1 },
    { "client_event_id": "MB0001-20261115-201530-0009", "slot_no": 4, "event_type": "close", "occurred_at": "2026-11-15T20:15:30+08:00" }
  ]
}
```

响应：

```json
{
  "ok": true,
  "accepted": 2,
  "duplicated": 1,
  "failed": 0,
  "total": 3,
  "results": [
    { "client_event_id": "...0007", "ok": true, "duplicated": false, "event_id": 201, "result": "on_time" },
    { "client_event_id": "...0008", "ok": true, "duplicated": false, "event_id": 202, "result": "on_time" },
    { "client_event_id": "...0009", "ok": true, "duplicated": true,  "event_id": 199, "result": "unknown" }
  ]
}
```

### 三条必须遵守的约定

1. **`client_event_id` 必须全局唯一**（建议 `<设备码>-<YYYYMMDDHHmmss>-<序号>`）。
   同一个号重复上报，云端只会入库一次，返回 `duplicated: true` 和原记录。
   > 没有它，补传一次就多算一次漏服，依从率直接失真。
2. **单条坏了不影响整批。** 某条字段非法只会让那一条进 `failed`，其余照常入库 ——
   否则设备会永远卡在「整批 500 → 重试 → 再 500」。
3. **一次最多 50 条**，超了返回 400，请分批。

服务端会按 `occurred_at` 排序后再逐条判定 —— 因为「重复取药」依赖时间先后，乱序补传会把顺序判反。

---

## 7. 远程指令（云端 → 设备）

### 7.1 设备取指令

```http
GET /api/device/commands?limit=10
```

```json
{
  "count": 1,
  "commands": [
    { "command_id": 12, "command": "ring", "params": { "seconds": 5 },
      "priority": 3, "created_at": "2026-11-15 09:12:00", "expires_at": "2026-11-15 09:42:00" }
  ]
}
```

**取走即标记 `sent`**，同一条不会下发第二次 —— 避免「响了一次铃没回执，下一轮又响一次」。

### 7.2 指令表

| command | 参数 | 说明 |
|---|---|---|
| `ring` | `seconds` 1~120 | 响铃提醒老人吃药 |
| `led` | `slot_no?`, `seconds?` | 点亮某一格或整个面板 |
| `unlock` | `slot_no`（必填） | 打开指定格（子女远程帮开） |
| `lock` | `slot_no`（必填） | 锁回指定格 |
| `speak` | `text`（必填，≤200 字）, `volume?` | 播一段话 |
| `sync` | — | 立即重拉配置 |
| `reboot` | — | 重启（慎用） |
| `locate` | `seconds?` | 闪灯 + 蜂鸣，帮家人找到药箱 |

`priority` 越小越优先：SOS 相关 1 / 远程提醒 3 / 普通 5 / 配置同步 8。

### 7.3 回执（必须做）

```http
POST /api/device/commands/12/ack

{ "status": "done", "message": "响铃 5 秒完成" }
```

- `status`：`done` 或 `failed`
- 失败时在 `message` 里写清原因（如「锁舌卡住」），子女端能看到
- **重复回执是幂等的**，不会报错，设备可以放心重试

### 7.4 过期机制

指令带 `expires_at`（默认 30 分钟，SOS 类 10 分钟）。过点未执行自动作废 —— 防止「凌晨三点突然响铃」。

---

## 8. 格位状态

```http
POST /api/device/slots

{
  "slots": [
    { "slot_no": 1, "stock_ratio": 80, "is_empty": false, "sensor_ok": true, "is_locked": true },
    { "slot_no": 2, "stock_ratio": 5,  "is_empty": true,  "sensor_ok": true },
    { "slot_no": 3 }
  ]
}
```

响应会逐格告诉结果：

```json
{
  "ok": true, "accepted": 2,
  "rejected": [ { "slot_no": 3, "ok": false, "error": "该格位不存在" } ],
  "detail": [ "...每格的处理结果..." ]
}
```

### 关键约定：没装传感器就别报

`stock_ratio` / `is_empty` / `sensor_ok` 都是**可空**的：

- 该格没装传感器 → **不传这个字段，或传 `null`**，不要传 0
- 传 `0` 会被当成「格子空了」，子女端就会天天收到假的补药提醒
- 明确报 `is_empty: true` 时，云端会顺手生一条补药告警（同类 6 小时内只报一次）

---

## 9. 设备自检

```http
POST /api/device/status

{
  "battery": 84, "charging": 0, "rssi": -60,
  "temperature": 28.1, "uptime_sec": 3600,
  "door_open": 0, "firmware_version": "1.0.0"
}
```

- 这些字段心跳里也可以直接带（省一次请求）
- 越界值会被**收敛**而不是原样入库：`battery: 300` 存成 `100`，`rssi: -999` 存成 `-120`
  （固件 bug 或报文错位时，不至于让看板显示「电量 300%」）

---

## 10. 故障上报

```http
POST /api/device/fault

{ "code": "LOCK_JAMMED", "message": "第 3 格锁舌卡住，无法弹开" }
```

### 建议故障码

| code | 含义 |
|---|---|
| `LOCK_JAMMED` | 锁舌卡死 |
| `SPEAKER_DEAD` | 喇叭不响 |
| `SENSOR_FAULT` | 称重/门磁传感器异常 |
| `DOOR_OPEN` | 箱门未关严 |
| `MOTOR_FAULT` | 电机异常 |
| `OVER_TEMP` | 机内温度过高 |
| `LOW_BATTERY` | 电量过低 |

云端会生成 `fault` 类型告警通知子女，**同一故障码 30 分钟内只报一次**，设备可以放心高频重试。

---

## 11. SOS 求助

```http
POST /api/device/sos

{ "elder_id": 1 }
```

- `elder_id` 可选（一箱多老人时指明是谁按的），缺省记主老人
- 响应：

```json
{ "ok": true, "alertId": 456, "command_queued": true, "message": "已通知子女" }
```

服务端同时做两件事：
1. 写一条 `urgent` 级 SOS 告警，推给家庭主配置人
2. 给这台药箱排一条 `priority: 1` 的安抚播报（「已通知家人，请坐下休息」）——
   老人按完按钮最怕的是「没人应」，现场先出声比什么都重要

---

## 12. 方言录音

```http
GET /api/device/recordings
```

```json
[
  { "recording_id": 1, "elder_id": 1, "schedule_id": 5, "title": "早上吃药提醒",
    "dialect": "常州话", "duration_sec": 6,
    "audio_url": "http://192.168.1.5:3000/audio/morning_cz.mp3", "play_order": 0 }
]
```

- `audio_url` 是**绝对地址**，设备直接下载即可（设备没有「当前页面」可以参照相对路径）
- 建议本地缓存：断网时也能播家人的声音
- `schedule_id` 为 `null` 表示通用关怀语，任何时段都可播
- 同一时段有多条时按 `play_order` 轮换

---

## 13. 固件升级（OTA）

```http
GET /api/device/firmware
```

有新版：

```json
{
  "current": "1.0.0",
  "latest": {
    "version": "1.2.0", "url": "https://.../mb8l-1.2.0.bin",
    "sha256": "…64 位…", "size_bytes": 812345,
    "notes": "修复锁舌偶发卡死", "is_mandatory": false,
    "released_at": "2026-11-20 10:00:00"
  },
  "need_update": true
}
```

暂无固件 / 未报型号：

```json
{ "current": "1.0.0", "latest": null, "need_update": false, "message": "型号 MB-8L 暂无可用固件" }
```

**现在还没有真实固件包，这个接口先留着。** 一有包，往 `device_firmware` 表插一行就能发版，代码不用改：

```sql
INSERT INTO device_firmware (hardware_model, version, url, sha256, size_bytes, notes, is_mandatory)
VALUES ('MB-8L', '1.2.0', 'https://example.com/mb8l-1.2.0.bin', '<sha256>', 812345, '修复锁舌偶发卡死', 0);
```

`sha256` 请务必校验 —— 刷坏固件等于把药箱变砖。

---

## 14. 心跳

```http
POST /api/device/heartbeat

{
  "battery": 85, "charging": 0, "rssi": -58,
  "uptime_sec": 63, "door_open": 0,
  "config_version": "a2f840e1bc2a"
}
```

响应：

```json
{
  "ok": true,
  "server_time": "2026-11-15 09:00:03",
  "server_epoch_ms": 1763168403000,
  "online": true,
  "config_version": "a2f840e1bc2a",
  "config_changed": false,
  "next_task": { "...下一顿任务，结构同第 4 节..." },
  "pending_commands": [ "...待执行指令随本次响应一并下发，省一次请求..." ],
  "unread_alerts": 0
}
```

心跳的三个作用，缺一不可：

1. **证明在线** —— 超过 5 分钟没心跳，子女端会收到离线告警
2. **取走指令** —— 这是云端 → 设备的唯一通道
3. **拿下一顿任务** —— 不用设备自己算「现在该提醒谁」

> 只有事件上报、没有心跳的设备，会被判成离线。**心跳必须独立发**，哪怕什么都没发生。

---

## 15. 错误码约定

| HTTP | 场景 | 设备该怎么做 |
|---|---|---|
| 400 | 参数非法（如 `event_type` 不在枚举里） | 不要重试，记日志；检查固件字段拼写 |
| 401 | 令牌缺失/过期/被解绑 | 停止上报，重新走绑定流程（需要子女生成新绑定码） |
| 403 | 令牌类型不对（拿子女令牌调设备接口） | 检查是不是拿错了令牌 |
| 429 | 请求过于频繁（默认 240 次/分钟） | 退避重试，指数退避建议 5s → 15s → 60s |
| 500 | 服务端异常 | 指数退避重试；连续失败 10 次触发本地告警 |

响应体统一是：

```json
{ "error": "人能看懂的中文说明", "code": "可选机器码" }
```

---

## 16. 诊断日志

真机装到老人家里以后，出问题只能靠设备自己把记录传上来 —— 没有这个接口，
售后只能让家属把药箱寄回来。

```http
POST /api/device/logs

{
  "logs": [
    { "level": "info",  "event": "BOOT",      "message": "上电启动，固件 1.0.0", "context": { "uptime": 0 } },
    { "level": "warn",  "event": "WIFI_WEAK", "message": "WiFi 信号 -78dBm，可能影响上报" },
    { "level": "error", "event": "LOCK_FAIL", "message": "第 3 格锁舌卡住一次，重试后成功",
      "at": "2026-11-15T08:31:05+08:00" }
  ]
}
```

响应：

```json
{ "ok": true, "accepted": 3, "skipped": 0, "keep_days": 7 }
```

| 字段 | 说明 |
|---|---|
| `level` | `debug` / `info` / `warn` / `error`，非法值按 `info` 存 |
| `event` | 事件名，建议全大写短标识（`BOOT` / `LOCK_FAIL` / `OTA_START`） |
| `message` | 正文，超 2000 字截断；**空正文的条目会被跳过**（计入 `skipped`） |
| `at` | 设备侧时间，缺省用服务器时间 |
| `context` | 任意 JSON，建议带固件版本、电量、当时的 task_id |

限制与策略：

- **一次最多 100 条**，超了返回 400，请分批
- **只保留 7 天**，服务端每小时清一次（`DEVICE_LOG_KEEP_DAYS` 可改）
- 回读：`GET /api/device/logs?limit=100`（崩溃重启后确认上次记录到哪了）

> 为什么要限条数和正文长度：日志是设备「随手就发」的东西。一次死循环 bug
> 能在几分钟内把库塞满 —— 而这恰恰是设备出故障时最容易发生的事。

---

## 17. 硬件对接清单（照着做就行）

- [ ] 能保存 `accessToken` 到 Flash，掉电不丢
- [ ] 上电 → `handshake` → 用 `server_epoch_ms` 校准 RTC
- [ ] 本地有 RTC 且断电走时（没有 RTC 的药箱，断网后所有提醒都会错）
- [ ] 拿到任务单后写入本地调度表，**按本地时钟执行，不依赖网络**
- [ ] 断网时事件进本地队列（建议环形缓冲 ≥ 500 条），联网后 `events/batch` 补传
- [ ] `client_event_id` 用单调递增序号生成，重启后不重置（否则重启会重号）
- [ ] 心跳 60 秒一次，**独立于事件上报**
- [ ] 指令轮询 15 秒一次；执行完必须 `ack`
- [ ] 格位传感器没装的格子，**上报时省略字段**，不要报 0
- [ ] 锁控失败、喇叭异常等硬件问题走 `/fault`，不要伪装成 `event_type`
- [ ] OTA 下载后校验 `sha256` 再刷写
- [ ] 硬件异常时把上下文一起传 (`/logs`)，售后能少跑一趟

---

## 18. 没有实物时怎么验证接口

`npm run device` 是一个「设备替身」，它做的事和固件一模一样：

```bash
npm run device              # 走一遍完整流程，67 项断言
npm run device -- --loop    # 常驻，每 30 秒一次心跳（模拟待机中的真机）
npm run device -- --sos     # 额外触发一次 SOS
npm run device -- --verbose # 打印每个接口的完整报文
```

跑完输出形如：

```
=== 11. 远程指令：子女下发 → 设备取走 → 回执 ===
  ✓ 子女端下发响铃指令：command_id=1
  ✓ 不存在的格位不能远程解锁（防隔空开别人格子）：HTTP 400
  ✓ 设备取到待执行指令：1 条
  ✓ 取走后不重复下发（防重复响铃）
  ✓ 指令回执成功：响铃 5 秒完成
  ...
  通过 67 / 失败 0
```

> 一个能跑通的「设备替身」比十页文档更能证明接口是通的 —— 它跑不过，就是接口有问题。

替身会真的往库里写服药事件（这是故意的，只有真写进去才能验证判定与告警链路）。
演示前清理掉自己的测试数据：

```bash
npm run clean:agent            # 清事件与相关告警
npm run clean:agent -- --sos   # 连测试触发的 SOS 一起清
```

它只删 `client_event_id` 以 `agent-` 开头的行，不会碰任何真实数据。

---

## 19. 数据库改动（已执行，无需重复）

设备接口需要的字段和表已经通过 `sql/13_device_api.sql` 补齐，脚本幂等，可重复执行：

```bash
npm run migrate:device
```

新增内容：

| 对象 | 内容 | 为什么需要 |
|---|---|---|
| `medbox.hardware_model` | 硬件型号 | OTA 按型号发版 |
| `compartment.stock_ratio` / `is_empty` / `sensor_ok` / `reported_at` | 格位传感器状态 | 余量、缺药、传感器故障 |
| `intake_event.client_event_id` + `uk_ev_client` 唯一索引 | 事件幂等键 | 断网补传不重复计数 |
| `device_command` 表 | 下行指令队列 | 远程响铃/亮灯/解锁/播报 |
| `device_status` 表 | 设备遥测快照 | 电量/信号/门磁/故障码 |
| `device_firmware` 表 | 固件版本库 | OTA |
| `device_log` 表 | 设备诊断日志（保留 7 天） | 真机排障 |
| `alert.alert_type` 补 `fault` | 设备故障告警分类 | 与「服药行为异常」区分开 |

---

## 20. 相关文档

- [ASSISTANT_API.md](ASSISTANT_API.md) —— AI 用药助手接口
- [README.md](../README.md) —— 项目介绍、技术架构、安装运行与演示账号（2.6 鉴权与权限边界、3.4 演示账号）
- `scripts/device-agent.js` —— 本协议的参考实现（设备替身）
- `scripts/device-sim.js` —— 早期的事件流模拟器（只发事件，不跑完整生命周期）
