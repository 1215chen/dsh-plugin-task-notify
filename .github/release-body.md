## DSH 任务通知 1.2.1

### 新功能

- **云端中继**：通过自托管 HTTPS 服务器转发，手机和电脑不在同一网络也能收到通知。
- **授权通知**：监听 DSH 的 `approval/asked`，收到「需要授权」通知，正文包含工具名和原因。
- **DSH 鲸鱼图标**：启动图标和通知栏小图标都使用 DSH 桌面端图标。
- **中英双语 README**：中文默认展示，附完整安装教程和英文说明。

### 修复

- **双通道去重**：同一 `payload.id` 同时经局域网和云端到达时，10 分钟窗口内只保留一条通知和一条历史记录。
- 云端 SSE 断线重连与离线队列按 `Last-Event-ID` 补发。

### 安装

1. 下载并安装 `DSH-Task-Notify-1.2.1.apk`，允许通知权限。
2. 局域网模式：手机和电脑连接同一 Wi-Fi，打开「接收服务」。
3. 云端模式：设置 → 云端中继，填写服务器地址、设备 ID、令牌并保存。
4. 安装 `dsh-plugin-task-notify-0.2.0.tgz` 到 DSH profile，重启 DSH。
5. 对助手说「用 phone_notify 测试一下手机通知」验证。

完整步骤见 [README 安装教程](https://github.com/1215chen/dsh-plugin-task-notify#安装教程) 和 [完整配置过程](https://github.com/1215chen/dsh-plugin-task-notify/blob/main/docs/setup.md)。

### 校验

```text
98EE58EC27EF91AB14614610C5B01F05586C68CD78E2C375D34397D41FBB1859  DSH-Task-Notify-1.2.1.apk
E392E4A1BECD37C0D2E66F5EAC902B0A1E59994D3CF6F33B5C058481BA7881E3  dsh-plugin-task-notify-0.2.0.tgz
```

### 说明

- 当前运行中的 DSH 进程需要重启一次才能加载 0.2.0 插件。
- vivo/iQOO 需要允许「后台高耗电」，否则锁屏后服务可能被冻结。
- 云端服务地址和令牌不随仓库公开，部署时使用你自己的配置。
