/**
 * dsh-plugin-task-notify — host-side phone notification bridge.
 *
 * Watches live turn boundaries on `session/event` and, when a turn ends with a
 * status the profile asked about, POSTs a small JSON notification to a paired
 * Android receiver on the local network. Receivers are found by UDP broadcast
 * (no configuration required) or named explicitly in the profile patch.
 *
 * The plugin also serves a small local-only HTTP API for its browser settings
 * panel (left sidebar entry), and it can talk to a self-hosted HTTPS relay
 * either through a CA file or through a pinned certificate fingerprint.
 *
 * The plugin has no npm dependencies: it only uses Node built-ins, so it can be
 * installed as a plain profile bundle.
 *
 * @module dsh-plugin-task-notify
 */
import { createSocket } from 'node:dgram';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect, checkServerIdentity } from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, readFileSync } from 'node:fs';
import { hostname, networkInterfaces, homedir } from 'node:os';
import { basename, join } from 'node:path';
import { appendFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';

export const name = 'taskNotify';
export const inject = ['tools'];

const VERSION = '1.2.2';
const APPROVAL_HEADLINE = '需要授权';
const SETTINGS_VERSION = 1;
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
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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
  if (!Number.isFinite(ms) || ms <= 0) return '未知';
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

/** Normalize a certificate fingerprint to lowercase hex without separators. */
function normalizeFingerprint(value) {
  const text = String(value ?? '').trim().toLowerCase().replace(/^sha256[:=]\s*/, '');
  const hex = text.replace(/[^0-9a-f]/g, '');
  if (hex.length !== 64) return '';
  return hex;
}

/** Render a stored fingerprint as colon-separated uppercase pairs. */
function displayFingerprint(hex) {
  const normalized = normalizeFingerprint(hex);
  if (!normalized) return '';
  return (normalized.match(/.{2}/g) ?? []).join(':').toUpperCase();
}

/** True when the host part of a URL points at this machine. */
function isLoopbackUrl(url) {
  const host = String(url?.hostname ?? '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

/**
 * Normalize the optional cloud relay block.
 *
 * Plain `http://` is only accepted for a loopback relay (local testing). Every
 * other relay must be `https://`; secrets never travel over cleartext.
 */
function normalizeCloud(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled === false) return null;
  const url = cleanText(raw.url, 300).replace(/\/+$/, '');
  if (!url) return { error: '缺少云端地址' };
  let parsed;
  try { parsed = new URL(url); } catch { return { error: '云端地址不是合法 URL' }; }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return { error: '云端地址必须是 https:// 开头的 URL' };
  if (parsed.protocol === 'http:' && !isLoopbackUrl(parsed)) {
    return { error: '云端地址必须使用 https://（只有 127.0.0.1 / localhost 允许 http）' };
  }
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';
  if (!token) return { error: '缺少云端访问令牌' };
  const device = cleanText(raw.device, 64) || 'my-phone';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(device)) return { error: '云端设备 ID 只能包含字母、数字、点、下划线和短横线' };
  const fingerprintInput = typeof raw.fingerprint === 'string' ? raw.fingerprint.trim() : '';
  const fingerprint = normalizeFingerprint(fingerprintInput);
  if (fingerprintInput && !fingerprint) return { error: '证书指纹必须是 64 位十六进制 SHA-256' };
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
    fingerprint,
    ca,
    caFile,
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
      fingerprint: input.cloudFingerprint,
      caFile: input.cloudCaFile,
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

/** Decode an HTTP/1.1 chunked body, or null while it is still incomplete. */
function decodeChunkedBody(buffer) {
  const parts = [];
  let offset = 0;
  while (true) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString('ascii'), 16);
    if (!Number.isFinite(size)) return null;
    offset = lineEnd + 2;
    if (size === 0) {
      if (buffer.length < offset + 2) return null;
      return Buffer.concat(parts);
    }
    if (buffer.length < offset + size + 2) return null;
    parts.push(buffer.subarray(offset, offset + size));
    offset += size + 2;
  }
}

/** Parse one HTTP/1.1 response; null means "need more bytes". */
function parseHttpResponse(buffer, ended = false) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) return null;
  const head = buffer.subarray(0, headerEnd).toString('latin1');
  const lines = head.split('\r\n');
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})/.exec(lines[0] ?? '');
  if (!statusMatch) return null;
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const rest = buffer.subarray(headerEnd + 4);
  let body;
  if (/chunked/i.test(headers.get('transfer-encoding') ?? '')) {
    body = decodeChunkedBody(rest);
    if (body === null) return null;
  } else if (headers.has('content-length')) {
    const length = Number.parseInt(headers.get('content-length') ?? '', 10);
    if (!Number.isFinite(length) || length < 0) return null;
    if (rest.length < length) {
      if (!ended) return null;
      body = rest;
    } else {
      body = rest.subarray(0, length);
    }
  } else {
    if (!ended) return null;
    body = rest;
  }
  return { status: Number(statusMatch[1]), text: body.toString('utf8') };
}

/** Write one HTTP request over an established socket and read the response. */
function writeHttpOverSocket(socket, head, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let finished = false;
    const timer = setTimeout(() => finish(new Error('请求超时')), timeoutMs);
    function finish(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* already gone */ }
      if (error) reject(error); else resolve(value);
    }
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) {
        finish(new Error('响应过大'));
        return;
      }
      const parsed = parseHttpResponse(buffer);
      if (parsed) finish(null, parsed);
    });
    socket.once('end', () => {
      const parsed = parseHttpResponse(buffer, true);
      finish(parsed ? null : new Error('连接被服务器关闭'), parsed);
    });
    socket.once('error', (error) => finish(error));
    socket.once('timeout', () => finish(new Error('请求超时')));
    socket.setTimeout(timeoutMs);
    socket.write(head);
    if (body) socket.write(body);
  });
}

/** True when a host is an IP literal, which must not be sent as TLS SNI. */
function isIpLiteral(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/**
 * HTTPS request that verifies a pinned leaf-certificate SHA-256 fingerprint
 * before any request bytes (and therefore the bearer token) are sent.
 *
 * The TLS socket is established by hand, the fingerprint and host name are
 * checked on `secureConnect`, and only then is the HTTP request written over
 * that verified socket. The HTTP/1.1 response is parsed here because Node's
 * `http.request` refuses a socket it did not connect itself.
 */
function httpsJsonPinned(target, { method = 'GET', path, body, token, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      reject(error);
    };
    try {
      socket = tlsConnect({
        host: target.host,
        port: target.port,
        ...(isIpLiteral(target.host) ? {} : { servername: target.host }),
        rejectUnauthorized: false,
        timeout: timeoutMs,
      });
    } catch (error) {
      fail(error);
      return;
    }
    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error('请求超时')));
    socket.once('secureConnect', () => {
      let cert;
      try { cert = socket.getPeerCertificate(true); } catch { cert = null; }
      if (!cert || !cert.raw) {
        fail(Object.assign(new Error('无法读取服务器证书'), { code: 'CERT_MISSING' }));
        return;
      }
      const actual = createHash('sha256').update(cert.raw).digest('hex');
      if (target.fingerprint && actual !== target.fingerprint) {
        fail(Object.assign(new Error('服务器证书指纹与已保存的指纹不一致'), {
          code: 'CERT_FINGERPRINT_MISMATCH',
          actual,
          expected: target.fingerprint,
        }));
        return;
      }
      const hostnameError = checkServerIdentity(target.host, cert);
      if (hostnameError) {
        fail(Object.assign(new Error(`证书不包含该地址：${hostnameError.message}`), { code: 'CERT_HOSTNAME' }));
        return;
      }
      const headers = {
        Accept: 'application/json',
        Connection: 'close',
        'User-Agent': `dsh-task-notify/${VERSION}`,
        Host: target.port === 443 ? target.host : `${target.host}:${target.port}`,
      };
      let data;
      if (body !== undefined) {
        data = Buffer.from(JSON.stringify(body), 'utf8');
        headers['Content-Type'] = 'application/json; charset=utf-8';
        headers['Content-Length'] = String(data.length);
      }
      if (token) headers.Authorization = `Bearer ${token}`;
      const head = [
        `${method} ${path} HTTP/1.1`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ].join('\r\n');
      writeHttpOverSocket(socket, Buffer.from(head, 'utf8'), data, timeoutMs)
        .then((response) => {
          if (settled) return;
          settled = true;
          let json;
          try { json = JSON.parse(response.text); } catch { /* plain body */ }
          resolve({ status: response.status, text: response.text, json });
        })
        .catch(fail);
    });
  });
}

/** Read one JSON file, returning a fallback on any failure. */
async function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write one JSON file through a temp file so readers never see a partial body. */
async function writeJsonFile(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
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
  if (code === 'ECONNREFUSED') return '连接被拒绝（请确认手机 App 的通知服务已启动）';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return '网络不可达（请确认手机与电脑在同一 Wi-Fi）';
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

/** Describe the leaf certificate of a TLS endpoint without trusting it. */
function probeCertificate(urlString, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); } catch { reject(new Error('地址不是合法 URL')); return; }
    if (url.protocol !== 'https:') {
      reject(new Error('只有 https:// 地址才有证书指纹'));
      return;
    }
    const port = url.port ? Number(url.port) : 443;
    let socket;
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      if (error) reject(error); else resolve(value);
    };
    try {
      socket = tlsConnect({
        host: url.hostname,
        port,
        ...(isIpLiteral(url.hostname) ? {} : { servername: url.hostname }),
        rejectUnauthorized: false,
        timeout: timeoutMs,
      });
    } catch (error) {
      done(error);
      return;
    }
    socket.once('error', (error) => done(error));
    socket.once('timeout', () => done(new Error('连接超时')));
    socket.once('secureConnect', () => {
      try {
        const cert = socket.getPeerCertificate(true);
        if (!cert || !cert.raw) throw new Error('服务器没有提供证书');
        done(null, {
          url: urlString,
          fingerprint: createHash('sha256').update(cert.raw).digest('hex'),
          subject: cert.subject?.CN ?? '',
          issuer: cert.issuer?.CN ?? '',
          validFrom: cert.valid_from ?? '',
          validTo: cert.valid_to ?? '',
          san: cert.subjectaltname ?? '',
          selfSigned: cert.issuer?.CN === cert.subject?.CN,
        });
      } catch (error) {
        done(error);
      }
    });
  });
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
  const settingsFile = join(stateDir, 'settings.json');
  const turns = new Map();
  const lastEndSeq = new Map();
  const lastNotifyAt = new Map();
  const approvalSeen = new Map();
  const startedAt = Date.now();
  let cache = { at: 0, devices: [] };
  let persistedReady = false;
  let disposed = false;
  let queue = Promise.resolve();
  let queued = 0;
  let startupTimer;
  let lastDelivery = null;
  // Editable overrides persisted in settings.json. `hasToken`/`hasCloud` keep
  // "inherit the profile patch" distinct from "explicitly empty".
  const overrides = { hasToken: false, token: null, hasCloud: false, cloud: null };
  const live = {
    token: config.token,
    cloud: config.cloud,
    cloudError: config.cloudError || '',
  };

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
      const stored = await readJsonFile(settingsFile, null);
      if (stored && typeof stored === 'object') {
        overrides.hasToken = Object.hasOwn(stored, 'token') && stored.token !== null;
        overrides.token = overrides.hasToken && typeof stored.token === 'string' ? stored.token : null;
        overrides.hasCloud = Object.hasOwn(stored, 'cloud');
        overrides.cloud = overrides.hasCloud && stored.cloud && typeof stored.cloud === 'object' ? stored.cloud : null;
        applySettings(overrides, { persist: false, log: false });
      }
      lastDelivery = await readJsonFile(deliveryFile, null);
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
    return `${live.cloud.origin}${live.cloud.basePath}${path}`;
  }

  /** Post one payload to the self-hosted cloud relay. */
  async function sendCloud(payload) {
    const cloud = live.cloud;
    if (!cloud) return null;
    const target = { name: '云端中继', host: cloud.host, port: cloud.port, ok: false, error: '', cloud: true };
    let failure = '';
    for (let attempt = 1; attempt <= config.attempts; attempt++) {
      try {
        const options = {
          method: 'POST',
          body: { device: cloud.device, payload },
          token: cloud.token,
          timeoutMs: cloud.timeoutMs,
        };
        const response = cloud.fingerprint
          ? await httpsJsonPinned(cloud, { ...options, path: `${cloud.basePath}/api/v1/notify` })
          : await httpJsonUrl(cloudEndpoint('/api/v1/notify'), { ...options, ca: cloud.ca });
        if (response.status >= 200 && response.status < 300 && response.json?.ok !== false) {
          live.cloudError = '';
          return { ...target, ok: true, seq: Number.isInteger(response.json?.seq) ? response.json.seq : undefined };
        }
        if (response.status === 401 || response.status === 403) {
          failure = '云端令牌不匹配';
          break;
        }
        if (response.status === 404) {
          failure = '云端地址不正确（404）';
          break;
        }
        failure = `云端返回 HTTP ${response.status}`;
        if (response.status < 500) break;
      } catch (error) {
        const code = String(error?.code ?? '');
        if (code === 'CERT_FINGERPRINT_MISMATCH') {
          failure = '云端证书指纹不匹配（服务器换了证书，或存在中间人）';
          break;
        }
        if (code === 'CERT_HOSTNAME') {
          failure = '云端证书不包含这个地址';
          break;
        }
        if (code === 'ENOTFOUND') failure = `找不到云端域名 ${cloud.host}`;
        else if (code === 'ECONNREFUSED') failure = '云端拒绝连接（服务未启动或端口不对）';
        else if (code === 'ETIMEDOUT' || /超时/.test(String(error?.message))) failure = '云端连接超时';
        else if (/certificate|SSL|TLS|CERT/i.test(String(error?.message))) failure = '云端 TLS 证书校验失败';
        else failure = cleanText(error?.message, 120) || '云端发送失败';
      }
      if (attempt < config.attempts) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    live.cloudError = failure || '云端发送失败';
    return { ...target, error: live.cloudError };
  }

  /** Check the relay's authenticated ping endpoint for the tool and the panel. */
  async function probeCloud() {
    const cloud = live.cloud;
    if (!cloud) return null;
    const target = { name: '云端中继', host: cloud.host, port: cloud.port };
    try {
      const response = cloud.fingerprint
        ? await httpsJsonPinned(cloud, { path: `${cloud.basePath}/api/v1/ping`, token: cloud.token, timeoutMs: Math.min(cloud.timeoutMs, 5000) })
        : await httpJsonUrl(cloudEndpoint('/api/v1/ping'), { token: cloud.token, timeoutMs: Math.min(cloud.timeoutMs, 5000), ca: cloud.ca });
      const online = response.status >= 200 && response.status < 300 && response.json?.ok !== false;
      if (online) live.cloudError = '';
      return { ...target, online, error: online ? '' : `HTTP ${response.status}` };
    } catch (error) {
      return { ...target, online: false, error: cleanText(error?.message, 120) || '云端不可达' };
    }
  }

  /** Deliver one payload to every resolved receiver, with bounded retries. */
  async function deliver(payload) {
    if (!persistedReady) await ready;
    const targets = await resolveTargets();
    if (targets.length === 0 && !live.cloud) {
      const result = { ok: false, sentAt: new Date().toISOString(), payloadId: payload.id, devices: [], message: '未发现手机，也未配置云端中继' };
      lastDelivery = result;
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
            token: target.token || live.token,
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
    if (live.cloud) {
      const cloudResult = await sendCloud(payload);
      if (cloudResult) {
        devices.push(cloudResult);
        log(cloudResult.ok ? 'info' : 'warn', cloudResult.ok ? 'cloud.ok' : 'cloud.failed', {
          device: live.cloud.device,
          host: cloudResult.host,
          seq: cloudResult.seq,
          error: cloudResult.error,
        });
      }
    }
    const ok = devices.some((device) => device.ok);
    if (!devices.some((device) => device.ok && !device.cloud)) cache = { at: 0, devices: cache.devices };
    const result = { ok, sentAt: new Date().toISOString(), payloadId: payload.id, status: payload.status, devices };
    lastDelivery = result;
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
      const duration = state.durationMs > 0 ? `用时 ${formatDuration(state.durationMs)}` : '用时未知';
      return `${duration} · ${state.toolCalls} 次工具调用`;
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

  /** Build a manual/test payload for the tool and the settings panel. */
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
        const response = await httpJson({ host: target.host, port: target.port, path: '/ping', timeoutMs: Math.min(config.timeoutMs, 2000), token: target.token || live.token });
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
    if (live.cloud) {
      const cloud = await probeCloud();
      if (cloud) devices.push(cloud);
    }
    return { targets, devices };
  }

  /**
   * The editable form state: settings.json overrides the profile patch, and a
   * missing override inherits the patch value.
   */
  function formState() {
    const token = overrides.hasToken ? (overrides.token ?? '') : config.token;
    let cloud;
    if (overrides.hasCloud) {
      const stored = overrides.cloud && typeof overrides.cloud === 'object' ? overrides.cloud : null;
      cloud = {
        enabled: stored ? stored.enabled !== false : false,
        url: typeof stored?.url === 'string' ? stored.url : '',
        device: typeof stored?.device === 'string' ? stored.device : 'my-phone',
        token: typeof stored?.token === 'string' ? stored.token : '',
        fingerprint: typeof stored?.fingerprint === 'string' ? stored.fingerprint : '',
        caFile: typeof stored?.caFile === 'string' ? stored.caFile : '',
      };
    } else if (config.cloud) {
      cloud = {
        enabled: true,
        url: config.cloud.url,
        device: config.cloud.device,
        token: config.cloud.token,
        fingerprint: config.cloud.fingerprint,
        caFile: config.cloud.caFile,
      };
    } else {
      cloud = { enabled: false, url: '', device: 'my-phone', token: '', fingerprint: '', caFile: '' };
    }
    return { token, cloud };
  }

  /** Recompute the live delivery config from the form state. */
  function applySettings(next, options = {}) {
    if (next && typeof next === 'object') {
      if (Object.hasOwn(next, 'hasToken')) {
        overrides.hasToken = next.hasToken === true;
        overrides.token = typeof next.token === 'string' ? next.token : null;
      }
      if (Object.hasOwn(next, 'hasCloud')) {
        overrides.hasCloud = next.hasCloud === true;
        overrides.cloud = next.cloud && typeof next.cloud === 'object' ? next.cloud : null;
      }
    }
    const form = formState();
    live.token = form.token;
    if (form.cloud.enabled && form.cloud.url && form.cloud.token) {
      const normalized = normalizeCloud({ ...form.cloud, enabled: true });
      if (normalized?.error) {
        live.cloud = null;
        live.cloudError = normalized.error;
        if (options.log !== false) log('warn', 'settings.cloud-invalid', { error: normalized.error });
      } else {
        live.cloud = normalized;
        live.cloudError = '';
      }
    } else {
      live.cloud = null;
      live.cloudError = '';
    }
    if (options.persist !== false) {
      persistSettings().catch(() => {});
    }
    return { ok: !live.cloudError, error: live.cloudError };
  }

  /** Write the editable overrides to settings.json (0600). */
  function persistSettings() {
    const payload = { version: SETTINGS_VERSION, token: null };
    if (overrides.hasToken) payload.token = overrides.token ?? '';
    if (overrides.hasCloud) {
      payload.cloud = overrides.cloud ? {
        enabled: overrides.cloud.enabled !== false,
        url: overrides.cloud.url ?? '',
        device: overrides.cloud.device ?? 'my-phone',
        token: overrides.cloud.token ?? '',
        fingerprint: overrides.cloud.fingerprint ?? '',
        caFile: overrides.cloud.caFile ?? '',
      } : null;
    }
    return writeJsonFile(settingsFile, payload).then(() => {
      try { chmodSync(settingsFile, 0o600); } catch { /* windows: mode is advisory */ }
    });
  }

  /** Validate and persist a settings patch coming from the browser panel. */
  async function saveSettings(input) {
    if (!input || typeof input !== 'object') return { ok: false, error: '设置内容无效' };
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (token.length > 256) return { ok: false, error: '局域网令牌最多 256 个字符' };
    const incoming = input.cloud && typeof input.cloud === 'object' ? input.cloud : {};
    const enabled = incoming.enabled === true;
    const url = cleanText(incoming.url, 300).replace(/\/+$/, '');
    const cloudToken = typeof incoming.token === 'string' ? incoming.token.trim() : '';
    const device = cleanText(incoming.device, 64) || 'my-phone';
    const fingerprint = normalizeFingerprint(incoming.fingerprint);
    const caFile = cleanText(incoming.caFile, 1000);
    if (enabled) {
      if (!url) return { ok: false, error: '请填写云端服务器地址' };
      let parsed;
      try { parsed = new URL(url); } catch { return { ok: false, error: '云端地址不是合法 URL' }; }
      if (parsed.protocol !== 'https:' && !isLoopbackUrl(parsed)) {
        return { ok: false, error: '云端地址必须使用 https://（只有本机回环地址允许 http）' };
      }
      if (!cloudToken) return { ok: false, error: '请填写云端访问令牌' };
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(device)) return { ok: false, error: '设备 ID 只能包含字母、数字、点、下划线和短横线' };
      if (incoming.fingerprint && !fingerprint) return { ok: false, error: '证书指纹必须是 64 位十六进制' };
    }
    const result = applySettings({
      hasToken: true,
      token,
      hasCloud: true,
      cloud: { enabled, url, device, token: cloudToken, fingerprint, caFile },
    }, { persist: false });
    if (!result.ok) return { ok: false, error: result.error };
    try {
      await persistSettings();
    } catch {
      return { ok: false, error: '设置无法写入磁盘' };
    }
    log('info', 'settings.saved', {
      lanToken: live.token ? 'set' : 'off',
      cloud: live.cloud ? `${live.cloud.host}:${live.cloud.port}` : 'off',
      pinned: Boolean(live.cloud?.fingerprint),
    });
    return { ok: true };
  }

  /** The settings panel's read model. */
  function stateSnapshot() {
    const form = formState();
    return {
      version: VERSION,
      lan: {
        token: form.token,
        port: config.port,
        discoveryPort: config.discoveryPort,
        discover: config.discover,
        configured: config.devices.map((device) => ({ name: device.name, host: device.host, port: device.port })),
        discovered: cache.devices.map((device) => ({ name: device.name, host: device.host, port: device.port, model: device.model, version: device.version })),
      },
      cloud: {
        enabled: live.cloud !== null,
        url: form.cloud.url,
        device: form.cloud.device,
        token: form.cloud.token,
        fingerprint: form.cloud.fingerprint,
        fingerprintDisplay: displayFingerprint(form.cloud.fingerprint),
        caFile: form.cloud.caFile,
        error: live.cloudError || '',
        patchHint: config.cloud ? `${config.cloud.host}:${config.cloud.port}` : '',
      },
      runtime: {
        startedAt: new Date(startedAt).toISOString(),
        lastDelivery,
        queueLength: queued,
      },
    };
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
    api: {
      ready,
      state: stateSnapshot,
      saveSettings,
      test: async () => {
        const result = await deliver(manualPayload('DSH 通知测试', '这条通知来自 DSH 左侧栏设置面板。', 'test'));
        return { ok: result.ok, result };
      },
      probe: probeTargets,
      fingerprint: async (url) => {
        const info = await probeCertificate(cleanText(url, 300));
        return { ...info, display: displayFingerprint(info.fingerprint) };
      },
      settingsFile,
    },
    start() {
      // settings.json is read asynchronously; log after it lands so the line
      // reports the config actually in use (pinned / token / relay).
      ready.then(() => {
        if (disposed) return;
        log('info', 'plugin.loaded', {
          version: VERSION,
          port: config.port,
          discoveryPort: config.discoveryPort,
          discover: config.discover,
          notifyOn: [...config.notifyOn],
          devices: config.devices.map((device) => `${device.name}@${device.host}:${device.port}`),
          cloud: live.cloud ? `${live.cloud.host}:${live.cloud.port} device=${live.cloud.device} pinned=${Boolean(live.cloud.fingerprint)}` : (live.cloudError || config.cloudError || null),
          lanToken: live.token ? 'set' : 'off',
          minDurationMs: config.minDurationMs,
        });
      }).catch(() => {});
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

/** Read a request body with a hard size limit. */
function readRequestBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** True when the request reached the host over a loopback socket. */
function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress ?? '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Reject a browser request from another origin. The settings routes bypass the
 * DSH web auth layer (they only trust the peer address), so a page from another
 * site must not be able to POST a new relay URL and steal the token.
 */
function isCrossOriginRequest(req) {
  const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') return true;
  const origin = req.headers?.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return false;
  try {
    return new URL(origin).host !== String(req.headers?.host ?? '');
  } catch {
    return true;
  }
}

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
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

  // The settings panel talks to this local-only API. It is registered lazily so
  // a profile without the web server (headless hosts) keeps working.
  const mountRoutes = (webCtx) => {
    const routes = [];
    const guard = (handler) => async (req, res) => {
      if (!isLoopbackRequest(req)) {
        sendJson(res, 403, { ok: false, error: '仅允许在本机访问任务通知设置' });
        return;
      }
      if (isCrossOriginRequest(req)) {
        sendJson(res, 403, { ok: false, error: '拒绝跨站请求' });
        return;
      }
      try {
        await handler(req, res);
      } catch (error) {
        sendJson(res, 500, { ok: false, error: '内部错误' });
      }
    };
    const register = (path, method, handler) => {
      try {
        const dispose = webCtx.webServer.register({
          kind: 'exact',
          path,
          handler: guard(async (req, res) => {
            if (String(req.method ?? '').toUpperCase() !== method) {
              sendJson(res, 405, { ok: false, error: 'method not allowed' });
              return;
            }
            await handler(req, res);
          }),
        });
        if (typeof dispose === 'function') routes.push(dispose);
      } catch { /* route table unavailable */ }
    };

    register('/dsh-task-notify/state', 'GET', async (_req, res) => {
      await notifier.api.ready;
      sendJson(res, 200, { ok: true, editable: true, ...notifier.api.state() });
    });

    register('/dsh-task-notify/settings', 'POST', async (req, res) => {
      await notifier.api.ready;
      let body;
      try {
        body = JSON.parse(await readRequestBody(req));
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        return;
      }
      const result = await notifier.api.saveSettings(body);
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.error });
        return;
      }
      sendJson(res, 200, { ok: true, ...notifier.api.state() });
    });

    register('/dsh-task-notify/test', 'POST', async (_req, res) => {
      await notifier.api.ready;
      const result = await notifier.api.test();
      sendJson(res, 200, { ok: result.ok, ...result.result });
    });

    register('/dsh-task-notify/probe', 'POST', async (_req, res) => {
      await notifier.api.ready;
      const { devices } = await notifier.api.probe();
      sendJson(res, 200, { ok: true, devices });
    });

    register('/dsh-task-notify/fingerprint', 'POST', async (req, res) => {
      await notifier.api.ready;
      let body;
      try {
        body = JSON.parse(await readRequestBody(req));
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        return;
      }
      try {
        const info = await notifier.api.fingerprint(body?.url);
        sendJson(res, 200, { ok: true, ...info });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: cleanText(error?.message, 200) || '无法读取服务器证书' });
      }
    });

    if (typeof webCtx.effect === 'function') {
      webCtx.effect(() => () => {
        for (const dispose of routes) {
          try { dispose(); } catch { /* already disposed */ }
        }
      }, 'task-notify.routes');
    }
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mountRoutes);
  } else if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    mountRoutes(ctx);
  }
}
