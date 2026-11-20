import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = 'http://127.0.0.1:8787';
const TOKEN = 'test-token-123';
const DEVICE = 'test-phone';

async function notify(payload, token = TOKEN) {
  const response = await fetch(`${BASE}/api/v1/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ device: DEVICE, payload }),
  });
  return { status: response.status, body: await response.json() };
}

async function poll(after) {
  const response = await fetch(`${BASE}/api/v1/poll?device=${DEVICE}&after=${after}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  return { status: response.status, body: await response.json() };
}

function openStream(after) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${BASE}/api/v1/stream?device=${DEVICE}&after=${after}`, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'text/event-stream' },
    }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`stream HTTP ${response.statusCode}`));
        return;
      }
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        const match = buffer.match(/(?:^|\n)id: (\d+)\ndata: ([^\n]+)\n\n/);
        if (match) {
          response.destroy();
          resolve({ status: response.statusCode, seq: Number(match[1]), data: JSON.parse(match[2]) });
        }
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    setTimeout(() => {
      request.destroy();
      reject(new Error('stream timeout'));
    }, 5000);
  });
}

const health = await fetch(`${BASE}/api/v1/health`).then((response) => response.json());
assert.equal(health.ok, true);
console.log('PASS health', health);

const unauthorized = await notify({ v: 1, id: 'x' }, 'wrong');
assert.equal(unauthorized.status, 401);
console.log('PASS unauthorized');

const first = await notify({ v: 1, id: 'first', status: 'completed', headline: '任务完成' });
assert.equal(first.status, 200);
assert.equal(first.body.ok, true);
assert.ok(first.body.seq >= 1);
console.log('PASS notify', first.body);

const polled = await poll(0);
assert.ok(polled.body.messages.some((entry) => entry.payload.id === 'first'));
console.log('PASS poll');

const replay = await openStream(0);
assert.equal(replay.data.id, 'first');
console.log('PASS SSE replay', replay.seq);

// Wait for the replay connection to be removed, then make sure a live client
// stays registered after its request message is complete. `req` close would
// fire here while the response is still open and silently drop the client.
for (let attempt = 0; attempt < 60; attempt++) {
  const snapshot = await fetch(`${BASE}/api/v1/health`).then((response) => response.json());
  if (snapshot.clients === 0) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const livePromise = openStream(first.body.seq);
await new Promise((resolve) => setTimeout(resolve, 400));
const liveHealth = await fetch(`${BASE}/api/v1/health`).then((response) => response.json());
assert.equal(liveHealth.clients, 1, `live SSE client must stay registered, got ${liveHealth.clients}`);
console.log('PASS SSE client stays registered');

const second = await notify({ v: 1, id: 'second', status: 'error', headline: '任务失败' });
assert.equal(second.status, 200);
const live = await livePromise;
assert.equal(live.data.id, 'second');
assert.ok(live.seq > first.body.seq);
console.log('PASS SSE live', live.seq);

console.log('RELAY TESTS PASSED');
