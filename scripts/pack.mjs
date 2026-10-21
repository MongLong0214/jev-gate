// Builds a distributable local plugin archive (#18): compiled hook + modules, manifest, hooks, agents, docs.
// Usage: node scripts/pack.mjs [outDir] [--root <pluginRoot>] [--profile legacy|router|codex]
//   legacy (default) → <outDir>/jev-gate-<version>.zip         six routing roles, the V5 hook set,
//                                                              the two Mods and the MCP server (the one plugin)
//   router (JGR-01)  → <outDir>/jev-gate-router-<version>.zip  the Function Hooks Mod in mods/router, at its own version
//   codex → <outDir>/jev-gate-codex-<version>.zip native Codex hooks, MCP server, skills and dashboard
// All profiles require `npm run build` first (which clears dist, so a deleted module cannot reappear here).
// The archive is written here rather than by the zip CLI, so one tree gives the same bytes on any machine: the marketplace pins
// the legacy archive's SHA-256 before a release is tagged, and scripts/release.mjs check rebuilds it to compare.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const root = flag('root') ? resolve(flag('root')) : dirname(dirname(fileURLToPath(import.meta.url)));
const profile = flag('profile') ?? 'legacy';
if (!['legacy', 'router', 'codex'].includes(profile)) {
  process.stderr.write(`pack: unknown profile ${profile}\n`);
  process.exit(1);
}
const consumed = new Set();
for (const name of ['root', 'profile']) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) {
    consumed.add(i);
    consumed.add(i + 1);
  }
}
const positional = args.filter((_, i) => !consumed.has(i));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const outDir = resolve(positional[0] ?? join(root, 'dist-pack'));

const LEGACY_AGENTS = ['worker-fast', 'worker', 'worker-deep', 'worker-frontier'];
// Doctor requires every one of these files.
const agents = LEGACY_AGENTS;

const walk = (p) => (statSync(p).isDirectory() ? readdirSync(p).flatMap((n) => walk(join(p, n))) : [p]);

// The host loads Function Hooks from TypeScript. The router archive also carries the bounded Node metadata reader;
// legacy entrypoints, declarations and host tests stay out of that profile.
const ROUTER = 'mods/router';
const routerHooks = () =>
  existsSync(join(root, ROUTER, 'hooks')) ? readdirSync(join(root, ROUTER, 'hooks')).filter((n) => n.endsWith('.ts') || n === 'hooks.json').sort() : [];

const CODEX_FILES = ['.codex-plugin/plugin.json', '.agents/plugins/marketplace.json', '.mcp.json', 'hooks/hooks.json', 'dist/hook.mjs', 'dist/server.mjs', 'dist/cli.mjs', 'dist/worktree.mjs', 'dist/activity-worker.mjs', 'skills/jev-gate/SKILL.md', 'README.md', 'assets/icon.png'];

// The one jev-gate plugin (v0.6.0) also carries the two Mods, loaded through hooks/register.ts from their source, and
// the MCP server bundle, at the paths the manifest and that module name.
const modSources = () =>
  ['compact', 'router'].flatMap((m) =>
    readdirSync(join(root, 'mods', m, 'hooks'))
      .filter((n) => n.endsWith('.ts'))
      .sort()
      .map((n) => `mods/${m}/hooks/${n}`),
  );
const ROUTER_SHARED = ['cost', 'provider-prices', 'provider-prices-data', 'route-cost', 'claude-cache', 'claude-dispatch', 'router-answers', 'router-selection', 'router-context', 'router-child-context', 'router-observation', 'router-secret', 'claude-models', 'claude-candidates', 'frontier-routing'].map(n => `src/${n}.ts`);
const shared = () => ['hooks/register.ts', ...modSources(), ...ROUTER_SHARED, 'plugins/evidence/dist/server.mjs'];
// Install paths the root README links (#95, #98). Not a link crawl: bench/ and HANDOFF stay out. The logo and results banner are the
// README's images, each with its dark-theme variant. hero.svg, pilot.svg, and v4-flow.svg are not packed; the README no longer embeds them.
const INSTALL_DOCS = [
  'LICENSE',
  'CHANGELOG.md',
  'docs/advanced-usage.md',
  'docs/bench-ab.md',
  'bench/ab/tasks.example.json',
  'plugins/codex/README.md',
  'mods/compact/README.md',
  'mods/router/README.md',
  'assets/readme/jev-gate-logo.svg',
  'assets/readme/jev-gate-logo-dark.svg',
  'assets/readme/results.svg',
  'assets/readme/results-dark.svg',
];

// [source path relative to root, path inside the archive]. The hook set is the only file that is renamed.
const hostsDist = profile === 'legacy';
const entries =
  profile === 'codex'
    ? [...CODEX_FILES.map((f) => [`plugins/codex/${f}`, f]), ['LICENSE', 'LICENSE']]
    : profile === 'router'
    ? [
        ['LICENSE', 'LICENSE'],
        ['.claude-plugin/icon.png', '.claude-plugin/icon.png'],
        [`${ROUTER}/.claude-plugin/plugin.json`, '.claude-plugin/plugin.json'],
        [`${ROUTER}/hooks/hooks.json`, 'hooks/hooks.json'],
        ...routerHooks()
          .filter((n) => n !== 'hooks.json')
          .map((n) => [`${ROUTER}/hooks/${n}`, `hooks/${n}`]),
        [`${ROUTER}/README.md`, 'README.md'],
        ['dist/router-observation-hook.js', 'dist/router-observation-hook.js'],
        ...ROUTER_SHARED.map(f => [f, f]),
      ]
    : [
        ['.claude-plugin/plugin.json', '.claude-plugin/plugin.json'],
        ['.claude-plugin/icon.png', '.claude-plugin/icon.png'],
        ['hooks/hooks.json', 'hooks/hooks.json'],
        ...agents.map((a) => [`agents/${a}.md`, `agents/${a}.md`]),
        ...['README.md', 'AGENTS.md', '.env.example', 'package.json'].map((f) => [f, f]),
        ...INSTALL_DOCS.map((f) => [f, f]),
        ...shared().map((f) => [f, f]),
      ];
const missing = entries.map(([src]) => src).filter((rel) => !existsSync(join(root, rel)));
if (hostsDist && !existsSync(join(root, 'dist/hook.js'))) missing.push('dist/hook.js');
// #48 P2: hooks.json now commands dist/entry.js, which dynamically imports dist/hook.js -- both must ship.
if (hostsDist && !existsSync(join(root, 'dist/entry.js'))) missing.push('dist/entry.js');
// hooks.json also commands dist/compact-hook.js on PreCompact, SessionStart(compact) and PostCompact (the classic Compact path).
if (hostsDist && !existsSync(join(root, 'dist/compact-hook.js'))) missing.push('dist/compact-hook.js');
// turn.step reads applied effort and TTL through the bounded Node helper.
if (hostsDist && !existsSync(join(root, 'dist/router-observation-hook.js'))) missing.push('dist/router-observation-hook.js');
if (missing.length) {
  process.stderr.write(`pack: missing ${missing.join(', ')}${profile === 'router' ? '' : ' — run npm run build first'}\n`);
  process.exit(1);
}
if (hostsDist) {
  for (const p of walk(join(root, 'dist'))) {
    const rel = relative(root, p);
    if (!rel.endsWith('.tsbuildinfo')) entries.push([rel, rel]);
  }
}

const manifestVersion = (dir) => JSON.parse(readFileSync(join(root, dir, '.claude-plugin/plugin.json'), 'utf8')).version;
const name =
  profile === 'codex'
    ? `jev-gate-codex-${JSON.parse(readFileSync(join(root, 'plugins/codex/.codex-plugin/plugin.json'), 'utf8')).version}`
    : profile === 'router'
    ? `jev-gate-router-${manifestVersion(ROUTER)}`
    : `jev-gate-${pkg.version}`;
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Stored (uncompressed) entries in byte order of their names, every time 1980-01-01 00:00, a mode of 644 or 755 from
// the source's executable bit, no directory entries and no extra fields: nothing that depends on the machine, the
// clock, the time zone or a compressor's build.
const zipBytes = (files) => {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, mode } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 10, 4);
    central.writeUInt16LE(10, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
};

const files = entries
  .map(([src, dest]) => {
    const abs = join(root, src);
    return { name: dest, data: profile === 'router' && src.startsWith(`${ROUTER}/hooks/`) && src.endsWith('.ts') ? Buffer.from(readFileSync(abs, 'utf8').replaceAll('../../../src/', '../src/')) : readFileSync(abs), mode: statSync(abs).mode & 0o111 ? 0o755 : 0o644 };
  })
  .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
mkdirSync(outDir, { recursive: true });
const archive = join(outDir, `${name}.zip`);
rmSync(archive, { force: true });
writeFileSync(archive, zipBytes(files));
process.stdout.write(`${archive}\n${entries.length} files\n`);
