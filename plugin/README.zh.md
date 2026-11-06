# DSH 任务通知插件

DSH 每完成一轮任务时，把通知推送到同一 Wi‑Fi 下的安卓手机；不在同一网络时也可以经你自己的
HTTPS 中继转发。插件还在 DSH 左侧栏注册一个「通知」设置面板，常用连接参数可以直接在界面里改，
不用编辑 YAML。

- 监听 `session/event` 的回合结束与 `approval/asked`，不会把中间消息或子代理回合当作任务完成。
- 用 UDP 广播自动发现手机，通常不需要填写 IP。
- 手机端 HTTP 服务 + 安卓高优先级通知，支持锁屏提示音和震动。
- 可选访问令牌、按状态过滤、最短时长过滤、每会话冷却、通知预览开关。
- 云端中继支持证书指纹固定（推荐）或 CA 文件校验；拒绝非回环的明文 HTTP。
- 提供 `phone_notify` 工具，让助手可以测试连接或发送自定义通知。
- 浏览器端左侧栏面板：局域网令牌、云端地址/设备/令牌/指纹、连接检查、测试通知。

## 组成

```text
电脑端  dsh-plugin-task-notify
        ├─ lib/index.js   宿主：事件监听、发现、投递、本机设置接口
        └─ lib/client.js  浏览器：左侧栏「通知」面板（DSH 客户端模块加载器直接执行）
手机端  DSH-Task-Notify-1.2.2.apk
```

电脑端只依赖 Node 内置模块；手机端是原生 Android 应用（minSdk 26 / targetSdk 34），
没有 AndroidX 或第三方运行时依赖。

## 安装

### 电脑端

```bash
dsh plugin --profile desktop add /absolute/path/dsh-plugin-task-notify-1.2.2.tgz
```

或在 DSH 的 **插件** 页面选择本地的 `dsh-plugin-task-notify-1.2.2.tgz`。插件声明了
`dsh.bundle.patch` 和 `dsh.client`，安装后会被加入 profile 的 bundle 列表，并在下次启动时
加载浏览器端面板。

### 手机端

1. 安装 `DSH-Task-Notify-1.2.2.apk`（从 1.2.1 升级需先卸载旧版，签名不同）。
2. 打开 App，允许通知权限。
3. 保持 App 打开一次，让前台服务启动；之后可以退到后台。
4. 点「发送测试」应能立即看到一条通知。

## 配对

默认零配置：插件每次发送前（首次或缓存过期时）向 UDP 8766 广播发现包，手机端回复自己的
名称、端口和型号，电脑端直接向该地址 POST 通知。

如果自动发现失败（某些路由器隔离了广播、Windows 防火墙拦截了 UDP 回包，或手机使用了
访客网络），在 DSH profile 的 `cordis.patch.yml` 里写死手机地址：

```yaml
- id: task-notify
  config:
    discover: false
    devices:
      - host: 192.168.1.23
        port: 8765
        name: 我的手机
```

手机 IP 显示在 App 首页的地址栏里。

## 左侧栏设置面板

重启 DSH 后，左侧栏出现 **通知** 入口。面板可以修改：

| 字段 | 作用 |
|---|---|
| 局域网 → 访问令牌 | 与 App「接收设置 → 访问令牌」一致；留空表示不校验 |
| 云端 → 启用 | 是否同时尝试云端中继 |
| 云端 → 服务器地址 | 必须是 `https://`（本机回环地址允许 `http://`） |
| 云端 → 设备 ID | 与手机 App 的「设备 ID」一致 |
| 云端 → 访问令牌 | 服务器 `/etc/dsh-notify.env` 的 `TOKEN` |
| 云端 → 证书指纹 | 服务器叶子证书的 SHA-256；点「获取指纹」可自动读取并与手机核对 |
| 云端 → CA 文件 | 进阶：用 CA 公钥校验，和指纹二选一 |

面板底部有「保存设置」「重新读取」；运行状态卡里有「检查连接」和「发送测试通知」。

### 设置如何生效

1. 保存后立即写入 `%USERPROFILE%\.dsh\storages\task-notify\settings.json`，不需要重启。
2. 下一次通知使用新配置；已在队列里的通知不受影响。
3. `settings.json` 覆盖 `cordis.patch.yml` 中的同名连接参数；删除该文件即可回到 patch 的值。
4. 面板接口只接受来自 `127.0.0.1` / `::1` 的请求，其他来源返回 403。

## 配置

所有字段都可选。写在 profile 的 `cordis.patch.yml` 中，目标 id 为 `task-notify`：

```yaml
- id: task-notify
  config:
    # 手动设备；留空并保持 discover: true 即可自动发现
    devices: []
    discover: true
    discoveryPort: 8766
    port: 8765                 # 手动设备的默认端口
    notifyOn: [completed, error]
    minDurationMs: 15000       # 纯聊天短回合不打扰；有工具调用的回合不受限
    cooldownMs: 2500           # 同一会话两次通知的最小间隔
    includePreview: true       # 是否把最后一条助手回复放进通知正文
    previewChars: 140
    timeoutMs: 3500
    attempts: 2
    token: ""                  # 可选，需与手机 App 的访问令牌一致
    ignoreSubagents: true
    tool: true                 # 是否注册 phone_notify 工具
    logToFile: true            # 诊断日志，默认写入 ~/.dsh/storages/task-notify/plugin.log
    notifyOnStart: false       # 启动插件时发一条「已连接」通知
    notifyOnApproval: true     # DSH 弹出授权请求时也推送
    cloud:                     # 可选：自托管云端中继
      url: https://YOUR_SERVER_IP:56159
      token: <TOKEN>           # 服务器 /etc/dsh-notify.env 的 TOKEN
      device: vivo-v2154a      # 手机 App 的同一个设备 ID
      fingerprint: ""          # 服务器证书 SHA-256（推荐，64 位十六进制）
      caFile: ""               # 或者用 CA 公钥文件校验
      timeoutMs: 8000
```

`cloud` 配置后，插件会同时尝试局域网设备与云端；任一路成功即视为送达。只想要云端时把
`discover: false` 且不配置 `devices`。

### 云端证书

- `fingerprint`：叶子证书的 SHA-256，可带冒号或 `sha256:` 前缀。填了就用它当信任锚，
  不再走系统 CA 校验（更安全，也不依赖证书链）。
- `caFile`：指向服务器 CA 的 PEM 文件，按标准证书链校验。
- 两者都留空：按系统信任的公有 CA 校验；自签名证书会失败并提示「TLS 证书校验失败」。

左侧栏面板的「获取指纹」会在本机连一次服务器（不发送令牌），返回证书的 SHA-256、
主题和有效期；点「使用此指纹」即可填入。请与手机 App 显示的指纹核对后保存。

### 通知规则

`notifyOn` 可取：`completed`、`error`、`aborted`、`blocked`、`max-tokens`、
`interrupted`、`forked`。默认只推 `completed` 和 `error`。

`devices` 也支持字符串写法：`"192.168.1.23"` 或 `"192.168.1.23:8765"`。

## 工具 `phone_notify`

插件挂载后会向当前 profile 注册一个诊断工具：

- `action: discover`：立即广播发现并 ping 手机（以及云端），返回在线状态。
- `action: test`：发送一条固定测试通知。
- `action: send`：发送自定义 `title` / `body`。

可以直接对助手说：

> 用 phone_notify 测试一下手机通知。

工具会返回每台设备的 `name`、`host`、`port`、`online` 和错误原因。

## 本机接口

设置面板通过这些只在本机可用的接口工作：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-task-notify/state` | 当前配置、设备、最近投递 |
| POST | `/dsh-task-notify/settings` | 保存局域网令牌与云端配置 |
| POST | `/dsh-task-notify/test` | 发送测试通知 |
| POST | `/dsh-task-notify/probe` | 重新发现并检查连接 |
| POST | `/dsh-task-notify/fingerprint` | 读取 `{"url": "https://..."}` 的证书指纹 |

非回环请求一律 403；跨站来源（`Origin` 不同源或 `Sec-Fetch-Site: cross-site`）也返回 403；方法不匹配返回 405。没有 `webServer` 服务的无头 profile 只提供事件通知
和 `phone_notify` 工具，不注册这些接口。

## 通知内容

```json
{
  "v": 1,
  "status": "completed",
  "headline": "任务完成",
  "title": "季度报告生成",
  "body": "报告已写入 report.docx。",
  "project": "dsh_task_done",
  "cwd": "D:\\work\\dsh_task_done",
  "model": "deepseek-flash",
  "durationMs": 42000,
  "tools": 7,
  "host": "DESKTOP-XXXX",
  "ts": 1792210832473
}
```

手机端会校验版本、长度和字符，再把 `headline + title` 作为通知标题，`body` 作为正文，
展开后显示用时/工具数/项目/模型。通知记录保存在手机本地（最多 50 条）。
插件在回合中途重启、拿不到开始时间时，正文显示「用时未知」而不是「不到 1 秒」。

## 故障排查

| 现象 | 处理 |
|---|---|
| 左侧栏没有「通知」 | 确认插件版本 1.2.2 并重启 DSH；确认 profile bundles 含 `dsh-plugin-task-notify` |
| 面板读不到状态 | 看 `plugin.log`；确认 DSH 有 webServer 服务 |
| 保存返回 403 | 请用 `127.0.0.1` 访问 DSH；局域网地址只读 |
| `phone_notify discover` 找不到设备 | 确认手机 App 正在运行、与电脑同一 Wi‑Fi；关闭路由器的 AP 隔离/访客网络；允许 DSH 通过 Windows 防火墙的专用网络 |
| 能找到设备但发送失败 | 手机端「服务运行中」是否为绿色；端口是否被占用；令牌是否一致 |
| 锁屏收不到 | 关闭电池优化（App 首页「电池优化」）；检查通知渠道是否被静音；国产 ROM 还需允许自启动/后台运行 |
| 云端「证书未信任」 | 在手机 App 确认指纹后重连 |
| 云端「指纹不匹配」 | 服务器换了证书或中间人；核对后更新手机与插件的指纹 |
| 短回复不通知 | `minDurationMs` 默认为 15 秒且只过滤「无工具调用」的完成回合；改成 0 可全部通知 |

## 安全与隐私

- 默认不经过第三方推送；启用 `cloud` 后通知只经你自己的服务器。
- 手机端默认不校验令牌，同一 Wi‑Fi 内任何设备都能向 8765 端口发通知。需要更强隔离时，
  在 App 和左侧栏面板里设置同一个 `token`。
- 云端只接受 `https://`（回环地址例外），令牌不会明文传输。
- 证书指纹固定后，只有那张叶子证书能通过校验；换证书需要重新确认。
- 设置文件含令牌，写入时权限为 0600（Windows 上该位不生效，请依赖用户目录权限）。
- 通知正文可能包含工作内容；`includePreview: false` 只发送标题与用时。

## 卸载

1. 在 DSH 的插件页面移除 `dsh-plugin-task-notify`，或从 profile 的 `dependencies` /
   `dsh.profile.bundles` 中删除后重新安装依赖。
2. 手机上卸载「DSH 任务通知」。
3. 可选删除 `~/.dsh/storages/task-notify/`（日志、设备缓存、settings.json）。

## 开发与测试

```bash
# 设置面板接口（纯 Node）
node plugin/test/settings-api.mjs

# 纯 JVM 测试手机端接收核心与证书信任
javac --release 11 -encoding UTF-8 -d build/jvm apk/src/com/dsh/tasknotify/{Json,NotifyPayload,NotifySink,NotifyHttpServer,DiscoveryServer,CloudTrust}.java
java -cp build/jvm com.dsh.tasknotify.ServerTest
java -cp build/jvm com.dsh.tasknotify.CloudTrustTest
```

APK 的完整可复现构建见仓库根目录的 `build-apk.ps1` 与 `使用说明.md`。
