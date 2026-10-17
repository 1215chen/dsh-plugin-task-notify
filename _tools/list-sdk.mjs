import fs from 'node:fs';
const t = fs.readFileSync('_tools/repository2-3.xml', 'utf8');
const blocks = t.split('<remotePackage').slice(1);
for (const b of blocks) {
  const m = b.match(/path="([^"]+)"/);
  if (!m) continue;
  const p = m[1];
  if (!/^(build-tools;34|platforms;android-34)/.test(p)) continue;
  const urls = [...b.matchAll(/<url>([^<]+)<\/url>/g)].map((x) => x[1]);
  const rev = b.match(/<major>(\d+)<\/major>\s*<minor>(\d+)<\/minor>\s*<micro>(\d+)<\/micro>/);
  console.log(p, 'rev', rev && rev.slice(1).join('.'), urls.join(' | '));
}
