# dsh-plugin-task-notify

Push a notification to a paired Android phone when a DSH task turn ends.

The companion Android app (`DSH-Task-Notify-1.2.1.apk`) runs a small LAN
receiver and posts a high-priority notification. No cloud service, account or
third-party push provider is involved.

- Watches live `session/event` turn boundaries; ignores subagent turns by default.
- Finds the phone with a UDP broadcast, so no IP address is usually needed.
- Optional bearer token, status filter, minimum duration, per-session cooldown.
- Registers a `phone_notify` tool for connectivity tests and custom messages.

## Install

```bash
dsh plugin --profile desktop add /absolute/path/dsh-plugin-task-notify-0.2.0.tgz
```

The package declares `dsh.bundle.patch`, so the desktop profile loads it as a
bundle. Install the APK on the phone and open it once; keep both devices on the
same Wi-Fi.

## Configure

Override the `task-notify` entry in the profile's `cordis.patch.yml`:

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
```

See [README.zh.md](README.zh.md) for the complete field reference, payload,
security notes and troubleshooting.

## Tool

`phone_notify` actions: `discover`, `test`, `send` (with optional `title` and
`body`). Results list every device with `online` and an error string.

## Requirements

- DSH desktop profile (host-side plugin).
- Android 8.0+ (API 26), same LAN as the DSH host.
- Node.js 22+ (uses only Node built-ins).

## License

MIT
