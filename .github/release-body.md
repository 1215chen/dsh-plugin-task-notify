## DSH 任务通知 1.2.2

### 新增

- **DSH 左侧栏设置面板**：左侧栏新增「通知」入口，可直接修改局域网令牌、云端服务器地址、设备 ID、访问令牌和证书指纹，并能检查连接、发送测试通知。保存后立即生效，不需要重启 DSH。
- **设置文件**：面板把连接参数写入 `~/.dsh/storages/task-notify/settings.json`，覆盖 profile 的 `cordis.patch.yml`；接口只允许本机回环地址访问。

### 修复

- **云端证书不再要求重打包 APK**：取消 `res/raw` 内置 CA。手机首次连接时展示服务器叶子证书的 SHA-256，确认后固定；之后指纹变化会拒绝连接。
- **插件证书校验**：新增 `cloud.fingerprint`（叶子证书 SHA-256），与 `cloud.caFile` 二选一；指纹模式下先校验证书再发送令牌。
- **禁止明文传输**：插件拒绝非回环 `http://` 云端地址；App 关闭 `usesCleartextTraffic`，设置页只接受 `https://`（回环地址除外）。
- 回合开始时间缺失时通知正文显示「用时未知」，不再显示「不到 1 秒」。
- `javac` 显式使用 `-encoding UTF-8`，修复中文 Windows 上源码被按 GBK 读取导致的编译错误。
- 修复 `cloud/test-plugin.mjs` 按标题取消息导致授权通知与完成通知混淆的断言错误。

### 版本与兼容性说明

- 插件与 App 版本号统一为 **1.2.2**（APK versionCode 5）。
- **1.2.2 使用了新的签名密钥**：从 1.2.1 升级前请卸载旧版，App 内历史与设置会清空，需要重新填写令牌和云端配置。
- 旧的 `cloud.caFile` 配置仍然可用；不填 `caFile` 也不填 `fingerprint` 时按系统根证书校验，自签名中继会失败并提示「TLS 证书校验失败」。

### 安装

1. 卸载旧版 App，再安装 `DSH-Task-Notify-1.2.2.apk`。
2. 安装 `dsh-plugin-task-notify-1.2.2.tgz` 到 DSH profile，重启 DSH。
3. 左侧栏打开 **通知**：填局域网令牌；云端填地址、设备 ID、令牌，点「获取指纹」→「使用此指纹」→ 保存。
4. 点「发送测试通知」验证；手机首次连接云端时核对指纹并「信任并重连」。

完整步骤见 [README 安装教程](https://github.com/1215chen/dsh-plugin-task-notify#安装) 和
[完整配置过程](https://github.com/1215chen/dsh-plugin-task-notify/blob/main/docs/setup.md)。

### 校验

```text
见 SHA256SUMS.txt
```

### 说明

- 当前运行中的 DSH 进程需要重启一次才能加载 1.2.2 插件与左侧栏面板。
- vivo/iQOO 需要允许「后台高耗电」，否则锁屏后服务可能被冻结。
- 云端服务地址和令牌不随仓库公开，部署时使用你自己的配置。
