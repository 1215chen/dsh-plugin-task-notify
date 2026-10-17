# DSH 任务通知 · 安卓工程

原生 Java + Android Framework 的通知接收端。没有 Gradle、AndroidX 或第三方依赖，
使用 Android build-tools 直接构建。

- 包名：`com.dsh.tasknotify`
- 版本：1.2.1（versionCode 4）
- minSdk 26 / targetSdk 34
- APK 约 260 KB
- 界面：深色原生界面，支持局域网直连和云端中继

## 结构

```text
apk/
├─ AndroidManifest.xml
├─ res/
│  ├─ layout/activity_main.xml        主外壳：top app bar + 页面容器 + 底部导航
│  ├─ layout/page_home.xml            通知页：状态卡 + 历史
│  ├─ layout/page_settings.xml        设置页：服务、云端、接收设置、数据
│  ├─ layout/item_history.xml         历史条目
│  ├─ layout/dialog_message.xml       圆角对话框
│  ├─ drawable/                       卡片、按钮、状态点、图标
│  ├─ drawable-*dpi/                  鲸鱼图标、通知栏小图标
│  ├─ color/                          状态色 selector
│  ├─ mipmap-anydpi-v26/              自适应图标
│  └─ values/                         颜色、样式、字符串
├─ src/com/dsh/tasknotify/
│  ├─ MainActivity.java               外壳、页面导航、权限、设置、历史
│  ├─ M3Switch.java                   52×32dp 自绘开关
│  ├─ CloudClient.java                云端 SSE 客户端（纯 Java 可测）
│  ├─ CloudTls.java                   内置 CA 的 TLS 校验
│  ├─ NotifyService.java              前台服务、生命周期、局域网/云端投递
│  ├─ NotificationHelper.java         通知渠道与通知构建
│  ├─ NotifyHttpServer.java           HTTP 接收（纯 JVM 可测）
│  ├─ DiscoveryServer.java            UDP 发现应答（纯 JVM 可测）
│  ├─ NotifyPayload.java              通知 JSON 校验（纯 JVM 可测）
│  ├─ Json.java                       无依赖 JSON 解析/序列化（纯 JVM 可测）
│  ├─ NotifySink.java                 接收接口
│  ├─ Store.java                      SharedPreferences 设置与历史
│  ├─ NetworkUtils.java               本机 IPv4 探测
│  ├─ BootReceiver.java               开机自启
│  └─ AppInfo.java                    常量
├─ test/com/dsh/tasknotify/
│  ├─ ServerTest.java                 JVM 接收核心测试
│  ├─ RunServer.java                  集成测试用的常驻接收端
│  └─ plugin-integration.mjs          插件端到端测试
└─ keystore/                          签名密钥（见其 README）
```

## 关键设计

### 界面与云端

v1.2.1 仍然是原生实现，没有 AndroidX / Material Components 依赖：

- 深色界面，底部导航切换「通知 / 设置」。
- **通知页只保留状态卡 + 历史**；启动停止、发送测试、电池优化、清空、保存全部在设置页。
- 设置页新增「云端中继」：服务器地址、设备 ID、令牌、启用开关。
- 云端使用 SSE 长连接；断线自动重连，服务端按 `Last-Event-ID` 补发离线队列。
- 双通道去重：`NotifyService` 按 `payload.id` 在 10 分钟窗口内只处理第一条，避免局域网 + 云端重复通知。
- `CloudClient` 是纯 Java，桌面 JVM 可直接测试；`CloudTls` 只信任内置 CA。
- 授权事件 `approval/asked` 显示为「需要授权」，历史里使用锁图标和琥珀色。
- 应用图标来自 DSH 桌面端的鲸鱼；通知栏小图标为白色鲸鱼剪影。
- 点按通知打开通知页并滚动到历史区。

### 前台服务

`NotifyService` 在 `onCreate` 立即 `startForeground`，然后在线程里启动：

- `NotifyHttpServer`：TCP 8765，4 个工作线程，10 秒读超时。
- `DiscoveryServer`：UDP 8766，应答插件广播。
- `CloudClient`：云端启用时连接 HTTPS SSE，断线指数退避重连。

同时持有：

- `PARTIAL_WAKE_LOCK`：锁屏时保持 CPU 响应。
- `WifiManager.MulticastLock`：允许 Wi-Fi 芯片把广播帧交给 App，提升自动发现成功率。

`START_STICKY`，被系统回收后会尝试重建。`BootReceiver` 在 `BOOT_COMPLETED` 时按用户
保存的开关决定是否拉起。Android 12+ 的 FGS 后台启动限制会被 try/catch 兜住。

### 通知

- 渠道 `task_done`：`IMPORTANCE_HIGH`、默认提示音、震动、锁屏私密。
- 渠道 `service`：`IMPORTANCE_LOW`，常驻但不出声。
- 通知标题：`headline · title`；正文：`body`；展开：`body + 用时/工具数/项目/模型`。
- 点按打开 `MainActivity`，历史里可查看全文。
- 所有字段在 `NotifyPayload` 中清洗/截断，非法 JSON 返回 400，不会让服务崩溃。

### 权限

| 权限 | 用途 |
|---|---|
| `INTERNET` | 监听局域网 socket |
| `ACCESS_NETWORK_STATE` / `ACCESS_WIFI_STATE` | 网络状态/地址 |
| `CHANGE_WIFI_MULTICAST_STATE` | 接收 UDP 广播 |
| `POST_NOTIFICATIONS` | Android 13+ 通知权限 |
| `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_DATA_SYNC` | 前台接收服务 |
| `RECEIVE_BOOT_COMPLETED` | 开机自启 |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | 电池优化白名单请求 |
| `WAKE_LOCK` | 锁屏保持 CPU |

### 首次启动

1. 创建通知渠道。
2. 请求 `POST_NOTIFICATIONS`。
3. 若用户未主动停止服务，启动前台服务。
4. 首页显示地址、端口、服务状态、历史。

## 构建

前置：JDK 17+、Node.js 22+、Android build-tools 34、platform android-34（见根目录
`build-apk.ps1` 的说明）。

```powershell
# 在项目根目录
.\build-apk.cmd
```

或：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-apk.ps1
```

脚本会：

1. `aapt2 compile` + `aapt2 link`。
2. `javac --release 8` 编译。
3. `_tools\strip-method-parameters.mjs` 删除 `MethodParameters` 属性
   （d8 34 对该属性中空参数名会抛 NPE）。
4. `jar` + `d8 --min-api 26`。
5. `jar` 写回 dex，`zipalign -f 4`。
6. `apksigner sign`（v2 + v3）并 `verify`。

## 测试

纯 JVM 测试不需要 Android 设备：

```powershell
javac --release 11 -d apk\build\jvm-classes `
  apk\src\com\dsh\tasknotify\Json.java `
  apk\src\com\dsh\tasknotify\NotifyPayload.java `
  apk\src\com\dsh\tasknotify\NotifySink.java `
  apk\src\com\dsh\tasknotify\NotifyHttpServer.java `
  apk\src\com\dsh\tasknotify\DiscoveryServer.java

javac --release 11 -cp apk\build\jvm-classes -d apk\build\test-classes `
  apk\test\com\dsh\tasknotify\ServerTest.java `
  apk\test\com\dsh\tasknotify\RunServer.java

java -cp "apk\build\jvm-classes;apk\build\test-classes" com.dsh.tasknotify.ServerTest
```

集成测试：

```powershell
java -cp "apk\build\jvm-classes;apk\build\test-classes" `
  com.dsh.tasknotify.RunServer 18765 18766 _tmp\server-ready.txt _tmp\notifications.jsonl

node apk\test\plugin-integration.mjs
```

测试覆盖：`/ping`、`/notify`、非法 JSON、版本校验、令牌 401、`/notify` 成功、
UDP 发现应答、通知字段清洗、短回合抑制、子代理抑制。

## 真机验证（vivo V2154A / Android 14）

- ADB 安装、前台服务、`GET /ping` 200。
- 高重要性通知渠道（声音 + 震动）、通知中心卡片、点按打开 `MainActivity`、历史记录。
- 屏幕熄灭 30 秒后仍可接收并弹出通知（需 vivo「允许后台高耗电」）。
- 重启后服务延迟自启；Wi-Fi 切换到不同 SSID/网段会导致不可达，需要连回同一网段。
- 实机截图见 [`../docs/screenshots/`](../docs/screenshots/)。

## 签名

见 [`keystore/README.md`](keystore/README.md)。自用密钥，**不要丢失**，否则无法覆盖安装
后续版本。

## 已知限制

- 仅 IPv4 局域网；没有 TLS、mDNS、公网中继。
- 通知内容按纯文本清洗；不渲染 Markdown/图片。
- 没有 AndroidX，UI 使用原生控件与自定义 drawable。
- 仅在 vivo V2154A / Android 14 上实测；其他版本/ROM 的 Activity/Service 行为未逐一验证。
- vivo / iQOO 必须允许「后台高耗电」，否则锁屏后进程会被冻结；其他 ROM 需按各自策略设置。
