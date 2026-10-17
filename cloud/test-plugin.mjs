import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { apply } from '../plugin/lib/index.js';

const RELAY = process.env.RELAY_URL || 'http://127.0.0.1:8787';
const TOKEN = process.env.RELAY_TOKEN || 'test-token-123';
const DEVICE = process.env.RELAY_DEVICE || 'plugin-cloud-test';

let listener;
let tool;
const services = new Map();
services.set('tools', { register: (definition) => { tool = definition; } });
services.set('sessionTitle', { get: () => ({ title: '云端插件测试' }) });
const ctx = {
  on: (event, handler, options) => { listener = { handler, options }; },
  get: (name) => services.get(name),
  effect: (fn) => { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose(); }; },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

apply(ctx, {
  devices: [],
  discover: false,
  cloud: {
    url: RELAY,
    token: TOKEN,
    device: DEVICE,
    caFile: process.env.RELAY_CA || '',
    timeoutMs: 4000,
  },
  minDurationMs: 0,
  cooldownMs: 0,
  includePreview: true,
  attempts: 1,
  logToFile: false,
});
assert.ok(tool, 'phone_notify registered');
assert.ok(listener, 'session listener registered');

const session = {
  id: 'cloud-session',
  header: { cwd: 'D:\\work\\cloud-test' },
  requestHeader: () => ({ config: { model: 'deepseek-flash' } }),
  title: '云端插件测试',
};
listener.handler(session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
listener.handler(session, { type: 'tool/call', seq: 2, data: { turn: 1, name: 'write_file' } });
listener.handler(session, {
  type: 'assistant/message',
  seq: 3,
  data: { turn: 1, message: { content: [{ type: 'text', text: '云端中继测试完成。' }] } },
});
listener.handler(session, {
  type: 'approval/asked',
  seq: 4,
  data: { id: 'approval-cloud-test', toolName: 'shell', reason: '需要在工作区外执行命令' },
});
listener.handler(session, { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } });

let found;
let approval;
const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  const response = await fetch(`${RELAY}/api/v1/poll?device=${encodeURIComponent(DEVICE)}&after=0`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await response.json();
  found = body.messages?.find((entry) => entry.payload?.title === '云端插件测试');
  approval = body.messages?.find((entry) => entry.payload?.status === 'approval' && entry.payload?.approvalId === 'approval-cloud-test');
  if (found && approval) break;
  await sleep(100);
}
assert.ok(found, 'cloud relay must receive the turn-end payload');
assert.equal(found.payload.status, 'completed');
assert.match(found.payload.body, /云端中继测试完成/);
assert.ok(approval, 'cloud relay must receive the approval payload');
assert.equal(approval.payload.headline, '需要授权');
assert.equal(approval.payload.toolName, 'shell');
assert.match(approval.payload.body, /shell/);
console.log('PASS turn-end payload reached cloud relay', found.seq);
console.log('PASS approval payload reached cloud relay', approval.seq);

const discover = await tool.execute({ action: 'discover' });
assert.equal(discover.ok, true, JSON.stringify(discover));
assert.ok(discover.devices.some((device) => device.name === '云端中继' && device.online === true), JSON.stringify(discover.devices));
console.log('PASS cloud discover');

const test = await tool.execute({ action: 'test' });
assert.equal(test.ok, true, JSON.stringify(test));
assert.ok(test.devices.some((device) => device.name === '云端中继' && device.online === true), JSON.stringify(test.devices));
assert.ok(!('ok' in test.devices[0]), 'tool output must use online, not ok');
console.log('PASS cloud tool test');

console.log('CLOUD PLUGIN TESTS PASSED');
