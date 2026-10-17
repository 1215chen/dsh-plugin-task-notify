# 云端中继

自托管通知中继：DSH 插件把通知 POST 到云服务器，手机 App 通过 SSE 长连接接收。
不依赖 FCM、ntfy 或第三方推送服务，只走你自己的服务器。从零开始的完整步骤见
[../docs/setup.md](../docs/setup.md)。

这套部署实例使用 **NAT 高端口 + 自签名证书 + App 内置 CA 校验**，不需要域名，也不需要
80/443：

```text
DSH 插件 ── HTTPS POST /api/v1/notify ──► 云服务器 :56159
                                             │
                                             ├─ 每台设备一个有界离线队列
                                             └─ SSE /api/v1/stream
                                                      │
手机 App ◄──────── HTTPS SSE（Last-Event-ID 续传）────┘
```

## 当前实例

| 项目 | 值 |
|---|---|
| 服务器 | Ubuntu 24.04.1 LTS |
| 地址 | `https://YOUR_SERVER_IP:56159` |
| NAT | 外网 TCP 56159 → 内网 TCP 56159 |
| 进程 | `dsh-notify-relay.service`（systemd，Node 22） |
| 设备 ID | `vivo-v2154a` |
| 数据目录 | `/var/lib/dsh-notify`（状态文件仅 root/服务用户可读） |
| 证书 | 自签名 CA，服务器证书 SAN 为 IP `YOUR_SERVER_IP` |
| CA 文件 | 本地 `cloud/certs/ca.pem`；服务器 `/opt/dsh-notify/tls/ca.pem` |
| 插件 CA | `C:/dsh/cloud-ca.pem`（插件配置 `cloud.caFile`） |
| App | 内置 `res/raw/dsh_cloud_ca.pem`，只信任这张 CA |

Token 不写进仓库文档。服务器上查看：

```bash
ssh -p <SSH_PORT> root@YOUR_SERVER_IP
grep '^TOKEN=' /etc/dsh-notify.env
```

本地 `_deploy/cloud.env` 也有同一份（不要提交或公开）。

## 服务器运维

```bash
systemctl status dsh-notify-relay
journalctl -u dsh-notify-relay -f
systemctl restart dsh-notify-relay

# 本机健康检查（证书 SAN 是公网 IP，用 --resolve 指到 127.0.0.1）
curl --cacert /opt/dsh-notify/tls/ca.pem \
  --resolve YOUR_SERVER_IP:56159:127.0.0.1 \
  https://YOUR_SERVER_IP:56159/api/v1/health
```

健康检查返回 `clients`（当前 SSE 连接数）、`devices`、`queued`。手机 App 云端已连接时
`clients` 应该是 1。

### 端口

云厂商安全组需要放行 **TCP 56159**；服务器本机 UFW 当前未启用。SSH 使用 <SSH_PORT>，不要动。
NAT 映射必须保持 **外网 56159 → 内网 56159**。

### 数据与队列

`/var/lib/dsh-notify/state.json` 保存每台设备最近 200 条通知，用于手机断线重连后按
`Last-Event-ID` 补发。删除该文件会清空离线队列，不影响 App 本地历史。

## 配置手机 App

设置 → 云端中继：

- 打开「启用云端通知」
- 服务器地址：`https://YOUR_SERVER_IP:56159`
- 设备 ID：`vivo-v2154a`
- 访问令牌：`/etc/dsh-notify.env` 里的 `TOKEN`
- 点「保存并重启服务」

首页状态卡会显示「云端已连接 · YOUR_SERVER_IP」。服务开关关闭时云端也会断开。

## 配置插件

`cordis.patch.yml` 中 `task-notify` 的配置：

```yaml
- id: task-notify
  name: dsh-plugin-task-notify
  config:
    cloud:
      url: https://YOUR_SERVER_IP:56159
      token: <TOKEN>
      device: vivo-v2154a
      caFile: C:/dsh/cloud-ca.pem
      timeoutMs: 8000
```

插件会同时尝试局域网直连和云端；任一路成功即视为送达。只想要云端时把 `discover: false`
且不配置 `devices`。

## 新增/更换手机

1. 在服务器上不需要注册设备，设备 ID 由第一次 POST/SSE 自动创建。
2. App 里换一个设备 ID（`[A-Za-z0-9._-]`，1–64 字符），保存。
3. 插件 `cloud.device` 改成同一个 ID。
4. 重新打包插件配置并重启 DSH。

## 更换 IP 或证书

如果公网 IP 改变，服务器证书的 SAN 必须包含新 IP，App 和插件也要换新地址/CA：

```bash
cd /opt/dsh-notify/tls
# 用新 IP 重新生成 server-key.pem / server.pem，CA 可以继续复用
```

App 内置 CA 不变时只需改服务器地址；证书更换后需要重新打包 APK 并更新插件 `caFile`。

## 安全说明

- 生产环境使用 HTTPS；自签名证书由 App/插件固定校验，不是裸 HTTP。
- Token 是唯一访问凭证，泄露后任何人都能向该设备发通知；泄露时修改
  `/etc/dsh-notify.env` 的 `TOKEN`，重启服务，再更新 App 和插件。
- 服务器只监听 56159，SSH 保持 <SSH_PORT>；不要额外暴露 8787 等内部端口。
- 通知正文会保存在服务器队列和 App 历史中；敏感内容可设置 `includePreview: false`。
- 这是单用户自托管中继，没有多租户、审计或限流；不要公开给不可信用户使用。
