# 完整配置过程

这份文档按实际部署顺序，从一台全新 Ubuntu 24.04 云服务器开始，到手机收到局域网/云端通知为止。
当前实例的地址是 `https://YOUR_SERVER_IP:56159`，使用 NAT 高端口和自签名证书，不需要域名、
80 或 443。

> 不要把 `TOKEN`、`apk/keystore/*.p12`、`/opt/dsh-notify/tls/*key.pem` 提交到 Git 仓库。

## 0. 架构与端口

```text
DSH 插件
  ├─ 局域网：UDP 8766 发现 + HTTP 8765 POST /notify
  └─ 云端：HTTPS POST https://<服务器>:56159/api/v1/notify
                         │
                         ▼
                  云中继（Node + systemd）
                  每设备最近 200 条离线队列
                         │
                         ▼
手机 App ── HTTPS SSE /api/v1/stream ── 通知 + 本地历史
```

| 端口 | 用途 | 暴露范围 |
|---|---|---|
| 56159/TCP | 云端中继 HTTPS | 公网 → 服务器 56159 |
| <SSH_PORT>/TCP | SSH（本实例） | 仅管理端 |
| 8765/TCP | 局域网 HTTP | 仅同一 Wi-Fi |
| 8766/UDP | 局域网发现 | 仅同一 Wi-Fi |

## 1. 云服务器

### 1.1 前提

- Ubuntu 24.04 LTS，root 或可 sudo 用户
- 云厂商安全组/NAT 放行 **TCP 56159**
- 服务器能访问外网（下载 Node、安装依赖）
- 服务器时间正确（TLS 证书校验依赖时间）

本实例没有安装 Docker/Caddy：NAT 场景直接用 Node 终止 TLS，内存占用更低。

### 1.2 安装 Node.js 22

```bash
apt-get update -qq
apt-get install -y curl ca-certificates xz-utils tar openssl

cd /tmp
curl -fsSLO https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
NODE_FILE="$(awk '/linux-x64.tar.xz/ {print $2; exit}' SHASUMS256.txt)"
curl -fsSLO "https://nodejs.org/dist/latest-v22.x/${NODE_FILE}"
mkdir -p /opt
tar -xJf "${NODE_FILE}" -C /opt
ln -sfn "/opt/${NODE_FILE%.tar.xz}" /opt/node-v22
ln -sfn /opt/node-v22/bin/node /usr/local/bin/node
ln -sfn /opt/node-v22/bin/npm /usr/local/bin/npm

node --version   # v22.x
```

### 1.3 生成 CA 和服务器证书

服务器证书的 SAN 必须包含客户端实际连接使用的地址。本实例用 IP：

```bash
mkdir -p /opt/dsh-notify/tls
cd /opt/dsh-notify/tls

openssl genrsa -out ca-key.pem 4096
openssl req -x509 -new -nodes -key ca-key.pem -sha256 -days 3650 \
  -subj "/CN=DSH Task Notify Cloud CA" -out ca.pem

openssl genrsa -out server-key.pem 2048
openssl req -new -key server-key.pem -subj "/CN=YOUR_SERVER_IP" -out server.csr
cat > server.ext <<'EOF'
subjectAltName=IP:YOUR_SERVER_IP,DNS:YOUR_SERVER_IP.sslip.io
extendedKeyUsage=serverAuth
keyUsage=digitalSignature,keyEncipherment
EOF

openssl x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -out server.pem -days 3650 -sha256 -extfile server.ext

chmod 600 ca-key.pem server-key.pem
```

把 **公钥** `ca.pem` 复制到项目 `cloud/certs/ca.pem`，并内置到 App 的
`apk/res/raw/dsh_cloud_ca.pem`；私钥只留在服务器。

如果公网 IP 改变，需要重新生成 `server.pem/server-key.pem`（SAN 改成新 IP），并更新 App 的
服务器地址；CA 可以继续复用时，App 不需要重新内置 CA。

### 1.4 安装中继文件

```bash
id -u dsh-notify >/dev/null 2>&1 || \
  useradd --system --home /opt/dsh-notify --shell /usr/sbin/nologin dsh-notify
mkdir -p /opt/dsh-notify /var/lib/dsh-notify
chown -R dsh-notify:dsh-notify /opt/dsh-notify /var/lib/dsh-notify
```

把 `cloud/server.mjs` 和 `cloud/package.json` 上传到 `/opt/dsh-notify/`，然后创建
`/etc/dsh-notify.env`（权限 600）：

```ini
TOKEN=<openssl rand -hex 32 的结果>
PORT=56159
HOST=0.0.0.0
DATA_DIR=/var/lib/dsh-notify
TLS_CERT=/opt/dsh-notify/tls/server.pem
TLS_KEY=/opt/dsh-notify/tls/server-key.pem
MAX_QUEUE=200
HEARTBEAT_MS=20000
```

```bash
chmod 600 /etc/dsh-notify.env
chown -R dsh-notify:dsh-notify /opt/dsh-notify /var/lib/dsh-notify
```

### 1.5 systemd

安装 `cloud/dsh-notify-relay.service` 到 `/etc/systemd/system/`：

```bash
systemctl daemon-reload
systemctl enable --now dsh-notify-relay
systemctl --no-pager status dsh-notify-relay
journalctl -u dsh-notify-relay -f
```

服务只监听 `0.0.0.0:56159`，由 NAT 暴露；不要再额外开放 8787。

### 1.6 验证服务器

```bash
curl --cacert /opt/dsh-notify/tls/ca.pem \
  --resolve YOUR_SERVER_IP:56159:127.0.0.1 \
  https://YOUR_SERVER_IP:56159/api/v1/health
```

应返回：

```json
{"ok":true,"app":"dsh-task-notify-relay","clients":0,"devices":0,"queued":0}
```

从公网测试时，CA 文件用项目里的 `cloud/certs/ca.pem`：

```bash
curl --cacert cloud/certs/ca.pem https://YOUR_SERVER_IP:56159/api/v1/health
```

> Windows 自带 `curl.exe` 使用 Schannel，可能不接受 `--cacert`；用 Node/Java 或 WSL 测试更可靠。

### 1.7 NAT / 防火墙

- 云控制台：外网 TCP 56159 → 内网 TCP 56159
- 服务器 UFW 可以不启用，但不要额外放行其他端口
- SSH <SSH_PORT> 只给自己使用

## 2. 插件配置

### 2.1 安装

```powershell
.\build-apk.cmd   # 只有改 APK 时才需要
# 插件包在 release\dsh-plugin-task-notify-0.2.0.tgz
```

Profile 的 `package.json`：

```json
"dependencies": {
  "dsh-plugin-task-notify": "file:vendor/dsh-plugin-task-notify-0.2.0.tgz"
}
```

把 tarball 放到 profile 的 `vendor\`，安装到 `node_modules\`，并确认
`dsh.profile.bundles` 包含 `dsh-plugin-task-notify`。

### 2.2 云端配置

在 profile 的 `cordis.patch.yml` 追加：

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

`caFile` 必须是服务器 `ca.pem` 的本地副本；Windows 路径建议用正斜杠，避免 YAML 转义问题。
如果只走云端：

```yaml
    discover: false
    devices: []
```

局域网和云端可以同时开启，任一路成功即视为送达。

### 2.3 重启 DSH

插件在 DSH 启动时加载。安装 0.2.0 后必须**重启一次 DSH**：

- 云端发送
- `approval/asked` 授权通知
- `phone_notify` 的 `online` 输出修复

才会由运行中的进程使用。

验证日志：

```text
%USERPROFILE%\.dsh\storages\task-notify\plugin.log
```

应能看到 `plugin.loaded` 中 `cloud` 字段，以及 `cloud.ok` / `approval.notify`。

## 3. 手机 App

### 3.1 安装

```powershell
adb install -r release\DSH-Task-Notify-1.2.0.apk
```

允许通知权限；vivo/iQOO 还要设置：

1. 设置 → 电池 → 后台耗电管理 → DSH 任务通知 → 允许后台高耗电
2. 设置 → 权限管理 → 自启动 → 打开开机启动/后台启动

### 3.2 云端配置

设置 → 云端中继：

- 打开「启用云端通知」
- 服务器地址：`https://YOUR_SERVER_IP:56159`
- 设备 ID：`vivo-v2154a`
- 访问令牌：服务器 `/etc/dsh-notify.env` 的 `TOKEN`
- 保存并重启服务

首页状态卡显示「云端已连接 · YOUR_SERVER_IP」即成功。令牌输入框是密码类型，不会显示明文。

### 3.3 局域网（可选）

同一 Wi-Fi 下打开「接收服务」即可，无需填写电脑 IP；插件通过 UDP 8766 自动发现。
如果路由器隔离广播，在插件配置里写死手机 IP 和端口 8765。

## 4. 端到端测试

```bash
# 插件侧
node cloud/test-plugin.mjs   # 需要设置 RELAY_URL/RELAY_TOKEN/RELAY_DEVICE/RELAY_CA
```

或直接在 DSH 中触发一轮任务，然后检查：

- 手机通知中心出现「任务完成」
- App「最近通知」有记录
- 云端 `/api/v1/health` 的 `clients` 为 1
- DSH 触发授权请求时出现「需要授权」和锁图标

## 5. 日常运维

```bash
systemctl restart dsh-notify-relay
journalctl -u dsh-notify-relay -n 100 --no-pager
```

- 离线队列：`/var/lib/dsh-notify/state.json`（最近 200 条/设备）
- 清空队列：停止服务，删除该文件，再启动
- 健康检查：`/api/v1/health`
- 不要把 `/var/lib/dsh-notify` 或 `/opt/dsh-notify/tls` 提交到 Git

## 6. 令牌/证书轮换

令牌：

```bash
# 修改 /etc/dsh-notify.env 的 TOKEN
systemctl restart dsh-notify-relay
# 更新 App 的访问令牌；更新插件的 cloud.token；重启 DSH
```

证书：

```bash
# 用新 IP/域名重新生成 server.pem/server-key.pem，保留或重建 CA
# 若 CA 改变：重新内置 apk/res/raw/dsh_cloud_ca.pem 并重新打包 APK；
# 插件 caFile 指向新 CA；重启 relay/App/DSH
```

## 7. 新增手机

1. 服务器不需要注册设备，第一次 POST/SSE 会自动创建。
2. App 填新的设备 ID（字母/数字/点/下划线/短横线，1–64 字符）。
3. 插件 `cloud.device` 改成同一个 ID。
4. 重启 App 服务和 DSH。

局域网发现允许多台手机；云端按设备 ID 路由，每台手机一个队列。
