import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const src = process.argv[2];
const dest = process.argv[3];
if (!src || !dest) {
  console.error('usage: node extract-asar.mjs <app.asar> <dest>');
  process.exit(1);
}
const buf = readFileSync(src);
const headerSize = buf.readUInt32LE(4);
const jsonLen = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
const baseOffset = 16 + jsonLen;
console.log('headerSize', headerSize, 'jsonLen', jsonLen, 'baseOffset', baseOffset, 'files', jsonLen);

let count = 0;
let bytes = 0;
function walk(node, rel) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const next = join(rel, name);
    if (child.files) {
      mkdirSync(join(dest, next), { recursive: true });
      walk(child, next);
    } else if (typeof child.offset === 'string') {
      const start = baseOffset + Number(child.offset);
      const size = Number(child.size);
      const out = join(dest, next);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, buf.subarray(start, start + size));
      count++;
      bytes += size;
    }
  }
}
if (existsSync(dest)) console.log('dest exists, merging');
else mkdirSync(dest, { recursive: true });
walk(header, '');
console.log('extracted', count, 'files', bytes, 'bytes');
