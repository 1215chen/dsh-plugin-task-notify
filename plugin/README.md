# dsh-plugin-task-notify

Push a notification to a paired Android phone when a DSH turn ends or a tool asks for
approval. The plugin also adds a **Notifications** panel to the DSH left sidebar, so the LAN
token and the cloud relay settings can be edited without touching YAML.

The companion Android app (`DSH-Task-Notify-1.2.2.apk`) runs a small LAN receiver and posts a
high-priority notification. No cloud service, account or third-party push provider is involved.

- Watches live `session/event` turn boundaries and `approval/asked`; ignores subagent turns by default.
- Finds the phone with a UDP broadcast, so no IP address is usually needed.
- Optional bearer token, status filter, minimum duration, per-session cooldown.
- Cloud relay with a pinned certificate fingerprint (or CA file); plain `http://` is refused.
- Registers a `phone_notify` tool for connectivity tests and custom messages.
- Sidebar panel for the LAN token, relay URL/device/token/fingerprint, connection check and test notification.

## Install

```bash
dsh plugin --profile desktop add /absolute/path/dsh-plugin-task-notify-1.2.2.tgz
```

The package declares `dsh.bundle.patch` and `dsh.client`, so the desktop profile loads both the
host half and the browser panel. Restart DSH after installing; the sidebar entry appears in the
left column.

## Configure

The sidebar panel writes `~/.dsh/storages/task-notify/settings.json`, which overrides the
`task-notify` entry in the profile's `cordis.patch.yml` for the connection fields. Everything
else stays in the patch:

```yaml
- id: task-notify
  config:
    discover: true
    notifyOn: [completed, error]
    minDurationMs: 15000
    devices:
      - host: 192.168.1.23
        port: 8765
        name: My Phone
    cloud:
      url: https://relay.example.com:56159
      token: <TOKEN>
      device: my-phone
      fingerprint: ""   # 64 hex chars; recommended for a self-signed relay
      caFile: ""        # alternative: a CA PEM file
```

`fingerprint` pins the leaf certificate; `caFile` validates the chain; leaving both empty uses
the system trust store (so a public CA works, a self-signed relay does not).

See [README.zh.md](README.zh.md) for the complete field reference, the sidebar panel, the local
HTTP API, payloads, security notes and troubleshooting.

## Tool

`phone_notify` actions: `discover`, `test`, `send` (with optional `title` and `body`). Results
list every device with `online` and an error string.

## Requirements

- DSH desktop profile (host-side plugin; the panel needs the `webServer` service).
- Android 8.0+ (API 26), same LAN as the DSH host for the LAN channel.
- Node.js 22+ (uses only Node built-ins).

## License

MIT
