// Exercises the local settings API behind the sidebar panel without DSH:
// a mock web server collects the plugin's routes, and the test drives them with
// loopback requests the same way the browser panel does.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { apply } from '../lib/index.js';

const home = mkdtempSync(join(tmpdir(), 'dtn-settings-'));
process.env.DSH_HOME = home;

const routes = new Map();
const webServer = {
  register(route) {
    routes.set(`${route.path}`, route.handler);
    return () => routes.delete(route.path);
  },
};

const ctx = {
  on: () => {},
  get: () => undefined,
  effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  inject: (deps, callback) => { callback({ webServer, effect: (fn) => fn() }); },
};

apply(ctx, {
  discover: false,
  devices: [],
  logToFile: false,
});

function request(path, { method = 'GET', body, remote = '127.0.0.1', headers = {} } = {}) {
  const handler = routes.get(path);
  assert.ok(handler, `route ${path} registered`);
  const req = new Readable({ read() {} });
  req.method = method;
  req.socket = { remoteAddress: remote };
  req.headers = { host: '127.0.0.1:1234', ...headers };
  if (body !== undefined) req.push(JSON.stringify(body));
  req.push(null);
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      chunks: [],
      writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
      end(data) {
        if (data) this.chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
        resolve({ status: this.statusCode, text: Buffer.concat(this.chunks).toString('utf8') });
      },
      destroy(error) { reject(error ?? new Error('destroyed')); },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}

const stateResponse = await request('/dsh-task-notify/state');
assert.equal(stateResponse.status, 200);
const state = JSON.parse(stateResponse.text);
assert.equal(state.ok, true);
assert.equal(state.version, '1.2.2');
assert.equal(state.cloud.enabled, false);
assert.equal(state.lan.token, '');
console.log('PASS GET /state');

const saved = await request('/dsh-task-notify/settings', {
  method: 'POST',
  body: {
    token: 'lan-secret',
    cloud: {
      enabled: true,
      url: 'https://relay.example.com:56159/',
      device: 'vivo-v2154a',
      token: 'cloud-secret',
      fingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
      caFile: '',
    },
  },
});
assert.equal(saved.status, 200, saved.text);
const afterSave = JSON.parse(saved.text);
assert.equal(afterSave.lan.token, 'lan-secret');
assert.equal(afterSave.cloud.enabled, true);
assert.equal(afterSave.cloud.url, 'https://relay.example.com:56159');
assert.equal(afterSave.cloud.fingerprint.length, 64);
assert.equal(afterSave.cloud.fingerprintDisplay.split(':').length, 32);
console.log('PASS POST /settings keeps the form and normalizes the fingerprint');

const settingsFile = join(home, 'storages', 'task-notify', 'settings.json');
assert.ok(existsSync(settingsFile), 'settings.json written');
const stored = JSON.parse(readFileSync(settingsFile, 'utf8'));
assert.equal(stored.token, 'lan-secret');
assert.equal(stored.cloud.token, 'cloud-secret');
assert.equal(stored.cloud.enabled, true);
console.log('PASS settings.json persists the editable fields');

const rejected = await request('/dsh-task-notify/settings', {
  method: 'POST',
  body: { token: '', cloud: { enabled: true, url: 'http://relay.example.com:56159', token: 'x', device: 'p' } },
});
assert.equal(rejected.status, 400);
assert.match(JSON.parse(rejected.text).error, /https/);
console.log('PASS plain http cloud URL rejected');

const forbidden = await request('/dsh-task-notify/state', { remote: '192.168.1.50' });
assert.equal(forbidden.status, 403);
console.log('PASS non-loopback request rejected');

const crossOrigin = await request('/dsh-task-notify/state', { headers: { origin: 'http://evil.example' } });
assert.equal(crossOrigin.status, 403);
console.log('PASS cross-origin request rejected');

const crossSite = await request('/dsh-task-notify/state', { headers: { 'sec-fetch-site': 'cross-site' } });
assert.equal(crossSite.status, 403);
console.log('PASS cross-site fetch metadata rejected');

const sameOrigin = await request('/dsh-task-notify/state', { headers: { origin: 'http://127.0.0.1:1234' } });
assert.equal(sameOrigin.status, 200);
console.log('PASS same-origin request accepted');

const wrongMethod = await request('/dsh-task-notify/state', { method: 'POST' });
assert.equal(wrongMethod.status, 405);
console.log('PASS wrong method rejected');

const testResponse = await request('/dsh-task-notify/test', { method: 'POST' });
assert.equal(testResponse.status, 200);
const testResult = JSON.parse(testResponse.text);
assert.equal(testResult.ok, false, 'no receiver is configured, so the test must report failure');
console.log('PASS POST /test reports a missing receiver');

console.log('SETTINGS API TESTS PASSED');
