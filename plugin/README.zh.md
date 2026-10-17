# DSH 任务通知插件

DSH 每完成一轮任务时，把通知推送到同一 Wi‑Fi 下的安卓手机。手机端配套 App 已经打包为
`DSH-Task-Notify-1.2.1.apk`，不需要公网、账号或第三方推送服务。

- 监听 `session/event` 的正常/异常回合结束，不会把中间消息或子代理回合当作任务完成。
- 用 UDP 广播自动发现手机，通常不需要填写 IP。
- 手机端 HTTP 服务 + 安卓高优先级通知，支持锁屏提示音和震动。
- 可选访问令牌、按状态过滤、最短时长过滤、每会话冷却、通知预览开关。
- 提供 `phone_notify` 工具，让助手可以测试连接或发送自定义通知。

## 组成

```text
电脑端  dsh-plugin-task-notify   （本目录）
手机端  DSH-Task-Notify-1.2.1.apk
```

电脑端只依赖 Node 内置模块，安装为一个普通 DSH profile bundle；手机端是原生 Android
应用（minSdk 26 / targetSdk 34），没有 AndroidX 或第三方运行时依赖。

## 安装

### 电脑端

插件已经以 tarball 形式打进 DSH 的 `desktop` profile：

```bash
dsh plugin --profile desktop add /absolute/path/dsh-plugin-task-notify-0.2.0.tgz
```

或在 DSH 的 **插件** 页面选择本地的 `dsh-plugin-task-notify-0.2.0.tgz`。插件声明了
`dsh.bundle.patch`，安装后会被加入 profile 的 bundle 列表。

### 手机端

1. 把 `DSH-Task-Notify-1.2.1.apk` 传到手机上，允许「安装未知来源应用」后安装。
2. 打开 App，允许通知权限。
3. 保持 App 打开一次，让前台服务启动；之后可以退到后台。
4. 点「发送测试」应能立即看到一条通知。
5. 手机和电脑需要连接同一个 Wi‑Fi（同一局域网）。

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

手机 IP 显示在 App 首页的地址栏里。修改手机端口或访问令牌后，点「保存并重启服务」。

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
      caFile: C:/path/to/cloud-ca.pem
      timeoutMs: 8000
```

`cloud` 配置后，插件会同时尝试局域网设备与云端；任一路成功即视为送达。只想要云端时把
`discover: false` 且不配置 `devices`。云端证书是自签名的，`caFile` 必须指向
`cloud/certs/ca.pem`（或部署时导出的 CA）。

`notifyOnApproval` 对应 DSH 的 `approval/asked` 事件，通知标题为「需要授权」，正文包含
工具名和原因；默认开启。

`notifyOn` 可取：`completed`、`error`、`aborted`、`blocked`、`max-tokens`、
`interrupted`、`forked`。默认只推 `completed` 和 `error`。

`devices` 也支持字符串写法：`"192.168.1.23"` 或 `"192.168.1.23:8765"`。

## 工具 `phone_notify`

插件挂载后会向当前 profile 注册一个诊断工具：

- `action: discover`：立即广播发现并 ping 手机，返回在线状态。
- `action: test`：发送一条固定测试通知。
- `action: send`：发送自定义 `title` / `body`。

可以直接对助手说：

> 用 phone_notify 测试一下手机通知。

工具会返回每台设备的 `name`、`host`、`port`、`online` 和错误原因。

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
`detailsLine()` 作为展开后的第二行。通知记录保存在手机本地（最多 50 条）。

## 故障排查

| 现象 | 处理 |
|---|---|
| `phone_notify discover` 找不到设备 | 确认手机 App 正在运行、与电脑同一 Wi‑Fi；关闭路由器的 AP 隔离/访客网络；允许 `DeepSeek Harness` 在 Windows 防火墙的专用网络访问；手机端换一个端口重试 |
| 能找到设备但发送失败 | 手机端「服务运行中」是否为绿色；端口是否被占用；是否有令牌不一致 |
| 锁屏收不到 | 关闭电池优化（App 首页「电池优化」）；检查系统通知权限、通知渠道是否被静音；部分国产 ROM 还需允许自启动/后台运行 |
| 发了通知但正文没有内容 | 检查 `includePreview`；错误回合的正文会显示错误信息 |
| 短回复不通知 | `minDurationMs` 默认为 15 秒且只过滤「无工具调用」的完成回合；改成 0 可全部通知 |
| Windows 防火墙提示 | 允许访问「专用网络」；UDP 8766 只用于自动发现，失败时可在插件配置里写死手机 IP |

## 安全与隐私

- 默认不经过第三方推送；启用 `cloud` 后通知只经你自己的服务器。
- 手机端默认不校验令牌，同一 Wi‑Fi 内任何设备都能向 8765 端口发通知。需要更强隔离时，
  在 App 和插件配置里设置同一个 `token`。
- 通知正文可能包含工作内容；`includePreview: false` 只发送标题与用时，不留正文预览。
- 手机端只监听本地网络，不提供文件读写、远程控制或回传通道。

## 卸载

1. 在 DSH 的插件页面移除 `dsh-plugin-task-notify`，或从 profile 的 `dependencies` /
   `dsh.profile.bundles` 中删除后重新安装依赖。
2. 手机上卸载「DSH 任务通知」。
3. 可选删除 `~/.dsh/storages/task-notify/` 下的诊断日志和设备缓存。

## 开发与测试

```bash
# 纯 JVM 测试手机端接收核心（HTTP / JSON / UDP 发现）
javac --release 11 -d build/jvm-classes src/... 
java -cp build/jvm-classes:build/test-classes com.dsh.tasknotify.ServerTest

# 用真实接收核心跑插件集成测试
java -cp ... com.dsh.tasknotify.RunServer 18765 18766 ...
node test/plugin-integration.mjs
```

APK 的完整可复现构建见仓库根目录的 `build-apk.ps1` 与 `使用说明.md`。
