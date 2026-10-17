import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) {
  console.error('usage: node strip-method-parameters.mjs <classes-dir>');
  process.exit(1);
}
const from = Buffer.from('MethodParameters', 'latin1');
const to = Buffer.from('XethodParameters', 'latin1');
if (from.length !== to.length) throw new Error('replacement must keep the same byte length');

let patched = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);
    if (info.isDirectory()) {
      walk(path);
      continue;
    }
    if (!name.endsWith('.class')) continue;
    const bytes = readFileSync(path);
    let index = bytes.indexOf(from);
    let changed = false;
    while (index !== -1) {
      to.copy(bytes, index);
      changed = true;
      index = bytes.indexOf(from, index + from.length);
    }
    if (changed) {
      writeFileSync(path, bytes);
      patched++;
    }
  }
}
walk(root);
console.log(`patched ${patched} class files`);
