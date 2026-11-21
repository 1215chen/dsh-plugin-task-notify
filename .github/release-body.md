## DSH 任务通知 1.2.3

安全修复版本，功能与 1.2.2 相同。

### 安全修复

- **设置接口防 DNS rebinding**：`/dsh-task-notify/*` 现在同时校验 TCP 对端和 `Host`——只接受 `localhost`、`127.0.0.0/8`、`[::1]`（及 `*.localhost`），并要求 `Origin` 与 `Host` 同源。攻击者把域名解析到 127.0.0.1 的页面不再能读取 `/state` 里的令牌，也不能改写云端中继配置。
- **SSE 客户端清理**：只在响应 `close`/`error` 时把客户端移出在线列表。Node 16 起 `IncomingMessage` 的 `close` 表示请求消息完成，若请求流被中间件消费会在 SSE 仍打开时提前触发，导致实时推送退化成断线补发。

### 版本与升级

- 插件、App、云中继统一 **1.2.3**（APK versionCode 6）。
- **1.2.2 → 1.2.3**：签名相同，可直接 `adb install -r` 覆盖安装，App 内的令牌、设备 ID、证书指纹与历史都会保留。
- **1.2.1 及更早 → 1.2.3**：签名自 1.2.2 起变更，Android 不允许跨签名覆盖，需先卸载旧版（App 内历史与设置会清空）。

### 安装

1. 手机安装 `DSH-Task-Notify-1.2.3.apk`（1.2.2 可直接覆盖）。
2. DSH 安装 `dsh-plugin-task-notify-1.2.3.tgz`，重启 DSH。
3. 左侧栏打开 **通知**：确认局域网令牌、云端地址、设备 ID、证书指纹，点「保存设置」。
4. 点「发送测试通知」验证；手机端确认 `v1.2.3` 与「云端已连接」。

完整步骤见 [README 安装教程](https://github.com/1215chen/dsh-plugin-task-notify#安装) 和
[完整配置过程](https://github.com/1215chen/dsh-plugin-task-notify/blob/main/docs/setup.md)。

### 校验

```text
见 SHA256SUMS.txt
```

### 说明

- 从 1.2.2 升级插件后需要重启 DSH 才会加载新代码。
- vivo/iQOO 需要允许「后台高耗电」，否则锁屏后服务可能被冻结。
- 云端服务地址和令牌不随仓库公开，部署时使用你自己的配置。
