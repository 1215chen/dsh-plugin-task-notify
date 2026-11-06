# DSH 任务通知 · 安卓工程

原生 Java + Android Framework 的通知接收端。没有 Gradle、AndroidX 或第三方依赖，
使用 Android build-tools 直接构建。

- 包名：`com.dsh.tasknotify`
- 版本：1.2.2（versionCode 5）
- minSdk 26 / targetSdk 34
- APK 约 260 KB
- 界面：深色原生界面，支持局域网直连和云端中继（证书指纹固定）

## 结构

```text
apk/
├─ AndroidManifest.xml
├─ res/
│  ├─ layout/activity_main.xml        主外壳：top app bar + 页面容器 + 底部导航
│  ├─ layout/page_home.xml            通知页：状态卡 + 历史
│  ├─ layout/page_settings.xml        设置页：服务、云端、证书信任、接收设置、数据
│  ├─ layout/item_history.xml         历史条目
│  ├─ layout/dialog_message.xml       圆角对话框
│  ├─ drawable/                       卡片、按钮、状态点、图标
│  ├─ drawable-*dpi/                  鲸鱼图标、通知栏小图标
│  ├─ color/                          状态色 selector
│  ├─ mipmap-anydpi-v26/              自适应图标
│  └─ values/                         颜色、样式、字符串
├─ src/com/dsh/tasknotify/
│  ├─ MainActivity.java               外壳、页面导航、权限、设置、历史、证书确认
│  ├─ M3Switch.java                   52×32dp 自绘开关
│  ├─ CloudClient.java                云端 SSE 客户端（纯 Java 可测）
│  ├─ CloudTrust.java                 证书指纹固定（纯 Java 可测）
│  ├─ NotifyService.java              前台服务、生命周期、局域网/云端投递
│  ├─ NotificationHelper.java         通知渠道与通知构建
│  ├─ NotifyHttpServer.java           HTTP 接收（纯 JVM 可测）
│  ├─ DiscoveryServer.java            UDP 发现应答（纯 JVM 可测）
│  ├─ NotifyPayload.java              通知 JSON 校验（纯 JVM 可测）
│  ├─ Json.java                       无依赖 JSON 解析/序列化（纯 JVM 可测）
│  ├─ NotifySink.java                 接收接口
│  ├─ Store.java                      SharedPreferences 设置与历史
│  ├─ NetworkUtils.java               本机 IPv4 探测、回环判断
│  ├─ BootReceiver.java               开机自启
│  └─ AppInfo.java                    常量
├─ test/com/dsh/tasknotify/
│  ├─ ServerTest.java                 JVM 接收核心测试（19 项）
│  ├─ CloudTrustTest.java             JVM 证书固定测试（8 项）
│  ├─ RunServer.java                  集成测试用的常驻接收端
│  └─ plugin-integration.mjs          插件端到端测试
└─ keystore/                          签名密钥与密码（.gitignore 排除）
```

## 关键设计

### 证书信任（1.2.2 重写）

旧版本把一张 CA 公钥内置进 APK，导致别人必须重新打包才能用自己的服务器。1.2.2 取消了
内置 CA，改成**首次确认叶子证书指纹**：

1. `CloudTrust.Manager` 在 TLS 握手时计算服务器叶子证书的 SHA-256，并记录到
   `CloudTrust.pendingFingerprint()`。
2. 没有固定指纹时：先尝试平台信任库；公网证书直接通过，自签名证书抛出
   `UnpinnedCertificate`，界面展示指纹等待用户确认。
3. 用户确认后写入 `SharedPreferences`；之后只接受这张证书，不匹配抛
   `FingerprintChanged`（即使换成了另一张公网证书也会被拒绝）。
4. `NotifyService` 只接受 `https://`（本机回环地址例外）；`AndroidManifest` 的
   `usesCleartextTraffic` 已关闭。

`CloudTrust` 不依赖 Android API，所以 `CloudTrustTest` 可以在桌面 JVM 上直接验证
「未信任拒绝 / 指纹匹配放行 / 指纹变化拒绝 / 指纹格式」。

### 界面与云端

- 深色界面，底部导航切换「通知 / 设置」。
- **通知页只保留状态卡 + 历史**；启动停止、发送测试、电池优化、清空、保存全部在设置页。
- 设置页的「云端中继」包含服务器地址、设备 ID、令牌、启用开关，以及证书信任卡片
  （首次确认 / 已信任 / 证书已变化 / 清除信任）。
- 云端使用 SSE 长连接；断线自动重连，服务端按 `Last-Event-ID` 补发离线队列。
- 双通道去重：`NotifyService` 按 `payload.id` 在 10 分钟窗口内只处理第一条。
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
| `INTERNET` | 监听局域网 socket、连接云端 |
| `ACCESS_NETWORK_STATE` / `ACCESS_WIFI_STATE` | 网络状态/地址 |
| `CHANGE_WIFI_MULTICAST_STATE` | 接收 UDP 广播 |
| `POST_NOTIFICATIONS` | Android 13+ 通知权限 |
| `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_DATA_SYNC` | 前台接收服务 |
| `RECEIVE_BOOT_COMPLETED` | 开机自启 |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | 电池优化白名单请求 |
| `WAKE_LOCK` | 锁屏保持 CPU |

## 构建

前置：JDK 17+、Android build-tools 34、platform android-34（放在 `_sdk\`，见根目录
`build-apk.ps1` 的说明）。

```powershell
# 在项目根目录
$env:DSH_KEYSTORE_PASSWORD = "your-keystore-password"
.\build-apk.cmd
```

脚本会：

1. `aapt2 compile` + `aapt2 link`。
2. `javac --release 8 -encoding UTF-8` 编译（显式 UTF-8，避免中文 Windows 默认 GBK）。
3. `_tools\strip-method-parameters.mjs` 删除 `MethodParameters` 属性
   （d8 34 对该属性中空参数名会抛 NPE）。
4. `jar` + `d8 --min-api 26`。
5. `jar` 写回 dex，`zipalign -f 4`。
6. `apksigner sign`（v2 + v3）并 `verify`。

## 测试

纯 JVM 测试不需要 Android 设备：

```powershell
javac --release 11 -encoding UTF-8 -d apk\build\jvm-classes `
  apk\src\com\dsh\tasknotify\Json.java `
  apk\src\com\dsh\tasknotify\NotifyPayload.java `
  apk\src\com\dsh\tasknotify\NotifySink.java `
  apk\src\com\dsh\tasknotify\NotifyHttpServer.java `
  apk\src\com\dsh\tasknotify\DiscoveryServer.java `
  apk\src\com\dsh\tasknotify\NetworkUtils.java `
  apk\src\com\dsh\tasknotify\CloudTrust.java

javac --release 11 -encoding UTF-8 -cp apk\build\jvm-classes -d apk\build\test-classes `
  apk\test\com\dsh\tasknotify\ServerTest.java `
  apk\test\com\dsh\tasknotify\CloudTrustTest.java `
  apk\test\com\dsh\tasknotify\RunServer.java

java -cp "apk\build\jvm-classes;apk\build\test-classes" com.dsh.tasknotify.ServerTest
# RESULT passed=19 failed=0

java -cp "apk\build\jvm-classes;apk\build\test-classes" com.dsh.tasknotify.CloudTrustTest
# RESULT passed=8 failed=0
```

集成测试：

```powershell
java -cp "apk\build\jvm-classes;apk\build\test-classes" `
  com.dsh.tasknotify.RunServer 18765 18766 _tmp\server-ready.txt _tmp\notifications.jsonl

node apk\test\plugin-integration.mjs
```

测试覆盖：`/ping`、`/notify`、非法 JSON、版本校验、令牌 401、`/notify` 成功、
UDP 发现应答、通知字段清洗、短回合抑制、子代理抑制，以及证书固定的四种状态。

## 真机验证（vivo V2154A / Android 14）

- ADB 安装、前台服务、`GET /ping` 200。
- 高重要性通知渠道（声音 + 震动）、通知中心卡片、点按打开 `MainActivity`、历史记录。
- 屏幕熄灭 30 秒后仍可接收并弹出通知（需 vivo「允许后台高耗电」）。
- 重启后服务延迟自启；Wi-Fi 切换到不同 SSID/网段会导致不可达，需要连回同一网段。
- 实机截图见 [`../docs/screenshots/`](../docs/screenshots/)。

> 1.2.2 的 APK 已在 vivo V2154A 上重装验证：局域网 `/ping`、云端证书确认（指纹
> `E0:3B:…:FE`）、SSE 连接与端到端投递均通过。签名密钥是新的：升级前需要卸载 1.2.1。

## 签名

签名密钥：`apk\keystore\dsh-task-notify.p12`；密码：`apk\keystore\password.txt`。
两者都被 `.gitignore` 排除，**不要丢失**，否则后续版本无法覆盖安装，只能卸载重装。
首次构建时若密钥不存在，`build-apk.ps1` 会用 `$env:DSH_KEYSTORE_PASSWORD` 自动生成。

## 已知限制

- 局域网只走 IPv4；发现端口固定 8766。
- 云端要求 HTTPS；明文 HTTP 只对回环地址放行（仅用于本地测试）。
- 通知内容按纯文本清洗；不渲染 Markdown/图片。
- 没有 AndroidX，UI 使用原生控件与自定义 drawable。
- 仅在 vivo V2154A / Android 14 上实测；其他版本/ROM 的 Activity/Service 行为未逐一验证。
- vivo / iQOO 必须允许「后台高耗电」，否则锁屏后进程会被冻结；其他 ROM 需按各自策略设置。
- 常驻 `PARTIAL_WAKE_LOCK` + `MulticastLock` 是可靠性的代价，续航敏感时可把服务关掉。
