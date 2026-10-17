import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { apply } from '../../plugin/lib/index.js';

const NOTIFY_FILE = process.env.NOTIFY_FILE || '_tmp/notifications.jsonl';
const PORT = Number(process.env.NOTIFY_PORT || 18765);

function makeSession(id, title = '季度报告生成') {
  return {
    id,
    header: { cwd: 'D:\\work\\demo' },
    requestHeader: () => ({ config: { model: 'deepseek-flash' } }),
    title,
  };
}

function makeContext() {
  const listener = { handler: null, options: null };
  const registered = { tool: null };
  const services = new Map();
  services.set('tools', { register: (tool) => { registered.tool = tool; return () => {}; } });
  services.set('sessionTitle', { get: (session) => ({ title: session.title }) });
  const disposers = [];
  return {
    listener,
    registered,
    services,
    ctx: {
      on: (event, handler, options) => { listener.handler = handler; listener.options = options; },
      get: (name) => services.get(name),
      effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {}; },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    },
    disposeAll: () => disposers.forEach((dispose) => dispose()),
  };
}

async function readNotifications() {
  try {
    const text = await readFile(NOTIFY_FILE, 'utf8');
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForCount(count, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const notifications = await readNotifications();
    if (notifications.length >= count) return notifications;
    await sleep(80);
  }
  return readNotifications();
}

function emit(harness, session, event) {
  assert.ok(harness.listener.handler, 'session/event listener registered');
  assert.equal(harness.listener.options?.global, true, 'session/event listener must be global');
  harness.listener.handler(session, event);
}

async function main() {
  const baseConfig = {
    devices: [{ host: '127.0.0.1', port: PORT, name: 'JVM Phone' }],
    discover: false,
    notifyOn: ['completed', 'error'],
    minDurationMs: 0,
    cooldownMs: 0,
    includePreview: true,
    timeoutMs: 2500,
    attempts: 1,
    logToFile: false,
  };

  const harness = makeContext();
  apply(harness.ctx, baseConfig);
  assert.ok(harness.registered.tool, 'phone_notify registered');

  // 1. A normal completed turn with a tool call and an assistant preview.
  {
    const session = makeSession('session-a');
    emit(harness, session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
    emit(harness, session, { type: 'tool/call', seq: 2, data: { turn: 1, name: 'write_file' } });
    emit(harness, session, {
      type: 'assistant/message',
      seq: 3,
      data: { turn: 1, message: { content: [{ type: 'text', text: '季度报告已经生成，文件写入 report.docx。' }] } },
    });
    emit(harness, session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } });
    const notifications = await waitForCount(1);
    assert.equal(notifications.length, 1, `expected one notification, got ${notifications.length}`);
    const payload = notifications[0];
    assert.equal(payload.status, 'completed');
    assert.equal(payload.headline, '任务完成');
    assert.equal(payload.title, '季度报告生成');
    assert.match(payload.body, /季度报告已经生成/);
    assert.equal(payload.project, 'demo');
    assert.equal(payload.model, 'deepseek-flash');
    assert.equal(payload.tools, 1);
    assert.equal(payload.status === 'completed' ? payload.headline : '', '任务完成');
    console.log('PASS turn notification payload');
  }

  // 2. An error turn reports the model failure.
  {
    const session = makeSession('session-b', '部署生产环境');
    emit(harness, session, { type: 'turn/start', seq: 10, data: { turn: 1 } });
    emit(harness, session, {
      type: 'turn/end',
      seq: 11,
      data: { turn: 1, reason: { kind: 'error', error: { message: '模型连接失败', code: 'ECONNRESET' } } },
    });
    const notifications = await waitForCount(2);
    const payload = notifications[1];
    assert.equal(payload.status, 'error');
    assert.equal(payload.headline, '任务失败');
    assert.match(payload.body, /模型连接失败/);
    console.log('PASS error notification payload');
  }

  // 3. Automatic discovery finds the receiver on the configured UDP port.
  {
    const discoveredHarness = makeContext();
    apply(discoveredHarness.ctx, { ...baseConfig, devices: [], discover: true, discoveryPort: 18766 });
    const tool = discoveredHarness.registered.tool;
    const result = await tool.execute({ action: 'discover' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.devices.length, 1, JSON.stringify(result.devices));
    assert.equal(result.devices[0].online, true);
    assert.equal(result.devices[0].port, PORT);
    discoveredHarness.disposeAll();
    console.log('PASS UDP discovery through the plugin');
  }

  // 4. The tool sends a custom notification.
  {
    const before = (await readNotifications()).length;
    const tool = harness.registered.tool;
    const testResult = await tool.execute({ action: 'test' });
    assert.equal(testResult.ok, true, JSON.stringify(testResult));
    assert.equal(testResult.devices[0].online, true);
    assert.equal(testResult.devices[0].ok, undefined);
    const afterTest = await waitForCount(before + 1);
    assert.equal(afterTest[afterTest.length - 1].status, 'test');

    const result = await tool.execute({ action: 'send', title: '自定义通知', body: '这条来自插件工具。' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.devices[0].online, true);
    assert.equal(result.devices[0].ok, undefined, 'tool output must use the declared online field');
    assert.equal(typeof result.devices[0].error, 'string');
    const after = await waitForCount(before + 2);
    assert.equal(after.length, before + 2);
    assert.equal(after[after.length - 1].title, '自定义通知');
    console.log('PASS phone_notify send');
  }

  // 5. A quick chat-only completed turn is suppressed by minDurationMs.
  {
    const quietHarness = makeContext();
    apply(quietHarness.ctx, { ...baseConfig, minDurationMs: 15000 });
    const before = (await readNotifications()).length;
    const session = makeSession('session-c', '闲聊');
    emit(quietHarness, session, { type: 'turn/start', seq: 20, data: { turn: 1 } });
    emit(quietHarness, session, { type: 'turn/end', seq: 21, data: { turn: 1, reason: { kind: 'completed' } } });
    await sleep(700);
    const after = (await readNotifications()).length;
    assert.equal(after, before, 'short chat turn must not notify');
    console.log('PASS short-turn suppression');
    quietHarness.disposeAll();
  }

  // 6. Subagent sessions are ignored by default.
  {
    const subagentHarness = makeContext();
    const root = { id: 'root' };
    subagentHarness.services.set('agents', {
      get: (id) => (id === 'session-sub' ? { id: 'sub' } : root),
      roots: () => [root],
    });
    apply(subagentHarness.ctx, baseConfig);
    const before = (await readNotifications()).length;
    const session = makeSession('session-sub');
    emit(subagentHarness, session, { type: 'turn/start', seq: 30, data: { turn: 1 } });
    emit(subagentHarness, session, { type: 'turn/end', seq: 31, data: { turn: 1, reason: { kind: 'completed' } } });
    await sleep(600);
    const after = (await readNotifications()).length;
    assert.equal(after, before, 'subagent turn must not notify');
    console.log('PASS subagent suppression');
    subagentHarness.disposeAll();
  }

  harness.disposeAll();
  console.log('ALL PLUGIN TESTS PASSED');
}

main().catch((error) => {
  console.error('TEST FAILED', error);
  process.exit(1);
});
