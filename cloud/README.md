# 云端中继

自托管通知中继：DSH 插件把通知 POST 到云服务器，手机 App 通过 SSE 长连接接收。
不依赖 FCM、ntfy 或第三方推送服务，只走你自己的服务器。从零开始的完整步骤见
[../docs/setup.md](../docs/setup.md)。

这套部署实例使用 **NAT 高端口 + 自签名证书 + 证书指纹固定**，不需要域名，也不需要 80/443：

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
| 数据目录 | `/var/lib/dsh-notify`（状态文件仅服务用户可读） |
| 证书 | 自签名 CA 签发，服务器证书 SAN 为 IP `YOUR_SERVER_IP` |
| 信任方式 | 手机首次连接时确认叶子证书 SHA-256；插件填同一指纹（或 `caFile`） |

Token 不写进仓库文档。服务器上查看：

```bash
ssh -p <SSH_PORT> root@YOUR_SERVER_IP
grep '^TOKEN=' /etc/dsh-notify.env
```

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

云厂商安全组需要放行 **TCP 56159**；服务器 UFW 默认拒绝入站，也要显式放行：

```bash
ufw allow 56159/tcp
ufw status | grep 56159
```

SSH 使用 <SSH_PORT>，不要动。NAT 映射必须保持 **外网 56159 → 内网 56159**。
放行后如果手机仍超时，优先检查安全组、`ufw` 和 `iptables -S ufw-user-input`。

### 数据与队列

`/var/lib/dsh-notify/state.json` 保存每台设备最近 200 条通知，用于手机断线重连后按
`Last-Event-ID` 补发。删除该文件会清空离线队列，不影响 App 本地历史。

## 配置手机 App

设置 → 云端中继：

- 打开「启用云端通知」
- 服务器地址：`https://YOUR_SERVER_IP:56159`（只接受 https）
- 设备 ID：`vivo-v2154a`
- 访问令牌：`/etc/dsh-notify.env` 里的 `TOKEN`
- 点「保存并重启服务」

首次连接时 App 会显示服务器证书的 SHA-256，与下面命令的输出核对后点「信任并重连」：

```bash
openssl x509 -in /opt/dsh-notify/tls/server.pem -noout -fingerprint -sha256
```

首页状态卡会显示「云端已连接 · YOUR_SERVER_IP」。服务开关关闭时云端也会断开。

## 配置插件

推荐直接在 DSH 左侧栏「通知」面板填写（会自动写入 `settings.json` 并立即生效）。
需要写进 `cordis.patch.yml` 时：

```yaml
- id: task-notify
  name: dsh-plugin-task-notify
  config:
    cloud:
      url: https://YOUR_SERVER_IP:56159
      token: <TOKEN>
      device: vivo-v2154a
      fingerprint: AB:CD:EF:...   # 与手机确认的是同一个叶子证书指纹
      timeoutMs: 8000
```

`fingerprint` 与 `caFile` 二选一：

- `fingerprint`：推荐。插件在发送请求**之前**校验服务器证书的 SHA-256，不依赖证书链。
- `caFile`：用 CA 公钥做标准证书链校验，适合你有固定 CA 且希望按链校验的场景。

两者都留空时使用系统根证书；自签名中继会直接失败并提示「TLS 证书校验失败」。
插件会同时尝试局域网直连和云端；任一路成功即视为送达。只想要云端时把 `discover: false`
且不配置 `devices`。

## 新增/更换手机

1. 在服务器上不需要注册设备，设备 ID 由第一次 POST/SSE 自动创建。
2. App 里换一个设备 ID（`[A-Za-z0-9._-]`，1–64 字符），保存。
3. 在 DSH 左侧栏把「设备 ID」改成同一个值并保存；或改 `cloud.device` 后重启 DSH。

## 更换 IP 或证书

如果公网 IP 改变，服务器证书的 SAN 必须包含新 IP：

```bash
cd /opt/dsh-notify/tls
# 用新 IP 重新生成 server-key.pem / server.pem，CA 可以继续复用
openssl x509 -in server.pem -noout -fingerprint -sha256
```

- App：会提示「服务器证书已变化」，核对新指纹后点「信任新证书」。
- 插件：在左侧栏点「获取指纹」→「使用此指纹」→ 保存；或更新 `cloud.fingerprint`。

App 不需要重新打包。只更新一边会导致「指纹不匹配」。

## 安全说明

- 生产环境使用 HTTPS；App 已关闭明文流量，插件拒绝非回环 `http://` 地址。
- 自签名证书由手机和插件固定指纹校验，不是裸 HTTP。
- Token 是唯一访问凭证，泄露后任何人都能向该设备发通知；泄露时修改
  `/etc/dsh-notify.env` 的 `TOKEN`，重启服务，再更新 App 和插件。
- 服务器只监听 56159，SSH 保持 <SSH_PORT>；不要额外暴露 8787 等内部端口。
- 通知正文会保存在服务器队列和 App 历史中；敏感内容可设置 `includePreview: false`。
- 这是单用户自托管中继，没有多租户、审计或限流；不要公开给不可信用户使用。
