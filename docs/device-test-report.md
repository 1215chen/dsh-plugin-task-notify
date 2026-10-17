# 真机测试报告

日期：2026-10-17  
设备：vivo V2154A（PD2154），Android 14 / API 34  
APK：`DSH-Task-Notify-1.2.0.apk`（versionCode 3，versionName 1.2.0，云端 + 授权通知）  
说明：网络/通知链路最初在 1.0.0 上验证；1.2.0 增加云端 SSE、自签名 CA、授权通知和 DSH 鲸鱼图标。
电脑：Windows，WLAN `Miwifi`，`192.168.1.100`  
手机：`Miwifi`，`192.168.1.23`（测试中曾自动切到 `huawei-super-wifi-5G` → `192.168.1.24`）

## 测试项与结果

| # | 测试 | 结果 | 证据 |
|---|---|---|---|
| 1 | ADB 安装 APK | 通过 | `dumpsys package` versionName 1.2.0 |
| 2 | 打开 App，前台服务启动 | 通过 | `dumpsys activity services`：`isForeground=true`，type `dataSync` |
| 3 | 通知权限 / 渠道 | 通过 | `POST_NOTIFICATIONS: granted=true`；渠道 `task_done` importance=4，声音/震动已配置 |
| 4 | `GET /ping`（电脑 → 手机） | 通过 | `HTTP 200 {"ok":true,"name":"V2154A","port":8765}` |
| 5 | 真实 DSH 插件自动发现 | 通过 | `plugin.log`：`discovery.found V2154A@192.168.1.23:8765` |
| 6 | 真实 DSH 插件投递测试通知 | 通过 | `plugin.log`：`deliver.ok`（`m_mvby0vww_f6968115`） |
| 7 | 通知中心显示 | 通过 | 真机观察（截图不公开） |
| 8 | 点按通知打开 App 并定位历史 | 通过 | `dumpsys window`：`MainActivity`；历史区可见 |
| 9 | App 通知页 / 设置页 | 通过 | 真机页面（截图不公开） |
| 10 | 熄屏 30 秒后 `/ping` | 通过（设置高耗电后） | 167ms；设置前超时 |
| 11 | 熄屏状态下插件投递 | 通过 | `deliver.ok`（`m_mvbyufzx_99a74322`），`dumpsys notification` 可见 |
| 12 | 重启后自启动 | 通过（有延迟） | 服务最终启动；需重新连回 `Miwifi` |
| 13 | vivo 后台冻结 | 复现并修复 | 见下节 |
| 14 | 19 项 JVM 接收核心测试 | 通过 | `RESULT passed=19 failed=0` |
| 15 | 6 项插件集成测试 | 通过 | `ALL PLUGIN TESTS PASSED` |
| 16 | 磁盘上的 0.2.0 工具直连真机 | 通过 | 返回 `ok=true`、`online=true`，字段通过声明 schema |
| 17 | 底部导航 / 页面切换 | 通过 | 通知 ↔ 设置，选中态正确 |
| 18 | 自绘 Switch 启停服务 | 通过 | 关闭后 `/ping` 失败；再开启后 `/ping` 200 |
| 19 | 圆角对话框 / 通知点击定位历史 | 通过 | 关于对话框正常；点通知打开通知页并滚动到历史 |
| 20 | 云端 SSE 连接 | 通过 | `https://YOUR_SERVER_IP:56159`，App 显示「云端已连接」 |
| 21 | 自签名 CA 校验 | 通过 | App 只信任内置 CA；错误 CA 无法连接 |
| 22 | 云端投递与离线队列 | 通过 | 插件 0.2.0 → 云中继 → 手机；队列 `Last-Event-ID` 补发 |
| 23 | 授权通知 | 通过 | `approval/asked` → 「需要授权」+ 锁图标 |
| 24 | DSH 图标 | 通过 | 自适应图标和白色鲸鱼通知小图标正常 |

## 关键发现 1：vivo 会冻结前台服务

未设置 vivo「允许后台高耗电」时：

- 锁屏约 30 秒后，电脑 `/ping` 超时。
- `dumpsys power`：`PARTIAL_WAKE_LOCK 'dsh-task-notify:receiver' DISABLED`。
- `dumpsys activity processes`：`isFrozen=true`，虽然 `mHasForegroundServices=true`。
- App 进程仍在，通知服务“看起来在运行”，但 socket 不响应。

修复：

```text
设置 → 电池 → 后台耗电管理 → DSH 任务通知 → 允许后台高耗电
设置 → 权限管理 → 自启动 → DSH 任务通知 → 开机启动/后台启动
```

修复后锁屏 30 秒 `/ping` 150–170ms 正常返回。

> 标准 Android「忽略电池优化」不足以阻止 vivo 冻结；必须使用厂商的「允许后台高耗电」。

## 关键发现 2：双频路由器可能换网段

重启手机后，手机自动连到了 `huawei-super-wifi-5G`，IP 变为 `192.168.1.24`；电脑仍在
`Miwifi` `192.168.1.100`。两个网段不通，插件发现/投递失败。

把手机手动连回 `Miwifi` 后 IP 恢复 `192.168.1.23`，一切正常。建议关闭系统的
「网络助理 / 自动切换网络」，或确认两端在同一 SSID/网段。

## 关键发现 3：当前 DSH 进程与插件版本

安装时 DSH 热加载的是旧版插件；磁盘上已是 0.2.0。

- 0.1.0 的核心回合结束通知可用，真实日志中已出现 `turn.notify`。
- 0.1.0 的 `phone_notify test/send` 会因输出字段名 `ok` vs `online` 校验失败，
  但**通知本身已经送达**（`deliver.ok` 与非空通知记录可证）。
- 直接加载磁盘上的 0.2.0 模块对真机调用 `phone_notify test`，返回
  `{"ok":true,"devices":[{"online":true,"error":""}]}`，输出 schema 正确、通知已送达。
- 重启 DSH 后加载 0.2.0，工具输出和云端/授权通知恢复正常。

## 原始证据

插件日志（节选）：

```json
{"message":"discovery.found","devices":["V2154A@192.168.1.23:8765"]}
{"message":"deliver.ok","status":"test","devices":[{"name":"V2154A","host":"192.168.1.23","port":8765,"ok":true}]}
{"message":"turn.notify","status":"completed","tools":145}
```

`last-delivery.json`：

```json
{"ok":true,"status":"test","devices":[{"name":"V2154A","host":"192.168.1.23","port":8765,"ok":true,"error":""}]}
```

## 结论

手机端 APK 在 vivo V2154A / Android 14 上可以正常安装、启动、接收、展示和点击通知；
电脑端插件可以发现并投递。必须完成 vivo 的两项后台设置，并保证手机与电脑在同一网段。
