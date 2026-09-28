// Keeps the marketplace's archive pin true to what the release builds. The jev-gate plugin runs from dist, which is not
// committed, so its marketplace entry is the release archive pinned by SHA-256 rather than a relative path that would
// install without dist; the Function Hooks Mods run from their TypeScript and ship from their source directories.
// Usage, after `npm run build`:
//   node scripts/release.mjs pin                          pack the archive, write its URL and SHA-256 into the entry
//   node scripts/release.mjs check [--tag vX.Y.Z] [--out <dir>]
//                                                        pack it again and fail unless it matches the pin; with --out,
//                                                        keep the archive and the release notes there for upload
// Both refuse unless package.json, every plugin.json and the tag carry one version.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = 'MongLong0214/jev-gate';
const MARKETPLACE = join(root, '.claude-plugin', 'marketplace.json');
const MANIFESTS = ['.claude-plugin/plugin.json', 'mods/compact/.claude-plugin/plugin.json', 'mods/router/.claude-plugin/plugin.json'];

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : null;
};
const fail = (message) => {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
};
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

const version = readJson('package.json').version;
for (const rel of MANIFESTS) {
  const v = readJson(rel).version;
  if (v !== version) fail(`${rel} is at ${v}, package.json at ${version}`);
}
const tag = flag('tag');
if (tag !== null && tag !== `v${version}`) fail(`tag ${tag} does not name package.json's version ${version}`);

const archiveName = `jev-gate-${version}.zip`;
const url = `https://github.com/${REPO}/releases/download/v${version}/${archiveName}`;

const packed = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-gate-release-'));
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), dir], { encoding: 'utf8' });
  if (run.status !== 0) fail(`pack failed: ${run.stderr.trim()}`);
  const path = join(dir, archiveName);
  return { dir, path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
};

const marketplace = JSON.parse(readFileSync(MARKETPLACE, 'utf8'));
const entry = marketplace.plugins.find((p) => p.name === 'jev-gate');
if (!entry || entry.source?.source !== 'archive') fail('the marketplace has no archive entry named jev-gate');

if (command === 'pin') {
  const { dir, sha256 } = packed();
  rmSync(dir, { recursive: true, force: true });
  entry.source = { source: 'archive', url, sha256 };
  writeFileSync(MARKETPLACE, `${JSON.stringify(marketplace, null, 2)}\n`);
  process.stdout.write(`pinned ${archiveName} ${sha256}\n`);
} else if (command === 'check') {
  const { dir, path, sha256 } = packed();
  const problems = [];
  if (entry.source.url !== url) problems.push(`the entry's url is ${entry.source.url}, expected ${url}`);
  if (entry.source.sha256 !== sha256) problems.push(`the entry pins ${entry.source.sha256}, this tree packs ${sha256}`);
  const out = flag('out');
  if (out !== null && problems.length === 0) {
    mkdirSync(out, { recursive: true });
    copyFileSync(path, join(out, archiveName));
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const section = changelog.split(/^## /m).find((s) => s.startsWith(`v${version} `) || s.startsWith(`v${version}\n`));
    if (!section) problems.push(`CHANGELOG.md has no "## v${version}" section`);
    else writeFileSync(join(out, 'NOTES.md'), `${section.slice(section.indexOf('\n') + 1).trim()}\n\nArchive SHA-256: \`${sha256}\`\n`);
  }
  rmSync(dir, { recursive: true, force: true });
  if (problems.length) fail(`${problems.join('; ')} (run npm run build && node scripts/release.mjs pin)`);
  process.stdout.write(`ok ${archiveName} ${sha256}\n`);
} else {
  fail('usage: node scripts/release.mjs pin | check [--tag vX.Y.Z] [--out <dir>]');
}
