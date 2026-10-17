import fs from 'node:fs';
import path from 'node:path';

const profileDir = process.argv[2];
const tarball = process.argv[3] || 'dsh-plugin-task-notify-0.1.1.tgz';
if (!profileDir) {
  console.error('usage: node fix-profile-manifest.mjs <profile-dir> [tarball-name]');
  process.exit(1);
}
const manifestPath = path.join(profileDir, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.dependencies ??= {};
manifest.dependencies['dsh-plugin-task-notify'] = `file:vendor/${tarball}`;
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
if (!bundles.includes('dsh-plugin-task-notify')) bundles.push('dsh-plugin-task-notify');
manifest.dsh.profile.bundles = bundles;
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ dependencies: manifest.dependencies, bundles }, null, 2));
