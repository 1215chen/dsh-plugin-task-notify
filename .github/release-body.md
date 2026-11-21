## DSH 任务通知 1.2.4

修复「DSH 更新后完成/授权通知全部静默」的问题。功能与 1.2.3 相同。

### 修复

- **子代理判断失效导致通知静默**：DSH 更新后 `agents` 服务不再提供 `roots()`，插件的旧判断把所有会话都当成子代理，`turn/end` 与 `approval/asked` 在过滤阶段被直接丢弃（日志里没有任何 `turn.notify`）。
  现在改为读取 `session.header.delegationDepth`（兼容 `options.subagentDepth`）；拿不到任何信号时默认按根会话处理，宁可多通知也不再静默。
- 增加 `debug` 级别的 `turn.subagent-skip` / `approval.subagent-skip` 日志，后续出现类似静默可以直接定位。

### 版本与升级

- 插件与 App 统一 **1.2.4**（APK versionCode 7）。云中继同步到 1.2.4（无行为变化）。
- **1.2.2 / 1.2.3 → 1.2.4**：签名相同，可直接 `adb install -r` 覆盖安装，App 内的令牌、设备 ID、证书指纹与历史都会保留。
- **1.2.1 及更早 → 1.2.4**：签名自 1.2.2 起变更，Android 不允许跨签名覆盖，需先卸载旧版（App 内历史与设置会清空）。

### 安装

1. 手机安装 `DSH-Task-Notify-1.2.4.apk`（1.2.2/1.2.3 可直接覆盖）。
2. DSH 安装 `dsh-plugin-task-notify-1.2.4.tgz`，重启 DSH。
3. 左侧栏打开 **通知**，确认局域网令牌、云端地址、设备 ID、证书指纹后点「保存设置」。
4. 点「发送测试通知」验证；再触发一轮任务或一次工具授权，确认自动通知恢复。
5. 手机端确认 `v1.2.4` 与「云端已连接」。

完整步骤见 [README 安装教程](https://github.com/1215chen/dsh-plugin-task-notify#安装) 和
[完整配置过程](https://github.com/1215chen/dsh-plugin-task-notify/blob/main/docs/setup.md)。

### 校验

```text
见 SHA256SUMS.txt
```

### 说明

- 从 1.2.3 升级插件后需要重启 DSH 才会加载新代码。
- vivo/iQOO 需要允许「后台高耗电」，否则锁屏后服务可能被冻结。
- 云端服务地址和令牌不随仓库公开，部署时使用你自己的配置。
