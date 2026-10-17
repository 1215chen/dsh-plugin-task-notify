/**
 * dsh-plugin-task-notify — host-side phone notification bridge.
 *
 * Watches live turn boundaries on `session/event`, and when a turn ends with a
 * status the profile asked about, POSTs a small JSON notification to a paired
 * Android receiver on the local network. Receivers are found by UDP broadcast
 * (no configuration required) or named explicitly in the profile patch.
 *
 * The plugin has no npm dependencies: it only uses Node built-ins, so it can be
 * installed as a plain profile bundle.
 *
 * @module dsh-plugin-task-notify
 */
import { createSocket } from 'node:dgram';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { networkInterfaces, hostname } from 'node:os';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';

export const name = 'taskNotify';
export const inject = ['tools'];

const VERSION = '0.2.0';
const APPROVAL_HEADLINE = '需要授权';
const HEADLINES = Object.freeze({
  completed: '任务完成',
  error: '任务失败',
  aborted: '任务已取消',
  blocked: '任务在等你',
  'max-tokens': '输出达到上限',
  interrupted: '任务已中断',
  forked: '会话已分叉',
  started: 'DSH 通知已连接',
  manual: 'DSH 通知',
  test: 'DSH 通知测试',
});
const NOTIFY_STATUSES = Object.freeze(Object.keys(HEADLINES));
const DEFAULTS = Object.freeze({
  devices: [],
  phone: null,
  port: 8765,
  discoveryPort: 8766,
  discover: true,
  discoveryTimeoutMs: 700,
  notifyOn: ['completed', 'error'],
  minDurationMs: 15000,
  cooldownMs: 2500,
  includePreview: true,
  previewChars: 140,
  timeoutMs: 3500,
  attempts: 2,
  token: '',
  notifyOnStart: false,
  ignoreSubagents: true,
  tool: true,
  logToFile: true,
  maxQueue: 8,
  notifyOnApproval: true,
  cloud: null,
});
const TURN_STATE_LIMIT = 512;

/** Small helper: bounded integer option. */
function intOption(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/** Coerce an arbitrary untrusted scalar into one clean display line. */
function cleanText(value, limit = 200) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/** Format a duration for the phone notification body. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '不到 1 秒';
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}

/** Turn one assistant message into plain text for a notification preview. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** Trim markdown and code so the notification body reads like a sentence. */
function previewText(text, limit) {
  const cleaned = String(text ?? '')
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,4}(#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[`*_>#|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

/** Parse one device entry: `host`, `host:port`, or an object. */
function normalizeDevice(raw, fallbackPort) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    let host = text;
    let port = fallbackPort;
    const match = /^([^\s:#]+)(?::(\d{1,5}))?$/.exec(text);
    if (match) {
      host = match[1];
      if (match[2]) port = intOption(match[2], fallbackPort, 1, 65535);
    }
    return { host, port, name: host, token: '', model: '' };
  }
  if (!raw || typeof raw !== 'object') return null;
  const host = cleanText(raw.host ?? raw.ip ?? raw.address, 200);
  if (!host) return null;
  return {
    host,
    port: intOption(raw.port, fallbackPort, 1, 65535),
    name: cleanText(raw.name, 60) || host,
    token: typeof raw.token === 'string' ? raw.token : '',
    model: '',
  };
}

/** Normalize the optional cloud relay block. */
function normalizeCloud(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled === false) return null;
  const url = cleanText(raw.url, 300).replace(/\/+$/, '');
  if (!url) return { error: '缺少云端地址' };
  let parsed;
  try { parsed = new URL(url); } catch { return { error: '云端地址不是合法 URL' }; }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return { error: '云端地址必须是 http(s) URL' };
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  if (!token) return { error: '缺少云端访问令牌' };
  const device = cleanText(raw.device, 64) || 'my-phone';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(device)) return { error: '云端设备 ID 只能包含字母、数字、点、下划线和短横线' };
  const caFile = cleanText(raw.caFile, 1000);
  let ca;
  if (caFile) {
    try {
      ca = readFileSync(caFile);
    } catch {
      return { error: `无法读取云端 CA 文件：${caFile}` };
    }
  }
  return {
    url,
    token,
    device,
    ca,
    timeoutMs: intOption(raw.timeoutMs, 8000, 1000, 30000),
    origin: parsed.origin,
    basePath: parsed.pathname.replace(/\/+$/, ''),
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80),
    secure: parsed.protocol === 'https:',
  };
}

/** Normalize the profile patch into the exact options this run uses. */
function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULTS, ...input };
  config.port = intOption(config.port, DEFAULTS.port, 1, 65535);
  config.discoveryPort = intOption(config.discoveryPort, DEFAULTS.discoveryPort, 1, 65535);
  config.discoveryTimeoutMs = intOption(config.discoveryTimeoutMs, DEFAULTS.discoveryTimeoutMs, 100, 5000);
  config.minDurationMs = intOption(config.minDurationMs, DEFAULTS.minDurationMs, 0, 24 * 60 * 60 * 1000);
  config.cooldownMs = intOption(config.cooldownMs, DEFAULTS.cooldownMs, 0, 10 * 60 * 1000);
  config.previewChars = intOption(config.previewChars, DEFAULTS.previewChars, 20, 500);
  config.timeoutMs = intOption(config.timeoutMs, DEFAULTS.timeoutMs, 500, 15000);
  config.attempts = intOption(config.attempts, DEFAULTS.attempts, 1, 5);
  config.maxQueue = intOption(config.maxQueue, DEFAULTS.maxQueue, 1, 32);
  config.discover = config.discover !== false;
  config.includePreview = config.includePreview !== false;
  config.ignoreSubagents = config.ignoreSubagents !== false;
  config.tool = config.tool !== false;
  config.logToFile = config.logToFile !== false;
  config.notifyOnStart = config.notifyOnStart === true;
  config.notifyOnApproval = config.notifyOnApproval !== false;
  config.token = typeof config.token === 'string' ? config.token.trim() : '';
  const statuses = Array.isArray(config.notifyOn)
    ? config.notifyOn
    : typeof config.notifyOn === 'string'
      ? config.notifyOn.split(',')
      : DEFAULTS.notifyOn;
  config.notifyOn = new Set(statuses.map((status) => String(status).trim()).filter((status) => NOTIFY_STATUSES.includes(status) && status !== 'started' && status !== 'manual' && status !== 'test'));
  if (config.notifyOn.size === 0) config.notifyOn = new Set(DEFAULTS.notifyOn);
  const declared = Array.isArray(config.devices) ? [...config.devices] : config.devices ? [config.devices] : [];
  if (config.phone) declared.push(config.phone);
  config.devices = declared.map((entry) => normalizeDevice(entry, config.port)).filter(Boolean);
  const cloudInput = input.cloud && typeof input.cloud === 'object'
    ? input.cloud
    : (input.cloudUrl ? {
      url: input.cloudUrl,
      token: input.cloudToken,
      device: input.cloudDevice,
      timeoutMs: input.cloudTimeoutMs,
      enabled: input.cloudEnabled,
    } : null);
  const cloud = normalizeCloud(cloudInput);
  if (cloud?.error) {
    config.cloudError = cloud.error;
    config.cloud = null;
  } else {
    config.cloud = cloud;
    config.cloudError = '';
  }
  return config;
}

/** Convert dotted IPv4 text to a 32-bit unsigned number. */
function ipv4ToInt(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return 0;
  let value = 0;
  for (const part of parts) {
    const octet = Number.parseInt(part, 10);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return 0;
    value = (value * 256) + octet;
  }
  return value >>> 0;
}

/** Render a 32-bit unsigned number as dotted IPv4 text. */
function intToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/** Every broadcast address worth trying, including per-interface directed ones. */
function broadcastTargets() {
  const targets = new Set(['255.255.255.255']);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !entry.netmask) continue;
      const address = ipv4ToInt(entry.address);
      const mask = ipv4ToInt(entry.netmask);
      if (!address || !mask) continue;
      targets.add(intToIpv4(((address & mask) | (~mask >>> 0)) >>> 0));
    }
  }
  return [...targets];
}

/** Resolve the DSH home the same way the rest of the harness does. */
function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  return configured || join(homedir(), '.dsh');
}

/** Fire one HTTP request and parse a JSON response when present. */
function httpJson({ host, port, path, method = 'GET', body, token, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let data;
    const headers = {
      Accept: 'application/json',
      Connection: 'close',
      'User-Agent': `dsh-task-notify/${VERSION}`,
    };
    if (body !== undefined) {
      data = Buffer.from(JSON.stringify(body), 'utf8');
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(data.length);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = httpRequest({ host, port, path, method, headers, timeout: timeoutMs }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 65536) chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* plain body */ }
        resolve({ status: response.statusCode ?? 0, text, json });
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
    request.end(data);
  });
}

/** Fire one HTTP(S) request to an absolute URL and parse a JSON response. */
function httpJsonUrl(urlString, { method = 'GET', body, token, timeoutMs = 8000, ca } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch (error) { reject(error); return; }
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let data;
    const headers = {
      Accept: 'application/json',
      Connection: 'close',
      'User-Agent': `dsh-task-notify/${VERSION}`,
    };
    if (body !== undefined) {
      data = Buffer.from(JSON.stringify(body), 'utf8');
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(data.length);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = transport(url, { method, headers, timeout: timeoutMs, ...(ca ? { ca } : {}) }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 65536) chunks.push(chunk);
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* plain body */ }
        resolve({ status: response.statusCode ?? 0, text, json });
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
    request.end(data);
  });
}

/** Send one UDP datagram without letting a local routing error escape. */
function sendUdp(socket, payload, port, host) {
  try {
    socket.send(payload, 0, payload.length, port, host, () => {});
  } catch { /* best effort broadcast */ }
}

/**
 * Broadcast a discovery probe and collect receiver replies.
 * @returns {Promise<Array<{host: string, port: number, name: string, model: string, version: string}>>}
 */
function discoverDevices(config) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = createSocket({ type: 'udp4' });
    } catch {
      resolve([]);
      return;
    }
    const found = new Map();
    let finished = false;
    let timer;
    let repeat;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(repeat);
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    socket.on('error', () => finish());
    socket.on('message', (payload, remote) => {
      if (payload.length > 8192) return;
      let info;
      try { info = JSON.parse(payload.toString('utf8')); } catch { return; }
      if (!info || info.t !== 'dsh.device' || info.v !== 1) return;
      const port = intOption(info.port, 0, 1, 65535);
      if (!port) return;
      const host = remote.address;
      const key = `${host}:${port}`;
      if (found.has(key)) return;
      found.set(key, {
        host,
        port,
        name: cleanText(info.name, 60) || host,
        model: cleanText(info.model, 60),
        version: cleanText(info.version, 32),
      });
    });
    socket.bind(0, '0.0.0.0', () => {
      try { socket.setBroadcast(true); } catch { /* best effort */ }
      const payload = Buffer.from(JSON.stringify({ t: 'dsh.discover', v: 1, app: 'dsh-task-notify', id: randomUUID() }), 'utf8');
      for (const target of broadcastTargets()) sendUdp(socket, payload, config.discoveryPort, target);
      repeat = setTimeout(() => {
        if (!finished) for (const target of broadcastTargets()) sendUdp(socket, payload, config.discoveryPort, target);
      }, 120);
    });
    timer = setTimeout(finish, config.discoveryTimeoutMs);
  });
}

/** Human-readable network failure for logs and tool results. */
function describeError(error, target) {
  const code = String(error?.code ?? '');
  if (code === 'ECONNREFUSED') return `连接被拒绝（请确认手机 App 的通知服务已启动）`;
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `网络不可达（请确认手机与电脑在同一 Wi-Fi）`;
  if (code === 'ETIMEDOUT' || /超时/.test(String(error?.message))) return `连接超时（${target.host}:${target.port}）`;
  if (code === 'ENOTFOUND') return `找不到主机 ${target.host}`;
  const message = cleanText(error?.message, 120);
  return message || '发送失败';
}

/** Deduplicate devices by host:port, keeping configured names and tokens. */
function mergeDevices(...groups) {
  const merged = new Map();
  for (const group of groups) {
    for (const device of group ?? []) {
      if (!device || !device.host) continue;
      const key = `${device.host}:${device.port}`;
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, { ...device });
        continue;
      }
      merged.set(key, {
        ...previous,
        ...device,
        name: device.name && device.name !== device.host ? device.name : previous.name,
        token: device.token || previous.token,
        model: device.model || previous.model,
      });
    }
  }
  return [...merged.values()];
}

/**
 * Create the notification bridge for one mounted plugin instance.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<typeof normalizeConfig>} config
 */
function createNotifier(ctx, config) {
  const stateDir = join(dshHome(), 'storages', 'task-notify');
  const logFile = join(stateDir, 'plugin.log');
  const devicesFile = join(stateDir, 'devices.json');
  const deliveryFile = join(stateDir, 'last-delivery.json');
  const turns = new Map();
  const lastEndSeq = new Map();
  const lastNotifyAt = new Map();
  const approvalSeen = new Map();
  let cache = { at: 0, devices: [] };
  let persistedReady = false;
  let disposed = false;
  let queue = Promise.resolve();
  let queued = 0;
  let startupTimer;

  const ready = (async () => {
    try {
      await mkdir(stateDir, { recursive: true });
      try {
        const info = await stat(logFile);
        if (info.size > 1024 * 1024) await rename(logFile, `${logFile}.1`);
      } catch { /* first run */ }
      try {
        const parsed = JSON.parse(await readFile(devicesFile, 'utf8'));
        if (Array.isArray(parsed?.devices)) {
          cache = { at: 0, devices: parsed.devices.map((entry) => normalizeDevice(entry, config.port)).filter(Boolean) };
        }
      } catch { /* no cache yet */ }
      persistedReady = true;
    } catch { /* state directory is optional */ }
  })();

  /** Append one JSON line to the plugin's own diagnostic log. */
  function log(level, message, extra) {
    if (!config.logToFile) return;
    const line = `${JSON.stringify({ t: new Date().toISOString(), level, message, ...extra })}\n`;
    ready.then(() => appendFile(logFile, line, 'utf8')).catch(() => {});
  }

  /** Read the durable session title when that service is mounted. */
  function titleOf(session) {
    try {
      const service = ctx.get('sessionTitle');
      const folded = service?.get?.(session);
      const title = folded?.title;
      return typeof title === 'string' ? cleanText(title, 80) : '';
    } catch {
      return '';
    }
  }

  /** Read the main model chosen for this session when available. */
  function modelOf(session) {
    try {
      const header = session?.requestHeader?.();
      const model = header?.config?.model;
      return typeof model === 'string' ? model : '';
    } catch {
      return '';
    }
  }

  /** Whether this session belongs to a subagent rather than a user-facing root. */
  function isSubagent(sessionId) {
    if (!config.ignoreSubagents) return false;
    try {
      const agents = ctx.get('agents');
      if (!agents || typeof agents.get !== 'function') return false;
      const agent = agents.get(sessionId);
      if (!agent) return false;
      const roots = typeof agents.roots === 'function' ? agents.roots() : [];
      return !roots.includes(agent);
    } catch {
      return false;
    }
  }

  /** Merge configured devices with the freshest discovery result available. */
  async function resolveTargets(forceDiscovery = false) {
    if (!config.discover) return mergeDevices(config.devices);
    const fresh = !forceDiscovery && cache.devices.length > 0 && Date.now() - cache.at < 10 * 60 * 1000;
    if (fresh) return mergeDevices(config.devices, cache.devices);
    if (!persistedReady) await ready;
    const found = await discoverDevices(config);
    if (found.length > 0) {
      cache = { at: Date.now(), devices: found };
      const serializable = found.map(({ host, port, name, model, version }) => ({ host, port, name, model, version }));
      writeFile(devicesFile, `${JSON.stringify({ updatedAt: new Date().toISOString(), devices: serializable }, null, 2)}\n`, 'utf8').catch(() => {});
      log('info', 'discovery.found', { count: found.length, devices: serializable.map((device) => `${device.name}@${device.host}:${device.port}`) });
    } else {
      log('warn', 'discovery.empty', { configured: config.devices.length, cached: cache.devices.length });
    }
    return mergeDevices(config.devices, found.length > 0 ? found : cache.devices);
  }

  /** Absolute cloud URL for one relay endpoint. */
  function cloudEndpoint(path) {
    return `${config.cloud.origin}${config.cloud.basePath}${path}`;
  }

  /** Post one payload to the self-hosted cloud relay. */
  async function sendCloud(payload) {
    const cloud = config.cloud;
    if (!cloud) return null;
    let failure = '';
    for (let attempt = 1; attempt <= config.attempts; attempt++) {
      try {
        const response = await httpJsonUrl(cloudEndpoint('/api/v1/notify'), {
          method: 'POST',
          body: { device: cloud.device, payload },
          token: cloud.token,
          timeoutMs: cloud.timeoutMs,
          ca: cloud.ca,
        });
        if (response.status >= 200 && response.status < 300 && response.json?.ok !== false) {
          return {
            name: '云端中继',
            host: cloud.host,
            port: cloud.port,
            ok: true,
            error: '',
            seq: Number.isInteger(response.json?.seq) ? response.json.seq : undefined,
            cloud: true,
          };
        }
        if (response.status === 401 || response.status === 403) return { name: '云端中继', host: cloud.host, port: cloud.port, ok: false, error: '云端令牌不匹配', cloud: true };
        if (response.status === 404) return { name: '云端中继', host: cloud.host, port: cloud.port, ok: false, error: '云端地址不正确（404）', cloud: true };
        failure = `云端返回 HTTP ${response.status}`;
        if (response.status < 500) break;
      } catch (error) {
        const code = String(error?.code ?? '');
        if (code === 'ENOTFOUND') failure = `找不到云端域名 ${cloud.host}`;
        else if (code === 'ECONNREFUSED') failure = '云端拒绝连接（服务未启动或端口不对）';
        else if (code === 'ETIMEDOUT' || /超时/.test(String(error?.message))) failure = '云端连接超时';
        else if (/certificate|SSL|TLS/i.test(String(error?.message))) failure = '云端 TLS 证书校验失败';
        else failure = cleanText(error?.message, 120) || '云端发送失败';
      }
      if (attempt < config.attempts) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { name: '云端中继', host: cloud.host, port: cloud.port, ok: false, error: failure || '云端发送失败', cloud: true };
  }

  /** Check the relay's authenticated ping endpoint for the tool. */
  async function probeCloud() {
    const cloud = config.cloud;
    if (!cloud) return null;
    try {
      const response = await httpJsonUrl(cloudEndpoint('/api/v1/ping'), {
        token: cloud.token,
        timeoutMs: Math.min(cloud.timeoutMs, 3000),
        ca: cloud.ca,
      });
      const online = response.status >= 200 && response.status < 300 && response.json?.ok !== false;
      return { name: '云端中继', host: cloud.host, port: cloud.port, online, error: online ? '' : `HTTP ${response.status}` };
    } catch (error) {
      return { name: '云端中继', host: cloud.host, port: cloud.port, online: false, error: cleanText(error?.message, 120) || '云端不可达' };
    }
  }

  /** Deliver one payload to every resolved receiver, with bounded retries. */
  async function deliver(payload) {
    const targets = await resolveTargets();
    if (targets.length === 0 && !config.cloud) {
      const result = { ok: false, sentAt: new Date().toISOString(), payloadId: payload.id, devices: [], message: '未发现手机，也未配置云端中继' };
      writeFile(deliveryFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8').catch(() => {});
      log('warn', 'deliver.no-device', { id: payload.id, status: payload.status });
      return result;
    }
    const devices = [];
    for (const target of targets) {
      let failure = '';
      let delivered = false;
      for (let attempt = 1; attempt <= config.attempts; attempt++) {
        try {
          const response = await httpJson({
            host: target.host,
            port: target.port,
            path: '/notify',
            method: 'POST',
            body: payload,
            token: target.token || config.token,
            timeoutMs: config.timeoutMs,
          });
          if (response.status >= 200 && response.status < 300 && response.json?.ok !== false) {
            delivered = true;
            failure = '';
            break;
          }
          if (response.status === 401 || response.status === 403) {
            failure = '访问令牌不匹配';
            break;
          }
          failure = `手机返回 HTTP ${response.status}`;
          if (response.status < 500) break;
        } catch (error) {
          failure = describeError(error, target);
        }
        if (attempt < config.attempts) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      devices.push({
        name: target.name || target.host,
        host: target.host,
        port: target.port,
        ok: delivered,
        error: delivered ? '' : failure,
      });
    }
    if (config.cloud) {
      const cloudResult = await sendCloud(payload);
      if (cloudResult) {
        devices.push(cloudResult);
        log(cloudResult.ok ? 'info' : 'warn', cloudResult.ok ? 'cloud.ok' : 'cloud.failed', {
          device: config.cloud.device,
          host: cloudResult.host,
          seq: cloudResult.seq,
          error: cloudResult.error,
        });
      }
    }
    const ok = devices.some((device) => device.ok);
    if (!devices.some((device) => device.ok && !device.cloud)) cache = { at: 0, devices: cache.devices };
    const result = { ok, sentAt: new Date().toISOString(), payloadId: payload.id, status: payload.status, devices };
    writeFile(deliveryFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8').catch(() => {});
    log(ok ? 'info' : 'warn', ok ? 'deliver.ok' : 'deliver.failed', { id: payload.id, status: payload.status, devices });
    return result;
  }

  /** Serialize deliveries so a burst cannot open dozens of sockets at once. */
  function enqueue(task) {
    if (disposed) return;
    if (queued >= config.maxQueue) {
      log('warn', 'queue.full', { queued });
      return;
    }
    queued += 1;
    queue = queue
      .then(task)
      .catch((error) => log('error', 'queue.task', { error: cleanText(error?.message, 200) }))
      .finally(() => { queued -= 1; });
  }

  /** Compose the body line for one turn-end status. */
  function bodyFor(status, reason, state) {
    if (status === 'completed') {
      if (config.includePreview && state.lastText) return previewText(state.lastText, config.previewChars);
      return `用时 ${formatDuration(state.durationMs)} · ${state.toolCalls} 次工具调用`;
    }
    if (status === 'error') {
      const failure = reason?.error;
      const detail = failure?.message || failure?.code || '未知错误';
      return `错误：${previewText(detail, 160)}`;
    }
    if (status === 'aborted') {
      const cause = reason?.reason?.kind || reason?.reason?.reason || '已取消';
      return `本轮已取消（${cleanText(String(cause), 60)}）`;
    }
    if (status === 'blocked') return '任务需要你的确认或补充信息';
    if (status === 'max-tokens') return '输出达到长度上限，可继续发送「继续」';
    if (status === 'interrupted') return 'DSH 重启导致本轮中断';
    if (status === 'forked') return '会话已分叉';
    return '本轮已结束';
  }

  /** Build one notification payload from a live turn boundary. */
  function buildPayload(session, event, state) {
    const reason = event?.data?.reason ?? {};
    const status = typeof reason.kind === 'string' ? reason.kind : 'unknown';
    if (!NOTIFY_STATUSES.includes(status)) return null;
    const durationMs = state.startedAt > 0 ? Date.now() - state.startedAt : 0;
    state.durationMs = durationMs;
    const cwd = cleanText(session?.header?.cwd, 300);
    const project = cwd ? cleanText(basename(cwd.replace(/[\\/]+$/, '')), 60) : '';
    const title = titleOf(session) || previewText(state.lastUserText, 40) || project || 'DSH 会话';
    return {
      v: 1,
      id: `n_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      kind: 'turn-end',
      status,
      headline: HEADLINES[status] ?? '任务结束',
      title,
      body: bodyFor(status, reason, state),
      sessionId: String(session?.id ?? ''),
      project,
      cwd,
      model: modelOf(session),
      turn: Number.isInteger(event?.data?.turn) ? event.data.turn : null,
      durationMs,
      steps: state.steps,
      tools: state.toolCalls,
      host: cleanText(hostname(), 60),
      time: new Date().toISOString(),
      ts: Date.now(),
      app: 'dsh',
      pluginVersion: VERSION,
    };
  }

  /** Observe one live session event; never throw into the session feed. */
  function onSessionEvent(session, event) {
    try {
      if (disposed || !event || typeof event.type !== 'string') return;
      const sessionId = session?.id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return;

      if (event.type === 'turn/start') {
        turns.set(sessionId, {
          turn: Number.isInteger(event.data?.turn) ? event.data.turn : 0,
          startedAt: Date.now(),
          steps: 0,
          toolCalls: 0,
          lastText: '',
          lastUserText: '',
          durationMs: 0,
        });
        if (turns.size > TURN_STATE_LIMIT) turns.delete(turns.keys().next().value);
        return;
      }

      let state = turns.get(sessionId);
      if (!state) {
        state = { turn: 0, startedAt: 0, steps: 0, toolCalls: 0, lastText: '', lastUserText: '', durationMs: 0 };
        turns.set(sessionId, state);
      }

      if (event.type === 'step/start') {
        state.steps += 1;
        return;
      }
      if (event.type === 'tool/call') {
        state.toolCalls += 1;
        return;
      }
      if (event.type === 'assistant/message') {
        const text = messageText(event.data?.message).trim();
        if (text) state.lastText = text;
        return;
      }
      if (event.type === 'user/message') {
        const text = messageText(event.data).trim();
        if (text) state.lastUserText = text;
        return;
      }
      if (event.type === 'approval/asked') {
        if (!config.notifyOnApproval || isSubagent(sessionId)) return;
        const data = event.data ?? {};
        const approvalId = cleanText(String(data.id ?? ''), 80);
        const key = `${sessionId}:${approvalId || event.seq || Date.now()}`;
        if (approvalSeen.has(key)) return;
        approvalSeen.set(key, Date.now());
        if (approvalSeen.size > 512) approvalSeen.delete(approvalSeen.keys().next().value);
        const tool = cleanText(data.toolName, 80) || '未知工具';
        const reason = cleanText(data.reason, 180);
        const cwd = cleanText(session?.header?.cwd, 300);
        const project = cwd ? cleanText(basename(cwd.replace(/[\\/]+$/, '')), 60) : '';
        const payload = {
          v: 1,
          id: `n_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
          kind: 'approval',
          status: 'approval',
          headline: APPROVAL_HEADLINE,
          title: titleOf(session) || previewText(state.lastUserText, 40) || project || 'DSH 会话',
          body: reason
            ? `工具 ${tool} 请求授权：${reason}`
            : `工具 ${tool} 请求授权，请回到 DSH 处理。`,
          sessionId,
          project,
          cwd,
          model: modelOf(session),
          turn: Number.isInteger(event.data?.turn) ? event.data.turn : null,
          durationMs: 0,
          steps: state.steps,
          tools: state.toolCalls,
          approvalId,
          toolName: tool,
          host: cleanText(hostname(), 60),
          time: new Date().toISOString(),
          ts: Date.now(),
          app: 'dsh',
          pluginVersion: VERSION,
        };
        log('info', 'approval.notify', { sessionId, approvalId, tool });
        enqueue(() => deliver(payload));
        return;
      }
      if (event.type !== 'turn/end') return;

      const seq = Number.isSafeInteger(event.seq) ? event.seq : -1;
      if (seq >= 0 && seq <= (lastEndSeq.get(sessionId) ?? -1)) return;
      if (seq >= 0) {
        lastEndSeq.set(sessionId, seq);
        if (lastEndSeq.size > 4096) lastEndSeq.delete(lastEndSeq.keys().next().value);
      }
      if (isSubagent(sessionId)) {
        turns.delete(sessionId);
        return;
      }

      const status = event.data?.reason?.kind;
      const payload = buildPayload(session, event, state);
      turns.delete(sessionId);
      if (!payload) return;
      if (!config.notifyOn.has(payload.status)) return;
      if (payload.status === 'completed' && config.minDurationMs > 0 && payload.durationMs < config.minDurationMs && state.toolCalls === 0) {
        log('info', 'turn.skipped-short', { sessionId, durationMs: payload.durationMs });
        return;
      }
      const now = Date.now();
      if (now - (lastNotifyAt.get(sessionId) ?? 0) < config.cooldownMs) {
        log('info', 'turn.skipped-cooldown', { sessionId });
        return;
      }
      lastNotifyAt.set(sessionId, now);
      if (lastNotifyAt.size > 4096) lastNotifyAt.delete(lastNotifyAt.keys().next().value);
      log('info', 'turn.notify', { sessionId, status: payload.status, durationMs: payload.durationMs, tools: payload.tools });
      enqueue(() => deliver(payload));
    } catch (error) {
      log('error', 'session.event', { error: cleanText(error?.message, 200) });
    }
  }

  /** Build a manual/test payload for the tool. */
  function manualPayload(title, body, status = 'manual') {
    return {
      v: 1,
      id: `m_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
      kind: 'manual',
      status,
      headline: HEADLINES[status] ?? HEADLINES.manual,
      title: cleanText(title, 80) || '来自 DSH 的通知',
      body: previewText(body, 220) || '这是一条来自 DSH 的测试通知。',
      sessionId: '',
      project: '',
      cwd: '',
      model: '',
      turn: null,
      durationMs: 0,
      steps: 0,
      tools: 0,
      host: cleanText(hostname(), 60),
      time: new Date().toISOString(),
      ts: Date.now(),
      app: 'dsh',
      pluginVersion: VERSION,
    };
  }

  /** Probe receivers and report what is reachable. */
  async function probeTargets() {
    const targets = await resolveTargets(true);
    const devices = [];
    for (const target of targets) {
      try {
        const response = await httpJson({ host: target.host, port: target.port, path: '/ping', timeoutMs: Math.min(config.timeoutMs, 2000), token: target.token || config.token });
        const online = response.status >= 200 && response.status < 300 && response.json?.ok !== false;
        devices.push({
          name: cleanText(response.json?.name, 60) || target.name || target.host,
          host: target.host,
          port: target.port,
          online,
          error: online ? '' : `HTTP ${response.status}`,
        });
      } catch (error) {
        devices.push({ name: target.name || target.host, host: target.host, port: target.port, online: false, error: describeError(error, target) });
      }
    }
    if (config.cloud) {
      const cloud = await probeCloud();
      if (cloud) devices.push(cloud);
    }
    return { targets, devices };
  }

  /** The model-facing diagnostic tool. */
  function registerTool() {
    if (!config.tool) return;
    const tools = ctx.get('tools');
    if (!tools || typeof tools.register !== 'function') {
      log('warn', 'tool.unavailable');
      return;
    }
    try {
      tools.register({
        name: 'phone_notify',
        description: '向已配对的安卓手机或云端中继发送通知，或检查连接。action=discover 查找同一 Wi-Fi 下的手机并检查云端；action=test 发送一条测试通知；action=send 发送自定义通知。仅当用户要求测试/发送手机通知时调用。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['discover', 'test', 'send'],
              description: 'discover 只检查连接；test 发送固定测试通知；send 发送下面的 title/body。',
            },
            title: { type: 'string', description: '通知标题（send 时使用，可省略）。' },
            body: { type: 'string', description: '通知正文（send 时使用，可省略）。' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              devices: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    host: { type: 'string' },
                    port: { type: 'integer' },
                    online: { type: 'boolean' },
                    error: { type: 'string' },
                  },
                  required: ['name', 'host', 'port', 'online', 'error'],
                  additionalProperties: false,
                },
              },
            },
            required: ['ok', 'message', 'devices'],
            additionalProperties: false,
          },
          render: (_args, value) => [{ type: 'text', text: value.message }],
        },
        timeoutMs: 30000,
        async execute(args) {
          const action = args?.action;
          if (action === 'discover') {
            const { devices } = await probeTargets();
            if (devices.length === 0) {
              return { ok: false, message: '没有发现手机，也没有可用的云端中继。请检查 App 服务、Wi-Fi 或 cloud 配置。', devices: [] };
            }
            const online = devices.filter((device) => device.online);
            const detail = devices.map((device) => `${device.name} ${device.host}:${device.port} ${device.online ? '在线' : `离线（${device.error}）`}`).join('；');
            return { ok: online.length > 0, message: `${online.length}/${devices.length} 台设备在线：${detail}`, devices };
          }
          const isTest = action === 'test';
          const payload = manualPayload(
            isTest ? 'DSH 通知测试' : args?.title,
            isTest ? '如果你看到这条通知，说明手机与 DSH 已经连通。' : args?.body,
            isTest ? 'test' : 'manual',
          );
          const result = await deliver(payload);
          const delivered = result.devices ?? [];
          const devices = delivered.map((device) => ({
            name: device.name,
            host: device.host,
            port: device.port,
            online: device.ok === true,
            error: device.error || '',
          }));
          const okCount = devices.filter((device) => device.online).length;
          const message = okCount > 0
            ? `已送达 ${okCount}/${devices.length} 台设备：${devices.filter((device) => device.online).map((device) => `${device.name} ${device.host}:${device.port}`).join('；')}`
            : `发送失败：${devices.map((device) => `${device.name}（${device.error}）`).join('；') || '未发现手机'}`;
          return { ok: okCount > 0, message, devices };
        },
      });
    } catch (error) {
      log('error', 'tool.register', { error: cleanText(error?.message, 200) });
    }
  }

  return {
    start() {
      log('info', 'plugin.loaded', {
        version: VERSION,
        port: config.port,
        discoveryPort: config.discoveryPort,
        discover: config.discover,
        notifyOn: [...config.notifyOn],
        devices: config.devices.map((device) => `${device.name}@${device.host}:${device.port}`),
        cloud: config.cloud ? `${config.cloud.host}:${config.cloud.port} device=${config.cloud.device}` : (config.cloudError || null),
        minDurationMs: config.minDurationMs,
      });
      if (config.notifyOnStart) {
        startupTimer = setTimeout(() => {
          if (disposed) return;
          enqueue(() => deliver(manualPayload('DSH 通知已连接', '任务完成通知插件已启动。', 'started')));
        }, 1500);
      }
    },
    onSessionEvent,
    registerTool,
    deliver,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(startupTimer);
      turns.clear();
      lastEndSeq.clear();
      lastNotifyAt.clear();
      approvalSeen.clear();
      log('info', 'plugin.disposed', { version: VERSION });
    },
  };
}

/**
 * Mount the notification bridge into a DSH profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const notifier = createNotifier(ctx, config);
  ctx.on('session/event', (session, event) => notifier.onSessionEvent(session, event), { global: true });
  notifier.registerTool();
  notifier.start();
  ctx.effect(() => () => notifier.dispose(), 'task-notify.dispose');
}
