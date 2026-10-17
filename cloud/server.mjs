/**
 * DSH task-notify cloud relay.
 *
 * A dependency-free Node.js relay for the DSH task notification plugin:
 *   - desktop plugin: POST /api/v1/notify  (Bearer token)
 *   - Android app:    GET  /api/v1/stream  (SSE, Bearer token)
 *   - diagnostics:    GET  /api/v1/poll, /api/v1/health
 *
 * Each device has a bounded queue so a phone that was offline can catch up on
 * reconnect through Last-Event-ID. TLS is normally terminated by Caddy/Nginx;
 * optional TLS_CERT/TLS_KEY files let the relay terminate TLS itself.
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEVICE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_MAX_QUEUE = 200;
const DEFAULT_MAX_BODY = 256 * 1024;
const DEFAULT_HEARTBEAT_MS = 20000;

function json(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(data);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function readBody(req, limit) {
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

function validDevice(value) {
  return typeof value === 'string' && DEVICE_PATTERN.test(value);
}

/**
 * Build the relay without starting it (useful for tests).
 * @param {object} options
 * @returns {object} relay
 */
export function createRelay(options = {}) {
  const token = String(options.token ?? '').trim();
  if (!token) throw new Error('TOKEN is required');
  const port = Number.isInteger(options.port) ? options.port : 8787;
  const host = options.host ?? '0.0.0.0';
  const dataDir = options.dataDir ?? path.resolve('data');
  const maxQueue = Math.max(1, Math.min(2000, Number(options.maxQueue) || DEFAULT_MAX_QUEUE));
  const maxBody = Math.max(1024, Math.min(1024 * 1024, Number(options.maxBody) || DEFAULT_MAX_BODY));
  const heartbeatMs = Math.max(5000, Math.min(120000, Number(options.heartbeatMs) || DEFAULT_HEARTBEAT_MS));
  const log = options.log ?? ((line) => console.log(line));
  const stateFile = path.join(dataDir, 'state.json');
  const devices = new Map();
  const clients = new Map();
  let server;
  let saveTimer;
  let savePromise = Promise.resolve();
  let startedAt = 0;
  let closed = false;

  function deviceState(name) {
    let state = devices.get(name);
    if (!state) {
      state = { seq: 0, queue: [] };
      devices.set(name, state);
    }
    return state;
  }

  function enqueue(device, payload) {
    const state = deviceState(device);
    state.seq += 1;
    state.queue.push({ seq: state.seq, at: Date.now(), payload });
    while (state.queue.length > maxQueue) state.queue.shift();
    scheduleSave();
    return state.seq;
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      savePromise = savePromise.then(saveNow).catch((error) => log(`[save] ${error.message}`));
    }, 200);
  }

  async function saveNow() {
    const snapshot = { version: 1, savedAt: new Date().toISOString(), devices: {} };
    for (const [name, state] of devices) snapshot.devices[name] = state;
    await fsp.mkdir(dataDir, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    await fsp.rename(tmp, stateFile);
    try { await fsp.chmod(stateFile, 0o600); } catch { /* best effort */ }
  }

  async function loadState() {
    try {
      const parsed = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.devices) return;
      for (const [name, raw] of Object.entries(parsed.devices)) {
        if (!validDevice(name) || !raw || !Number.isSafeInteger(raw.seq) || raw.seq < 0) continue;
        const queue = Array.isArray(raw.queue)
          ? raw.queue.filter((entry) => entry && Number.isSafeInteger(entry.seq) && entry.payload && typeof entry.payload === 'object').slice(-maxQueue)
          : [];
        devices.set(name, { seq: raw.seq, queue });
      }
      log(`[state] loaded ${devices.size} device(s)`);
    } catch (error) {
      if (error.code !== 'ENOENT') log(`[state] load failed: ${error.message}`);
    }
  }

  function authorized(req, url) {
    const header = req.headers.authorization ?? '';
    const provided = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : String(url.searchParams.get('token') ?? '');
    return safeEqual(provided, token);
  }

  function totalClients() {
    let total = 0;
    for (const set of clients.values()) total += set.size;
    return total;
  }

  function writeEvent(res, entry) {
    if (res.writableEnded || res.destroyed) return false;
    return res.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry.payload)}\n\n`);
  }

  function broadcast(device, entry) {
    const set = clients.get(device);
    if (!set) return;
    for (const client of [...set]) {
      try {
        if (!writeEvent(client.res, entry)) client.res.destroy();
      } catch {
        client.res.destroy();
      }
    }
  }

  function openStream(req, res, url) {
    const device = String(url.searchParams.get('device') ?? '');
    if (!validDevice(device)) return json(res, 400, { ok: false, error: 'invalid device' });
    if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');

    const state = deviceState(device);
    const headerId = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10);
    const queryId = Number.parseInt(String(url.searchParams.get('after') ?? ''), 10);
    const hasCursor = Number.isSafeInteger(headerId) && headerId >= 0
      ? true
      : Number.isSafeInteger(queryId) && queryId >= 0;
    const after = hasCursor
      ? (Number.isSafeInteger(headerId) && headerId >= 0 ? headerId : queryId)
      : state.seq;
    for (const entry of state.queue) {
      if (entry.seq > after) writeEvent(res, entry);
    }

    let set = clients.get(device);
    if (!set) {
      set = new Set();
      clients.set(device, set);
    }
    const client = { res, device, heartbeat: undefined, closed: false };
    const cleanup = () => {
      if (client.closed) return;
      client.closed = true;
      clearInterval(client.heartbeat);
      set.delete(client);
      if (set.size === 0) clients.delete(device);
      log(`[sse] close device=${device} clients=${set.size}`);
    };
    set.add(client);
    client.heartbeat = setInterval(() => {
      if (client.closed || res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }
      try { res.write(': ping\n\n'); } catch { cleanup(); }
    }, heartbeatMs);
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('close', cleanup);
    log(`[sse] open device=${device} after=${after} clients=${set.size}`);
  }

  async function handleNotify(req, res) {
    if (!authorized(req, new URL(req.url, 'http://relay'))) {
      return json(res, 401, { ok: false, error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req, maxBody));
    } catch {
      return json(res, 400, { ok: false, error: 'invalid json' });
    }
    if (!body || typeof body !== 'object') return json(res, 400, { ok: false, error: 'invalid body' });
    const device = String(body.device ?? '');
    if (!validDevice(device)) return json(res, 400, { ok: false, error: 'invalid device' });
    const payload = body.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json(res, 400, { ok: false, error: 'invalid payload' });
    }
    const seq = enqueue(device, payload);
    const entry = { seq, at: Date.now(), payload };
    broadcast(device, entry);
    const queueSize = deviceState(device).queue.length;
    log(`[push] device=${device} seq=${seq} clients=${clients.get(device)?.size ?? 0} queue=${queueSize}`);
    return json(res, 200, { ok: true, device, seq, queue: queueSize, clients: clients.get(device)?.size ?? 0 });
  }

  function handlePoll(req, res, url) {
    if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    const device = String(url.searchParams.get('device') ?? '');
    if (!validDevice(device)) return json(res, 400, { ok: false, error: 'invalid device' });
    const after = Number.parseInt(String(url.searchParams.get('after') ?? '0'), 10);
    const state = deviceState(device);
    const messages = state.queue.filter((entry) => entry.seq > (Number.isSafeInteger(after) ? after : 0));
    return json(res, 200, { ok: true, device, seq: state.seq, messages });
  }

  function handleHealth(res) {
    let queue = 0;
    for (const state of devices.values()) queue += state.queue.length;
    return json(res, 200, {
      ok: true,
      app: 'dsh-task-notify-relay',
      version: 1,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      devices: devices.size,
      clients: totalClients(),
      queued: queue,
    });
  }

  async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://relay');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Last-Event-ID',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        });
        return res.end();
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) {
        return json(res, 200, { ok: true, app: 'dsh-task-notify-relay', stream: '/api/v1/stream', notify: '/api/v1/notify' });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/health') return handleHealth(res);
      if (req.method === 'GET' && url.pathname === '/api/v1/ping') {
        if (!authorized(req, url)) return json(res, 401, { ok: false, error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
        return json(res, 200, { ok: true, app: 'dsh-task-notify-relay', version: 1, time: Date.now() });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/stream') return openStream(req, res, url);
      if (req.method === 'GET' && url.pathname === '/api/v1/poll') return handlePoll(req, res, url);
      if (req.method === 'POST' && url.pathname === '/api/v1/notify') return await handleNotify(req, res);
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
      else res.destroy();
      log(`[error] ${error?.message ?? error}`);
    }
  }

  async function start() {
    if (server) return { port: server.address()?.port };
    startedAt = Date.now();
    await fsp.mkdir(dataDir, { recursive: true });
    await loadState();
    if (options.tlsCert && options.tlsKey) {
      server = https.createServer({
        cert: await fsp.readFile(options.tlsCert),
        key: await fsp.readFile(options.tlsKey),
      }, handler);
    } else {
      server = http.createServer(handler);
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    log(`[relay] listening on ${typeof address === 'object' && address ? `${address.address}:${address.port}` : String(address)}`);
    return { port: typeof address === 'object' && address ? address.port : port };
  }

  async function close() {
    if (closed) return;
    closed = true;
    if (saveTimer) clearTimeout(saveTimer);
    for (const set of clients.values()) {
      for (const client of set) {
        try { client.res.end(); } catch { /* ignore */ }
      }
    }
    clients.clear();
    await new Promise((resolve) => server ? server.close(() => resolve()) : resolve());
    try { await saveNow(); } catch (error) { log(`[save] ${error.message}`); }
  }

  return {
    start,
    close,
    handle: handler,
    state: devices,
    clients,
    get port() {
      const address = server?.address();
      return typeof address === 'object' && address ? address.port : port;
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const token = String(process.env.TOKEN ?? '').trim();
  if (!token) {
    console.error('TOKEN is required (for example: export TOKEN=$(openssl rand -hex 32))');
    process.exit(1);
  }
  const relay = createRelay({
    port: Number(process.env.PORT) || 8787,
    host: process.env.HOST || '0.0.0.0',
    token,
    dataDir: process.env.DATA_DIR || path.resolve('data'),
    maxQueue: Number(process.env.MAX_QUEUE) || DEFAULT_MAX_QUEUE,
    heartbeatMs: Number(process.env.HEARTBEAT_MS) || DEFAULT_HEARTBEAT_MS,
    tlsCert: process.env.TLS_CERT || '',
    tlsKey: process.env.TLS_KEY || '',
  });
  await relay.start();
  const shutdown = async () => {
    console.log('[relay] shutting down');
    await relay.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
