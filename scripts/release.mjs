// Keeps the marketplace's archive pins true to what the release builds. The jev-gate plugin and the evidence server
// (#77) run from build output, which is not committed, so their marketplace entries are release archives pinned by
// SHA-256 rather than relative paths that would install without it; the Function Hooks Mods run from their TypeScript
// and ship from their source directories.
// Usage, after `npm run build`:
//   node scripts/release.mjs pin                          pack each archive, write its URL and SHA-256 into its entry
//   node scripts/release.mjs check [--tag vX.Y.Z] [--against <ref>] [--asset <file>]... [--out <dir>]
//                                                        pack them again and fail unless each matches its pin;
//                                                        --against also requires <ref> (the served marketplace) to
//                                                        serve this version with these entries and these plugin files,
//                                                        or a later version; each --asset requires a published file to
//                                                        be the pinned archive of its name; with --out, keep the
//                                                        archives and the release notes there for upload
// Both refuse unless package.json, every plugin.json and the tag carry one version, and once a version is released (its
// tag exists) its content is frozen: a user updates only when the version changes, so the same version with another
// archive or other plugin files would leave installed copies stale and make the published archive fail its pin.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
const fail = (message) => {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
};
// A flag with no value would skip the check it asks for, so it refuses instead.
const flags = (name) =>
  rest.flatMap((a, i) => {
    if (a !== `--${name}`) return [];
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`);
    return [value];
  });
const flag = (name) => flags(name)[0] ?? null;
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

// The pack profile that builds each archive entry the marketplace may list; jev-gate is required.
const PROFILES = { 'jev-gate': 'legacy', 'jev-gate-evidence': 'evidence' };
const entryOf = (m, name) => m.plugins.find((p) => p.name === name);

const marketplace = readJson(MARKETPLACE_PATH);
if (entryOf(marketplace, 'jev-gate')?.source?.source !== 'archive') fail('the marketplace has no archive entry named jev-gate');
const archives = marketplace.plugins
  .filter((p) => p.source?.source === 'archive')
  .map((entry) => {
    if (!(entry.name in PROFILES)) fail(`the marketplace lists an archive entry ${entry.name} that no pack profile builds`);
    const name = `${entry.name}-${version}.zip`;
    return { entry, name, profile: PROFILES[entry.name], url: `https://github.com/${REPO}/releases/download/v${version}/${name}` };
  });
const sourceDirs = marketplace.plugins.filter((p) => typeof p.source === 'string').map((p) => p.source.replace(/^\.\//, ''));

const packed = (a) => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-gate-release-'));
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'pack.mjs'), dir, '--profile', a.profile], { encoding: 'utf8' });
  if (run.status !== 0) fail(`pack failed: ${run.stderr.trim()}`);
  const path = join(dir, a.name);
  return { dir, path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
};

// A released version (its tag exists) must keep the archive it was released with and its plugins' files; the working
// tree is compared, so an uncommitted change counts. Without git the answer is unknown, and unknown refuses.
// An archive entry added after the release has no pin there, which refuses like any other change.
const frozenProblems = (packs) => {
  // A shallow clone, such as CI's default checkout, has no tags: absence there is refused rather than read as unreleased.
  const shallow = git('rev-parse', '--is-shallow-repository');
  if (!shallow.ok) return [`cannot read git to learn whether v${version} is released: ${shallow.err}`];
  if (shallow.out !== 'false') return [`a shallow checkout cannot tell whether v${version} is released; fetch full history and tags`];
  const released = git('rev-parse', '-q', '--verify', `refs/tags/v${version}^{commit}`);
  if (!released.ok) return [];
  const problems = [];
  const then = git('show', `v${version}:${MARKETPLACE_PATH}`);
  const thenPlugins = then.ok ? JSON.parse(then.out).plugins : [];
  for (const [a, { sha256 }] of packs) {
    const thenPin = entryOf({ plugins: thenPlugins }, a.entry.name)?.source?.sha256;
    if (thenPin !== sha256) problems.push(`v${version} is released with ${a.name} ${thenPin ?? '(none)'}, this tree packs ${sha256}`);
  }
  // An entry dropped at the same version would leave installed copies with nothing to update to.
  const names = (ps) => ps.map((p) => p.name).sort().join(', ');
  if (names(thenPlugins) !== names(marketplace.plugins)) {
    problems.push(`v${version} is released with entries ${names(thenPlugins)}, this tree lists ${names(marketplace.plugins)}`);
  }
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
  const servedArchives = served.ok ? JSON.parse(served.out).plugins.filter((p) => p.source?.source === 'archive') : [];
  for (const { entry } of archives) {
    const servedSource = servedArchives.find((p) => p.name === entry.name)?.source;
    if (JSON.stringify(servedSource) !== JSON.stringify(entry.source)) {
      problems.push(`${ref} serves ${JSON.stringify(servedSource ?? null)}, not this entry ${JSON.stringify(entry.source)}`);
    }
  }
  const extra = servedArchives.filter((p) => !archives.some((a) => a.entry.name === p.name)).map((p) => p.name);
  if (extra.length) problems.push(`${ref} serves archive entries this tree does not: ${extra.join(', ')}`);
  const changed = git('diff', '--name-only', ref, '--', ...sourceDirs);
  if (!changed.ok) problems.push(`cannot compare ${sourceDirs.join(', ')} with ${ref}: ${changed.err}`);
  else if (changed.out) problems.push(`${ref} serves v${version} with other plugin files: ${changed.out.split('\n').join(', ')}`);
  return problems;
};

const packs = new Map(archives.map((a) => [a, packed(a)]));
const cleanup = () => {
  for (const { dir } of packs.values()) rmSync(dir, { recursive: true, force: true });
};

if (command === 'pin') {
  cleanup();
  const frozen = frozenProblems(packs);
  if (frozen.length) fail(frozen.join('; '));
  for (const [a, { sha256 }] of packs) a.entry.source = { source: 'archive', url: a.url, sha256 };
  writeFileSync(join(root, MARKETPLACE_PATH), `${JSON.stringify(marketplace, null, 2)}\n`);
  for (const [a, { sha256 }] of packs) process.stdout.write(`pinned ${a.name} ${sha256}\n`);
} else if (command === 'check') {
  const problems = [];
  for (const [a, { sha256 }] of packs) {
    if (a.entry.source.url !== a.url) problems.push(`${a.entry.name}'s url is ${a.entry.source.url}, expected ${a.url}`);
    if (a.entry.source.sha256 !== sha256) problems.push(`${a.entry.name} pins ${a.entry.source.sha256}, this tree packs ${sha256}`);
  }
  problems.push(...frozenProblems(packs));
  const against = flag('against');
  if (against !== null) problems.push(...servedProblems(against));
  for (const asset of flags('asset')) {
    const a = archives.find((x) => x.name === basename(asset));
    if (!a) {
      problems.push(`${asset} is not a release archive name (${archives.map((x) => x.name).join(', ')})`);
      continue;
    }
    let published = null;
    try {
      published = createHash('sha256').update(readFileSync(asset)).digest('hex');
    } catch (error) {
      problems.push(`cannot read ${asset}: ${error.message}`);
    }
    if (published !== null && published !== a.entry.source.sha256) problems.push(`${asset} is ${published}, ${a.entry.name} pins ${a.entry.source.sha256}`);
  }
  const out = flag('out');
  if (out !== null && problems.length === 0) {
    mkdirSync(out, { recursive: true });
    for (const [a, { path }] of packs) copyFileSync(path, join(out, a.name));
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const section = changelog.split(/^## /m).find((s) => s.startsWith(`v${version} `) || s.startsWith(`v${version}\n`));
    const shas = [...packs].map(([a, { sha256 }]) => `- \`${a.name}\`: \`${sha256}\``).join('\n');
    if (!section) problems.push(`CHANGELOG.md has no "## v${version}" section`);
    else writeFileSync(join(out, 'NOTES.md'), `${section.slice(section.indexOf('\n') + 1).trim()}\n\nArchive SHA-256:\n\n${shas}\n`);
  }
  cleanup();
  if (problems.length) fail(problems.join('; '));
  for (const [a, { sha256 }] of packs) process.stdout.write(`ok ${a.name} ${sha256}\n`);
} else {
  cleanup();
  fail('usage: node scripts/release.mjs pin | check [--tag vX.Y.Z] [--against <ref>] [--asset <file>]... [--out <dir>]');
}
