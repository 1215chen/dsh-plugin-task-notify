/**
 * dsh-plugin-task-notify — browser half.
 *
 * Registers a left-sidebar entry (「通知」) and its settings page. The page is a
 * plain React module so the plugin needs no build step: the DSH client module
 * loader evaluates this file as-is and hands it `react`.
 *
 * All reads and writes go to the host half's loopback-only routes under
 * `/dsh-task-notify/*`; secrets never leave this machine.
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-task-notify",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const PANEL_ID = "task-notify";
    const API = {
      state: "/dsh-task-notify/state",
      settings: "/dsh-task-notify/settings",
      test: "/dsh-task-notify/test",
      probe: "/dsh-task-notify/probe",
      fingerprint: "/dsh-task-notify/fingerprint",
    };

    const CSS = `
.dtn-page{--dtn-fg:var(--dsw-alias-label-primary,#e8eaed);--dtn-fg2:var(--dsw-alias-label-secondary,#a8adb5);--dtn-line:var(--dsw-alias-border-l2,rgba(255,255,255,.1));--dtn-card:var(--dsw-alias-bg-l1,rgba(255,255,255,.035));--dtn-accent:var(--dsw-alias-state-business-primary,#7c9dff);--dtn-ok:#3ecf8e;--dtn-warn:#e5b567;--dtn-bad:#f87171;color:var(--dtn-fg);height:100%;overflow:auto;padding:28px 32px 64px;box-sizing:border-box;font-size:13px;line-height:1.6}
.dtn-inner{max-width:880px;margin:0 auto}
.dtn-head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.dtn-head .dtn-spacer{flex:1}
.dtn-title{font-size:22px;font-weight:600;letter-spacing:.01em;margin:0}
.dtn-ver{font-size:11px;color:var(--dtn-fg2);border:1px solid var(--dtn-line);border-radius:999px;padding:1px 8px}
.dtn-sub{color:var(--dtn-fg2);margin:0 0 22px}
.dtn-card{background:var(--dtn-card);border:1px solid var(--dtn-line);border-radius:14px;padding:18px 20px;margin-bottom:16px}
.dtn-card h2{font-size:14px;font-weight:600;margin:0 0 4px}
.dtn-card .dtn-hint{color:var(--dtn-fg2);font-size:12px;margin:2px 0 14px}
.dtn-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.dtn-row+.dtn-row{margin-top:10px}
.dtn-field{display:flex;flex-direction:column;gap:5px;flex:1 1 260px;min-width:220px}
.dtn-label{font-size:12px;color:var(--dtn-fg2)}
.dtn-input{background:rgba(0,0,0,.16);border:1px solid var(--dtn-line);border-radius:8px;color:inherit;font:inherit;padding:7px 10px;outline:none;width:100%;box-sizing:border-box}
.dtn-input:focus{border-color:var(--dtn-accent)}
.dtn-input[disabled]{opacity:.55}
select.dtn-input{appearance:auto}
.dtn-btn{border:1px solid var(--dtn-line);background:rgba(255,255,255,.04);color:inherit;font:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;white-space:nowrap}
.dtn-btn:hover{background:rgba(255,255,255,.08)}
.dtn-btn:disabled{opacity:.5;cursor:default}
.dtn-btn.primary{background:var(--dtn-accent);border-color:transparent;color:#0b1020;font-weight:600}
.dtn-btn.primary:hover{filter:brightness(1.06)}
.dtn-btn.ghost{border-color:transparent;background:transparent;color:var(--dtn-fg2)}
.dtn-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.dtn-switch input{appearance:none;width:36px;height:20px;border-radius:999px;background:rgba(255,255,255,.16);position:relative;cursor:pointer;outline:none;transition:background .15s}
.dtn-switch input:checked{background:var(--dtn-accent)}
.dtn-switch input::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.dtn-switch input:checked::after{transform:translateX(16px)}
.dtn-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.dtn-status{display:flex;gap:16px;flex-wrap:wrap;color:var(--dtn-fg2);font-size:12px}
.dtn-status b{color:var(--dtn-fg);font-weight:500}
.dtn-devices{margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.dtn-devices li{display:flex;gap:8px;align-items:center;font-size:12px}
.dtn-fp{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;word-break:break-all;color:var(--dtn-fg2);background:rgba(0,0,0,.16);border-radius:8px;padding:7px 9px;margin-top:6px}
.dtn-banner{border-radius:10px;padding:8px 12px;font-size:12px;margin:0 0 12px;border:1px solid transparent}
.dtn-banner.err{background:rgba(248,113,113,.1);border-color:rgba(248,113,113,.35);color:#fca5a5}
.dtn-banner.ok{background:rgba(62,207,142,.1);border-color:rgba(62,207,142,.3);color:#6ee7b7}
.dtn-banner.info{background:rgba(124,157,255,.1);border-color:rgba(124,157,255,.3);color:#a5b8ff}
.dtn-foot{display:flex;gap:10px;align-items:center;margin-top:16px;padding:12px 0 0;border-top:1px solid var(--dtn-line)}
.dtn-foot .dtn-spacer{flex:1}
.dtn-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12px;color:var(--dtn-fg2);margin-top:8px}
.dtn-kv b{color:var(--dtn-fg);font-weight:500}
.dtn-sep{height:1px;background:var(--dtn-line);margin:16px 0}
.dtn-inline{display:flex;gap:8px;align-items:center}
.dtn-inline .dtn-input{flex:1 1 auto;min-width:0}
.dtn-mono{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
`;

    function ensureStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-plugin-css="dsh-plugin-task-notify/panel.css"]')) return;
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-plugin-task-notify";
      tag.dataset.pluginCss = "dsh-plugin-task-notify/panel.css";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    async function request(url, options) {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        ...options,
      });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok || body?.ok === false) {
        const message = body?.error || `HTTP ${response.status}`;
        throw new Error(message);
      }
      return body;
    }

    function randomToken() {
      const bytes = new Uint8Array(18);
      if (window.crypto?.getRandomValues) window.crypto.getRandomValues(bytes);
      else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }

    /** Format a possibly colon-separated fingerprint as AA:BB:… */
    function formatFingerprint(value) {
      const hex = String(value || "").toLowerCase().replace(/^sha256[:=]\s*/, "").replace(/[^0-9a-f]/g, "");
      if (hex.length !== 64) return String(value || "");
      return (hex.match(/.{2}/g) || []).join(":").toUpperCase();
    }

    function deviceOnline(device) {
      if (device.online === true || device.online === false) return device.online;
      if (device.ok === true || device.ok === false) return device.ok;
      return undefined;
    }

    function statusTone(ok) {
      return { color: ok ? "var(--dtn-ok)" : "var(--dtn-bad)" };
    }

    function Banner({ kind, children }) {
      return h("div", { className: `dtn-banner ${kind}` }, children);
    }

    function Field({ label, hint, children }) {
      return h("div", { className: "dtn-field" },
        h("span", { className: "dtn-label" }, label),
        children,
        hint ? h("span", { className: "dtn-hint", style: { margin: 0 } }, hint) : null);
    }

    function Toggle({ checked, onChange, label, disabled }) {
      return h("label", { className: "dtn-switch" },
        h("input", { type: "checkbox", checked: !!checked, disabled: !!disabled, onChange: (event) => onChange(event.target.checked) }),
        h("span", null, label));
    }

    function DeviceList({ devices }) {
      if (!devices || devices.length === 0) return h("div", { className: "dtn-hint" }, "还没有发现手机；点「检查连接」重新广播发现。");
      return h("ul", { className: "dtn-devices" }, devices.map((device, index) => {
        const online = deviceOnline(device);
        return h("li", { key: `${device.host}:${device.port}:${index}` },
          h("span", { className: "dtn-dot", style: { background: online === false ? "var(--dtn-bad)" : online === true ? "var(--dtn-ok)" : "var(--dtn-fg2)" } }),
          h("b", { style: { fontWeight: 500 } }, device.name || device.host),
          h("span", { className: "dtn-mono" }, `${device.host}:${device.port}`),
          device.error ? h("span", { style: { color: "var(--dtn-bad)" } }, `（${device.error}）`) : null);
      }));
    }

    function NotifyIcon({ size = 18, active }) {
      return h("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: active ? 1.9 : 1.7,
        strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
      },
      h("path", { d: "M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" }),
      h("path", { d: "M10.3 20a1.9 1.9 0 0 0 3.4 0" }));
    }

    function Panel() {
      const [state, setState] = React.useState(null);
      const [loadError, setLoadError] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const [notice, setNotice] = React.useState(null);
      const [devices, setDevices] = React.useState(null);
      const [showToken, setShowToken] = React.useState(false);
      const [showCloudToken, setShowCloudToken] = React.useState(false);
      const [form, setForm] = React.useState(null);
      const [dirty, setDirty] = React.useState(false);
      const [fpInfo, setFpInfo] = React.useState(null);

      const applyState = React.useCallback((next) => {
        setState(next);
        setForm({
          token: next.lan?.token ?? "",
          cloudEnabled: !!next.cloud?.enabled,
          url: next.cloud?.url ?? "",
          device: next.cloud?.device ?? "my-phone",
          cloudToken: next.cloud?.token ?? "",
          fingerprint: next.cloud?.fingerprint ?? "",
          caFile: next.cloud?.caFile ?? "",
        });
        setDirty(false);
      }, []);

      const refresh = React.useCallback(async () => {
        try {
          const next = await request(API.state);
          applyState(next);
          setLoadError("");
        } catch (error) {
          setLoadError(String(error.message || error));
        }
      }, [applyState]);

      React.useEffect(() => {
        ensureStyles();
        refresh();
      }, [refresh]);

      const update = (patch) => {
        setForm((prev) => ({ ...prev, ...patch }));
        setDirty(true);
        setNotice(null);
      };

      const save = async () => {
        if (!form) return;
        setBusy("save");
        setNotice(null);
        try {
          const next = await request(API.settings, {
            method: "POST",
            body: JSON.stringify({
              token: form.token,
              cloud: {
                enabled: !!form.cloudEnabled,
                url: form.url,
                device: form.device || "my-phone",
                token: form.cloudToken,
                fingerprint: form.fingerprint,
                caFile: form.caFile,
              },
            }),
          });
          applyState(next);
          setNotice({ kind: "ok", text: "设置已保存，下一次通知就会使用新配置。" });
        } catch (error) {
          setNotice({ kind: "err", text: `保存失败：${error.message}` });
        } finally {
          setBusy("");
        }
      };

      const sendTest = async () => {
        setBusy("test");
        setNotice(null);
        try {
          const result = await request(API.test, { method: "POST" });
          const delivered = (result.devices || []).filter((device) => device.ok);
          if (result.ok) {
            setNotice({ kind: "ok", text: `测试通知已送达 ${delivered.length} 台设备：${delivered.map((device) => `${device.name} ${device.host}:${device.port}`).join("；")}` });
          } else {
            setNotice({ kind: "err", text: `发送失败：${(result.devices || []).map((device) => `${device.name}（${device.error || "未知原因"}）`).join("；") || "没有可用设备"}` });
          }
          setDevices(result.devices || []);
        } catch (error) {
          setNotice({ kind: "err", text: `发送失败：${error.message}` });
        } finally {
          setBusy("");
        }
      };

      const probe = async () => {
        setBusy("probe");
        setNotice(null);
        try {
          const result = await request(API.probe, { method: "POST" });
          setDevices(result.devices || []);
          setNotice({ kind: "info", text: `检查完成：${(result.devices || []).filter((device) => device.online).length}/${(result.devices || []).length} 台设备在线。` });
          if (!dirty) refresh();
        } catch (error) {
          setNotice({ kind: "err", text: `检查失败：${error.message}` });
        } finally {
          setBusy("");
        }
      };

      const fetchFingerprint = async () => {
        if (!form?.url) {
          setNotice({ kind: "err", text: "先填写云端服务器地址。" });
          return;
        }
        setBusy("fp");
        setFpInfo(null);
        setNotice(null);
        try {
          const info = await request(API.fingerprint, { method: "POST", body: JSON.stringify({ url: form.url }) });
          setFpInfo(info);
          setNotice({ kind: "info", text: "已读取服务器证书。请与手机 App 显示的指纹核对后再保存。" });
        } catch (error) {
          setNotice({ kind: "err", text: `读取证书失败：${error.message}` });
        } finally {
          setBusy("");
        }
      };

      if (loadError) {
        return h("div", { className: "dtn-page" }, h("div", { className: "dtn-inner" },
          h("h1", { className: "dtn-title" }, "任务通知"),
          h(Banner, { kind: "err" }, `无法读取插件状态：${loadError}。请确认插件已安装并重启 DSH。`)));
      }

      if (!state || !form) {
        return h("div", { className: "dtn-page" }, h("div", { className: "dtn-inner" },
          h("div", { className: "dtn-sub" }, "正在读取配置…")));
      }

      const last = state.runtime?.lastDelivery;
      const lastOk = last?.ok === true;
      const lanDevices = devices || (state.lan?.discovered || []).map((device) => ({ ...device, online: true }));
      const cloudError = state.cloud?.error || "";

      return h("div", { className: "dtn-page" }, h("div", { className: "dtn-inner" },
        h("div", { className: "dtn-head" },
          h("h1", { className: "dtn-title" }, "任务通知"),
          h("span", { className: "dtn-ver" }, `v${state.version || "1.2.2"}`),
          h("span", { className: "dtn-spacer" }),
          h("button", {
            className: "dtn-btn primary",
            disabled: busy !== "" || !dirty,
            onClick: save,
          }, busy === "save" ? "保存中…" : dirty ? "保存设置" : "已保存")),
        h("p", { className: "dtn-sub" }, "DSH 每轮任务结束、失败或需要授权时，把结果推送到安卓手机。局域网直连与云端中继可以同时开启。"),

        notice ? h(Banner, { kind: notice.kind }, notice.text) : null,
        cloudError ? h(Banner, { kind: "err" }, `云端：${cloudError}`) : null,

        h("section", { className: "dtn-card" },
          h("h2", null, "运行状态"),
          h("div", { className: "dtn-status" },
            h("span", null, "接收服务 ", h("b", null, (state.lan?.discovered?.length ?? 0) > 0 ? "已发现手机" : "等待手机")),
            h("span", null, "云端 ", h("b", null, form.cloudEnabled ? (cloudError ? "异常" : "已启用") : "未启用")),
            h("span", null, "最近投递 ", h("b", { style: statusTone(lastOk) }, last ? `${lastOk ? "成功" : "失败"} · ${new Date(last.sentAt || Date.now()).toLocaleString()}` : "还没有"))),
          h("div", { className: "dtn-sep" }),
          h(DeviceList, { devices: lanDevices }),
          h("div", { className: "dtn-row" },
            h("button", { className: "dtn-btn", disabled: busy !== "", onClick: probe }, busy === "probe" ? "检查中…" : "检查连接"),
            h("button", { className: "dtn-btn", disabled: busy !== "", onClick: sendTest }, busy === "test" ? "发送中…" : "发送测试通知"))),

        h("section", { className: "dtn-card" },
          h("h2", null, "局域网"),
          h("p", { className: "dtn-hint" }, `手机与电脑在同一 Wi-Fi 时，插件通过 UDP ${state.lan?.discoveryPort || 8766} 自动发现手机，HTTP 走 ${state.lan?.port || 8765}。手机 App 里留空表示不校验令牌；两端填同一个非空令牌后，陌生设备就无法向手机投递通知。`),
          h("div", { className: "dtn-row" },
            h(Field, { label: "访问令牌（可选）" },
              h("div", { className: "dtn-inline" },
                h("input", {
                  className: "dtn-input dtn-mono",
                  type: showToken ? "text" : "password",
                  value: form.token,
                  placeholder: "留空表示不校验",
                  autoComplete: "off",
                  onChange: (event) => update({ token: event.target.value }),
                }),
                h("button", { className: "dtn-btn ghost", onClick: () => setShowToken((value) => !value) }, showToken ? "隐藏" : "显示"),
                h("button", { className: "dtn-btn", onClick: () => { update({ token: randomToken() }); setShowToken(true); } }, "生成")))),
          state.lan?.configured?.length
            ? h("div", { className: "dtn-kv" },
              h("span", null, "手动设备"),
              h("b", null, state.lan.configured.map((device) => `${device.name} ${device.host}:${device.port}`).join("；")))
            : null),

        h("section", { className: "dtn-card" },
          h("h2", null, "云端中继"),
          h("p", { className: "dtn-hint" }, "手机和电脑不在同一网络时使用。只接受 https://（本机回环地址除外），令牌不会明文上网。首次连接需要在手机 App 里信任服务器证书指纹。"),
          h("div", { className: "dtn-row" },
            h(Toggle, { checked: form.cloudEnabled, onChange: (value) => update({ cloudEnabled: value }), label: form.cloudEnabled ? "已启用" : "未启用" }),
            h("span", { className: "dtn-hint", style: { margin: 0 } }, "启用后插件会同时尝试局域网与云端，任一路成功即视为送达。")),
          h("div", { className: "dtn-row", style: { marginTop: 14 } },
            h(Field, { label: "服务器地址" },
              h("input", {
                className: "dtn-input dtn-mono",
                value: form.url,
                placeholder: "https://1.2.3.4:56159",
                onChange: (event) => { update({ url: event.target.value }); setFpInfo(null); },
              }))),
          h("div", { className: "dtn-row" },
            h(Field, { label: "设备 ID" },
              h("input", {
                className: "dtn-input dtn-mono",
                value: form.device,
                placeholder: "my-phone",
                onChange: (event) => update({ device: event.target.value }),
              })),
            h(Field, { label: "访问令牌" },
              h("div", { className: "dtn-inline" },
                h("input", {
                  className: "dtn-input dtn-mono",
                  type: showCloudToken ? "text" : "password",
                  value: form.cloudToken,
                  placeholder: "服务器 /etc/dsh-notify.env 的 TOKEN",
                  autoComplete: "off",
                  onChange: (event) => update({ cloudToken: event.target.value }),
                }),
                h("button", { className: "dtn-btn ghost", onClick: () => setShowCloudToken((value) => !value) }, showCloudToken ? "隐藏" : "显示")))),
          h("div", { className: "dtn-row", style: { marginTop: 4 } },
            h("div", { className: "dtn-field" },
              h("span", { className: "dtn-label" }, "服务器证书指纹"),
              h("div", { className: "dtn-inline" },
                h("input", {
                  className: "dtn-input dtn-mono",
                  value: form.fingerprint,
                  placeholder: "留空表示使用系统信任的证书",
                  onChange: (event) => update({ fingerprint: event.target.value }),
                }),
                h("button", { className: "dtn-btn", disabled: busy !== "", onClick: fetchFingerprint }, busy === "fp" ? "读取中…" : "获取指纹")))),
          fpInfo
            ? h("div", null,
              h("div", { className: "dtn-fp" }, `SHA-256 ${fpInfo.display}`),
              h("div", { className: "dtn-row", style: { marginTop: 8 } },
                h("span", { className: "dtn-hint", style: { margin: 0 } }, `${fpInfo.subject || "未知证书"} · 有效期至 ${fpInfo.validTo || "未知"}`),
                h("button", { className: "dtn-btn", onClick: () => { update({ fingerprint: fpInfo.fingerprint }); setFpInfo(null); setNotice({ kind: "info", text: "已填入指纹，保存后生效。" }); } }, "使用此指纹")))
            : null,
          form.fingerprint
            ? h("div", { className: "dtn-fp" }, `已固定指纹 ${formatFingerprint(form.fingerprint)}`)
            : null,
          h("div", { className: "dtn-sep" }),
          h("div", { className: "dtn-row" },
            h(Field, { label: "CA 文件（可选，进阶）" },
              h("input", {
                className: "dtn-input dtn-mono",
                value: form.caFile,
                placeholder: "C:/path/to/ca.pem",
                onChange: (event) => update({ caFile: event.target.value }),
              }))),
          h("p", { className: "dtn-hint", style: { marginBottom: 0 } }, "自签名证书有两种方式：填指纹（推荐，手机 App 里同样会固定指纹），或填 CA 公钥文件路径。两者都留空时使用系统信任的公有证书。")),

        h("div", { className: "dtn-foot" },
          h("button", { className: "dtn-btn primary", disabled: busy !== "" || !dirty, onClick: save }, busy === "save" ? "保存中…" : dirty ? "保存设置" : "已保存"),
          h("button", { className: "dtn-btn ghost", disabled: busy !== "", onClick: refresh }, "重新读取"),
          h("span", { className: "dtn-spacer" }),
          h("span", { className: "dtn-hint", style: { margin: 0 } }, "设置只保存在本机；仅本机可修改。"))));
    }

    function apply(ctx) {
      try { ensureStyles(); } catch { /* styling is optional */ }
      const slots = ctx && ctx.slots;
      if (!slots || typeof slots.register !== "function") {
        console.warn("dsh-plugin-task-notify: slots service is unavailable; the settings panel cannot be registered");
        return;
      }
      try {
        slots.inject("sidebar.panellist", () => slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 40,
          label: () => "通知",
        }, NotifyIcon));
        slots.inject("main", () => slots.register({
          name: "main",
          key: PANEL_ID,
        }, Panel));
      } catch (error) {
        console.warn("dsh-plugin-task-notify: panel registration failed", error);
      }
    }

    const module = { exports: {} };
    module.exports.apply = apply;
    module.exports.inject = ["slots"];
    return module.exports;
  },
});
