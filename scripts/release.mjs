// Keeps the marketplace's archive pin true to what the release builds. The jev-gate plugin runs from dist, which is not
// committed, so its marketplace entry is the release archive pinned by SHA-256 rather than a relative path that would
// install without dist; the Function Hooks Mods run from their TypeScript and ship from their source directories.
// Usage, after `npm run build`:
//   node scripts/release.mjs pin                          pack the archive, write its URL and SHA-256 into the entry
//   node scripts/release.mjs check [--tag vX.Y.Z] [--against <ref>] [--asset <file>] [--out <dir>]
//                                                        pack it again and fail unless it matches the pin; --against
//                                                        also requires <ref> (the served marketplace) to serve this
//                                                        version with this entry and these plugin files, or a later
//                                                        version; --asset requires a published file to be the pinned
//                                                        archive; with --out, keep the archive and the release notes
//                                                        there for upload
// Both refuse unless package.json, every plugin.json and the tag carry one version, and once a version is released (its
// tag exists) its content is frozen: a user updates only when the version changes, so the same version with another
// archive or other plugin files would leave installed copies stale and make the published archive fail its pin.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO = 'MongLong0214/jev-gate';
const MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
const MANIFESTS = [
  '.claude-plugin/plugin.json',
  'mods/compact/.claude-plugin/plugin.json',
  'mods/router/.claude-plugin/plugin.json',
  'mods/output/.claude-plugin/plugin.json',
  'plugins/evidence/.claude-plugin/plugin.json',
];

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
const git = (...args) => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { ok: run.status === 0, out: (run.stdout ?? '').trim(), err: (run.stderr ?? '').trim() };
};

const version = readJson('package.json').version;
for (const rel of MANIFESTS) {
  const v = readJson(rel).version;
  if (v !== version) fail(`${rel} is at ${v}, package.json at ${version}`);
}
const tag = flag('tag');
if (tag !== null && tag !== `v${version}`) fail(`tag ${tag} does not name package.json's version ${version}`);

const archiveName = `jev-gate-${version}.zip`;
const url = `https://github.com/${REPO}/releases/download/v${version}/${archiveName}`;
const archiveEntry = (m) => m.plugins.find((p) => p.name === 'jev-gate');

const marketplace = readJson(MARKETPLACE_PATH);
const entry = archiveEntry(marketplace);
if (!entry || entry.source?.source !== 'archive') fail('the marketplace has no archive entry named jev-gate');
const sourceDirs = marketplace.plugins.filter((p) => typeof p.source === 'string').map((p) => p.source.replace(/^\.\//, ''));

const packed = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-gate-release-'));
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), dir], { encoding: 'utf8' });
  if (run.status !== 0) fail(`pack failed: ${run.stderr.trim()}`);
  const path = join(dir, archiveName);
  return { dir, path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
};

// A released version (its tag exists) must keep the archive it was released with and its plugins' files; the working
// tree is compared, so an uncommitted change counts. Without git the answer is unknown, and unknown refuses.
const frozenProblems = (sha256) => {
  // A shallow clone, such as CI's default checkout, has no tags: absence there is refused rather than read as unreleased.
  const shallow = git('rev-parse', '--is-shallow-repository');
  if (!shallow.ok) return [`cannot read git to learn whether v${version} is released: ${shallow.err}`];
  if (shallow.out !== 'false') return [`a shallow checkout cannot tell whether v${version} is released; fetch full history and tags`];
  const released = git('rev-parse', '-q', '--verify', `refs/tags/v${version}^{commit}`);
  if (!released.ok) return [];
  const problems = [];
  const then = git('show', `v${version}:${MARKETPLACE_PATH}`);
  const thenPin = then.ok ? archiveEntry(JSON.parse(then.out))?.source?.sha256 : undefined;
  if (thenPin !== sha256) problems.push(`v${version} is released with archive ${thenPin ?? '(none)'}, this tree packs ${sha256}`);
  const changed = git('diff', '--name-only', `v${version}`, '--', ...sourceDirs);
  if (!changed.ok) problems.push(`cannot compare ${sourceDirs.join(', ')} with v${version}: ${changed.err}`);
  else if (changed.out) problems.push(`changed since v${version} at the same version: ${changed.out.split('\n').join(', ')}`);
  return problems.length ? [...problems, `raise the version in package.json and every plugin.json`] : [];
};

const later = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && x[i] > y[i];
};

// The served marketplace at this version must serve exactly this entry and these plugin files. A later version there
// has moved on and this release no longer decides what installs, so it passes rather than reading as a mismatch that
// would withdraw a valid release; an earlier one does not serve this version yet.
const servedProblems = (ref) => {
  const pkg = git('show', `${ref}:package.json`);
  if (!pkg.ok) return [`cannot read the version ${ref} serves: ${pkg.err}`];
  const servedVersion = JSON.parse(pkg.out).version;
  if (servedVersion !== version) return later(servedVersion, version) ? [] : [`${ref} serves v${servedVersion}, not v${version} yet`];
  const problems = [];
  const served = git('show', `${ref}:${MARKETPLACE_PATH}`);
  const servedSource = served.ok ? archiveEntry(JSON.parse(served.out))?.source : undefined;
  if (JSON.stringify(servedSource) !== JSON.stringify(entry.source)) {
    problems.push(`${ref} serves ${JSON.stringify(servedSource ?? null)}, not this entry ${JSON.stringify(entry.source)}`);
  }
  const changed = git('diff', '--name-only', ref, '--', ...sourceDirs);
  if (!changed.ok) problems.push(`cannot compare ${sourceDirs.join(', ')} with ${ref}: ${changed.err}`);
  else if (changed.out) problems.push(`${ref} serves v${version} with other plugin files: ${changed.out.split('\n').join(', ')}`);
  return problems;
};

if (command === 'pin') {
  const { dir, sha256 } = packed();
  rmSync(dir, { recursive: true, force: true });
  const frozen = frozenProblems(sha256);
  if (frozen.length) fail(frozen.join('; '));
  entry.source = { source: 'archive', url, sha256 };
  writeFileSync(join(root, MARKETPLACE_PATH), `${JSON.stringify(marketplace, null, 2)}\n`);
  process.stdout.write(`pinned ${archiveName} ${sha256}\n`);
} else if (command === 'check') {
  const { dir, path, sha256 } = packed();
  const problems = [];
  if (entry.source.url !== url) problems.push(`the entry's url is ${entry.source.url}, expected ${url}`);
  if (entry.source.sha256 !== sha256) problems.push(`the entry pins ${entry.source.sha256}, this tree packs ${sha256}`);
  problems.push(...frozenProblems(sha256));
  const against = flag('against');
  if (against !== null) problems.push(...servedProblems(against));
  const asset = flag('asset');
  if (asset !== null) {
    let published = null;
    try {
      published = createHash('sha256').update(readFileSync(asset)).digest('hex');
    } catch (error) {
      problems.push(`cannot read ${asset}: ${error.message}`);
    }
    if (published !== null && published !== entry.source.sha256) {
      problems.push(`${asset} is ${published}, the entry pins ${entry.source.sha256}`);
    }
  }
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
  if (problems.length) fail(problems.join('; '));
  process.stdout.write(`ok ${archiveName} ${sha256}\n`);
} else {
  fail('usage: node scripts/release.mjs pin | check [--tag vX.Y.Z] [--against <ref>] [--asset <file>] [--out <dir>]');
}
