# 通信协议（v1）

电脑端插件与手机 App 之间的局域网协议。所有报文都是 UTF-8 JSON，没有压缩、加密或
二进制帧。实现分别位于：

- 电脑端：[`plugin/lib/index.js`](../plugin/lib/index.js)
- 手机端：[`NotifyHttpServer.java`](../apk/src/com/dsh/tasknotify/NotifyHttpServer.java)、[`DiscoveryServer.java`](../apk/src/com/dsh/tasknotify/DiscoveryServer.java)

---

## 1. 发现（UDP 8766）

手机 App 在 8766 端口监听 UDP。插件向以下地址发送同一个探测包：

- `255.255.255.255:8766`
- 每个非回环 IPv4 网卡的定向广播地址（按 netmask 计算），例如 `192.168.1.255:8766`

### 请求

```json
{
  "t": "dsh.discover",
  "v": 1,
  "app": "dsh-task-notify",
  "id": "2f1c0f9e-..."
}
```

`id` 是每次探测随机生成的 UUID，仅用于诊断；手机端目前不校验。

### 应答

手机端把应答**单播**回请求包的源地址和源端口：

```json
{
  "t": "dsh.device",
  "v": 1,
  "app": "dsh-task-notify",
  "name": "我的手机",
  "model": "Xiaomi 14",
  "port": 8765,
  "version": "1.2.0",
  "time": 1792210832473
}
```

- `port` 是手机 HTTP 服务实际监听的端口，可能与默认 8765 不同。
- 插件把 `(源 IP, port)` 作为设备身份；同一 `host:port` 只保留一条。
- 插件等待约 700ms（`discoveryTimeoutMs`），把结果缓存 10 分钟。
- 手机端需要 `CHANGE_WIFI_MULTICAST_STATE` 并持有 `MulticastLock`，否则部分设备在
  休眠时会过滤广播帧。

---

## 2. HTTP 接口

默认端口 8765，绑定 `0.0.0.0`。所有响应：

```http
Content-Type: application/json; charset=utf-8
Connection: close
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

### 2.1 `GET /ping`（也可用 `/status`、`/`）

连通性检查。若配置了令牌，必须携带 `Authorization: Bearer <token>`。

```json
{
  "ok": true,
  "app": "dsh-task-notify",
  "version": "1.2.0",
  "name": "我的手机",
  "port": 8765,
  "time": 1792210832473
}
```

### 2.2 `POST /notify`

投递一条任务通知。请求体是下面的通知 JSON；`Content-Length` 必须存在，最大 128 KB。

成功：

```json
{
  "ok": true,
  "id": "n_mvbw20qk_d828d2f6",
  "receivedAt": 1792210832473
}
```

错误：

| HTTP | 含义 |
|---|---|
| 400 | JSON 非法、版本不为 1、字段超限、缺 `Content-Length` |
| 401 | 需要或错误的 Bearer 令牌 |
| 404 | 路径不存在 |
| 405 | 方法不支持 |
| 500 | 通知展示失败（例如系统通知服务异常） |

### 2.3 `POST /test`

不需要请求体，手机端构造一条内置测试通知并展示。响应与 `/notify` 相同。用于
`curl` 或浏览器调试；同样受令牌保护。

### 2.4 其他

- `OPTIONS *` → `204`，用于简单的跨域预检。
- 任何未知路径 → `404`。
- 每个连接读超时 10 秒，最多 4 个工作线程，头部上限 16 KB，请求行/路径上限 512 字节。

---

## 3. 通知 JSON

```json
{
  "v": 1,
  "id": "n_mvbw20qk_d828d2f6",
  "kind": "turn-end",
  "status": "completed",
  "headline": "任务完成",
  "title": "季度报告生成",
  "body": "季度报告已经生成，文件写入 report.docx。",
  "sessionId": "session-...",
  "project": "dsh_task_done",
  "cwd": "D:\\work\\dsh_task_done",
  "model": "deepseek-flash",
  "turn": 12,
  "durationMs": 42000,
  "steps": 9,
  "tools": 7,
  "host": "DESKTOP-XXXX",
  "time": "2026-10-17T04:20:32.467Z",
  "ts": 1792210832473,
  "app": "dsh",
  "pluginVersion": "0.2.0"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | int | 协议版本，当前必须为 `1` |
| `id` | string | 通知唯一 id，用于 PendingIntent/诊断，最长 96 |
| `kind` | string | `turn-end`、`manual` 等 |
| `status` | string | `completed` / `error` / `aborted` / `blocked` / `max-tokens` / `interrupted` / `forked` / `approval` / `test` / `manual` / `started` |
| `headline` | string | 通知标题主干，如「任务完成」 |
| `title` | string | 会话标题或项目名 |
| `body` | string | 正文，最长 600 |
| `sessionId` | string | DSH 会话 id |
| `project` | string | cwd 的 basename |
| `cwd` | string | 工作目录 |
| `model` | string | 本轮模型 |
| `turn` | int? | 回合号；缺失表示未知 |
| `durationMs` | int | 本轮时长 |
| `steps` | int | 步数 |
| `tools` | int | 工具调用次数 |
| `host` | string | 电脑主机名 |
| `time` | string | ISO 时间 |
| `ts` | int | 毫秒时间戳，用于通知时间/本地历史 |

手机端会再次清洗：去掉控制字符、折叠空白、按字段截断；任何字段缺失或超限都不会导致
App 崩溃，只会使用默认值。

---

## 4. 访问令牌

可选。手机 App「访问令牌」非空时：

- 所有接口（含 `/ping`）都要求：

```http
Authorization: Bearer <token>
```

- 比较使用 `MessageDigest.isEqual` 常量时间比较。
- 插件配置 `token` 或单个设备对象的 `token` 字段提供该值。
- 发现应答**不包含**令牌，避免广播泄露。

---

## 5. 云端中继

云端中继是可选的第二通道，插件和手机都主动连接服务器，不需要公网入站以外的端口
（本实例：TCP 56159）。

### 5.1 插件 → 中继

```http
POST /api/v1/notify
Authorization: Bearer <TOKEN>
Content-Type: application/json

{"device":"vivo-v2154a","payload":{...与 /notify 相同的通知对象...}}
```

成功返回：

```json
{"ok":true,"device":"vivo-v2154a","seq":12,"queue":3,"clients":1}
```

`seq` 是设备内递增事件号，用于断线补发。消息超过队列上限（默认 200）时丢弃最旧的。

### 5.2 手机 ← 中继（SSE）

```http
GET /api/v1/stream?device=vivo-v2154a
Authorization: Bearer <TOKEN>
Accept: text/event-stream
Last-Event-ID: 11
```

服务端先补发 `seq > Last-Event-ID` 的离线队列，然后持续推送：

```text
id: 12
data: {"v":1,"status":"completed",...}

: ping
```

没有 `Last-Event-ID` 时不补历史，只接新消息。心跳默认 20 秒；客户端 45 秒无数据即重连。
`GET /api/v1/poll?device=...&after=11` 是同一队列的轮询调试接口。

### 5.3 健康检查

```http
GET /api/v1/ping        # 需要 Token
GET /api/v1/health      # 不需要 Token，仅返回计数
```

### 5.4 TLS

本实例使用自签名 CA，服务器证书 SAN 为 `IP:YOUR_SERVER_IP`。App 只信任内置的
`res/raw/dsh_cloud_ca.pem`，插件通过 `cloud.caFile` 指定同一张 CA；不依赖系统 CA 或域名。

---

## 6. 典型时序

```text
DSH turn/end
  plugin: discovery probe  ──UDP:8766──▶  phone
  plugin: ◀──UDP unicast──  {"t":"dsh.device","port":8765}
  plugin: POST /notify     ──HTTP:8765──▶ phone
  phone:  ◀──200 {"ok":true,"id":...}
  phone: NotificationManager.notify(...)
```

失败时插件最多重试 `attempts` 次（默认 2），每次间隔 250ms；4xx（令牌/参数）不重试。

---

## 7. 兼容性

- 版本号 `v=1` 是硬门槛；未来不兼容变更会提升版本并在两端同时拒绝。
- 新增可选字段不会破坏旧手机端（`NotifyPayload` 忽略未知字段）。
- UDP 发现端口固定 8766；HTTP 端口可配置，通过发现应答传递。
- 局域网直连 v1 不承诺跨公网、IPv6-only 或 TLS；跨公网请使用云端中继的 HTTPS/SSE 通道。
