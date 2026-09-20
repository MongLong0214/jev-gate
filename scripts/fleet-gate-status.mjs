#!/usr/bin/env node
/**
 * What jev-gate is doing in the sessions that are actually running, read from evidence the hook already leaves behind.
 *
 * A hook that always exits 0 is silent by design, so a gate that is dead and a gate that declined look the same from
 * outside. This reconstructs the difference from three places the hook does not control: the process environment (is
 * the key there at all), the host transcript (how deep the session is, by the shipped `readSessionDepth`), and the job
 * state file (did the hook run, and what shape did the turn end up in).
 *
 * `$0` and read-only: it opens no socket and writes nothing. It is a status report, not a gate.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const HOME = homedir();
const { readSessionDepth } = createRequire(import.meta.url)(join(HOME, 'projects/jev-gate/dist/depth.js'));

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

const config = (() => {
  try {
    return JSON.parse(readFileSync(join(HOME, '.config/jev-gate/config.json'), 'utf8'));
  } catch {
    return {};
  }
})();
/** The shipped default; the file only overrides what it names. */
const FLOOR = typeof config.delegationDepthFloor === 'number' ? config.delegationDepthFloor : 300000;
const MODE = config.mode ?? 'off';

/** session_id -> the job state the hook last wrote for it. */
const jobs = new Map();
const jobDir = join(HOME, '.local/state/jev-gate/jobs');
for (const f of readdirSync(jobDir).filter((f) => f.endsWith('.json'))) {
  try {
    const d = JSON.parse(readFileSync(join(jobDir, f), 'utf8'));
    if (d.session_id) jobs.set(d.session_id, d);
  } catch {
    /* a state file being rewritten is not a session that stopped existing */
  }
}

const pids = sh('pgrep', ['-x', 'claude']).split('\n').filter(Boolean);
const rows = [];
for (const pid of pids) {
  const cmd = sh('ps', ['-o', 'command=', '-p', pid]).trim();
  const label = /--remote-control (\S+)/.exec(cmd)?.[1] ?? `pid ${pid}`;
  // `ps -E` returns the environment as it was at exec: a key exported after the session started is not in it, which
  // is exactly the failure this column exists to catch.
  const env = sh('ps', ['-Ep', pid]);
  const hasKey = env.length > 0 ? / TYPESAFE_API_KEY=/.test(env) : null;

  const cwd = /\s(\/\S+)$/.exec(sh('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']).split('\n').find((l) => l.startsWith('n')) ?? '')?.[1]
    ?? sh('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn']).split('\n').find((l) => l.startsWith('n'))?.slice(1)
    ?? null;
  const projDir = cwd ? join(HOME, '.claude/projects', cwd.replace(/[/.]/g, '-')) : null;

  let transcript = null;
  const explicit = /--session-id (\S+)/.exec(cmd)?.[1];
  try {
    const files = readdirSync(projDir).filter((f) => f.endsWith('.jsonl'));
    const pick = explicit && files.includes(`${explicit}.jsonl`)
      ? `${explicit}.jsonl`
      : files.map((f) => [statSync(join(projDir, f)).mtimeMs, f]).sort((a, b) => b[0] - a[0])[0]?.[1];
    if (pick) transcript = join(projDir, pick);
  } catch {
    /* no project directory yet means no transcript to read, not an error */
  }
  const sid = transcript ? transcript.split('/').pop().replace(/\.jsonl$/, '') : null;
  const depth = transcript ? readSessionDepth(transcript) : { ok: false, reason: 'depth_unknown' };
  const job = sid ? jobs.get(sid) : undefined;
  rows.push({ pid, label, cwd, sid, hasKey, depth, job });
}

/**
 * The first branch in `runUserPromptSubmit` that would end this turn as `direct`, in the order the hook applies them.
 * `mode_off` and `key_missing` come before the depth read, so a session missing the key is not also "below floor":
 * it never got that far.
 */
const whyDirect = (r) => {
  if (MODE === 'off') return 'mode_off — config mode is off';
  if (MODE === 'native') return 'mode_native — control arm, no Jev call by definition';
  if (r.hasKey === false) return 'key_missing — no TYPESAFE_API_KEY in this process env; every eligible call is preserved';
  if (r.hasKey === null) return 'unknown — the process environment could not be read';
  if (!r.depth.ok) return 'depth_unknown — the transcript gave no usage line inside the read bound';
  if (r.depth.tokens < FLOOR) return `depth_below_floor — ${r.depth.tokens.toLocaleString()} < ${FLOOR.toLocaleString()}`;
  return 'eligible — Gate A decides this turn';
};

console.log(`jev-gate fleet status — mode=${MODE}  floor=${FLOOR.toLocaleString()}  ${new Date().toISOString()}`);
if (rows.length === 0) console.log('\nno running claude session found.');
for (const r of rows) {
  const gens = r.job ? [...(r.job.history ?? []), r.job.current].filter(Boolean) : [];
  const shapes = gens.reduce((acc, g) => ({ ...acc, [g.shape]: (acc[g.shape] ?? 0) + 1 }), {});
  console.log(`\n${r.label}  (pid ${r.pid})`);
  console.log(`  cwd        ${r.cwd ?? '?'}`);
  console.log(`  session    ${r.sid ?? '(no transcript found)'}`);
  console.log(`  key in env ${r.hasKey === null ? 'unreadable' : r.hasKey ? 'yes' : 'NO'}`);
  console.log(`  depth      ${r.depth.ok ? `${r.depth.tokens.toLocaleString()} tokens` : r.depth.reason}`);
  console.log(`  hook ran   ${r.job ? `yes — ${gens.length} generation(s), last ${r.job.updated_at}` : 'NO state file for this session'}`);
  if (r.job) {
    console.log(`  shapes     ${Object.entries(shapes).map(([k, v]) => `${k}:${v}`).join('  ')}`);
    console.log(`  last turn  phase=${r.job.current.phase} outcome=${r.job.current.outcome ?? 'open'} denials=${r.job.current.denials} receipts=${r.job.current.receipts.length}`);
  }
  console.log(`  would be   ${whyDirect(r)}`);
}
