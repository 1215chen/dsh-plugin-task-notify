import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const [url, dest] = process.argv.slice(2);
if (!url || !dest) {
  console.error('usage: node download.mjs <url> <dest>');
  process.exit(1);
}
const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
const total = Number(res.headers.get('content-length') || 0);
let got = 0;
let last = 0;
const body = Readable.fromWeb(res.body);
body.on('data', (chunk) => {
  got += chunk.length;
  const now = Date.now();
  if (now - last > 1000) {
    last = now;
    const pct = total ? ((got / total) * 100).toFixed(1) : '?';
    console.log(`${dest}: ${(got / 1048576).toFixed(1)} MiB / ${(total / 1048576).toFixed(1)} MiB (${pct}%)`);
  }
});
await pipeline(body, createWriteStream(dest));
console.log(`done ${dest} ${got} bytes`);
