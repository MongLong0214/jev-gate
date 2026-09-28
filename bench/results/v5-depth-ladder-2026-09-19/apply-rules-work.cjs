// Applies the rules of PREREGISTRATION-WORK-2026-09-20.md to a run directory, in the WORK unit.
// Written and committed BEFORE the first cell of run 4 exists, so no threshold here was chosen
// after seeing a number. It is the work-unit twin of apply-rules.cjs and shares its validity rules
// (band, priming integrity, exit, timeout) and its separation test (magnitude >= 15% AND wider than
// the wider arm's own within-run spread), applied to cache reads and to output tokens instead of dollars.
//
// Source of the work figures, in order:
//   1. cell.turn_totals_stream  — recorded by the runner from 146d295 on
//   2. stream.jsonl             — summed the same way, for runs made before that field existed
// Both paths sum every message carrying usage in the turn, subagents included.
const fs = require('fs'), path = require('path');
const RUN = process.argv[2];
if (!RUN) { console.error('usage: apply-rules-work.cjs <run dir>'); process.exit(2); }
const BANDS = { 13: [120000, 250000], 21: [200000, 340000], 30: [330000, 450000] };
const FLOOR_PCT = 15;

const rung = (job) => Number(job.match(/primed-(\d+)$/)[1]);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const spread = (a) => (a.length < 2 ? null : (Math.max(...a) - Math.min(...a)) / Math.min(...a) * 100);
const jobTurn = (t) => (Array.isArray(t) && t.length >= 2 ? t[t.length - 1] - t[t.length - 2] : null);

const fromField = (c) => {
  const t = c.turn_totals_stream;
  if (!Array.isArray(t) || t.length < 2) return null;
  const a = t[t.length - 2], b = t[t.length - 1];
  if (b.messages - a.messages <= 0) return null;
  return { cacheR: b.cache_read - a.cache_read, out: b.output - a.output, msgs: b.messages - a.messages, src: 'field' };
};

const fromStream = (file) => {
  if (!fs.existsSync(file)) return null;
  const segs = [{ r: 0, o: 0, n: 0 }]; const results = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'result') { results.push(ev); segs.push({ r: 0, o: 0, n: 0 }); continue; }
    const u = ev?.message?.usage; if (!u) continue;
    const s = segs[segs.length - 1];
    s.r += u.cache_read_input_tokens ?? 0; s.o += u.output_tokens ?? 0; s.n++;
  }
  const filled = segs.filter((s) => s.n > 0);
  if (!filled.length || !results.length) return null;
  const j = filled[filled.length - 1], last = results[results.length - 1];
  return { cacheR: j.r, out: j.o, msgs: j.n, host: last.usage?.cache_read_input_tokens ?? null, src: 'stream' };
};

const admissions = (dir) => {
  const t = path.join(dir, 'trace');
  if (!fs.existsSync(t)) return [];
  return fs.readdirSync(t).filter((f) => f.startsWith('admission_result-')).map((f) => {
    const o = JSON.parse(fs.readFileSync(path.join(t, f), 'utf8'));
    const d = o.decision ?? o.data?.decision ?? {};
    return { shape: d.shape, ctx: o.context_tokens ?? o.data?.context_tokens ?? null };
  }).sort((a, b) => (a.ctx ?? 0) - (b.ctx ?? 0));
};

const cells = [];
const root = path.join(RUN, 'cells');
for (const job of fs.readdirSync(root)) for (const arm of fs.readdirSync(path.join(root, job))) for (const rep of fs.readdirSync(path.join(root, job, arm))) {
  const dir = path.join(root, job, arm, rep);
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'cell.json'), 'utf8'));
  const adm = admissions(dir);
  const jobPrompt = adm.length ? adm[adm.length - 1] : null;
  const primingOrchestrated = adm.slice(0, -1).some((a) => a.shape === 'orchestrated');
  const r = rung(job), ctx = c.context_at_job_prompt;
  const inBand = ctx != null && ctx >= BANDS[r][0] && ctx <= BANDS[r][1];
  const st = fromStream(path.join(dir, 'stream.jsonl'));
  const w = fromField(c) ?? st;
  cells.push({
    job, rung: r, arm, rep: Number(rep), ctx,
    quality: c.grade?.quality ?? c.grade?.verdict ?? null,
    admitted: jobPrompt?.shape === 'orchestrated',
    usd: jobTurn(c.turn_totals_usd),
    cacheR: w?.cacheR ?? null, out: w?.out ?? null, msgs: w?.msgs ?? null, src: w?.src ?? null,
    host: st?.host ?? null,
    valid: inBand && !primingOrchestrated && !c.timed_out && c.exit_code === 0 && w != null,
    invalid_reason: !inBand ? `context ${ctx} outside band ${BANDS[r].join('-')}` : primingOrchestrated ? 'a priming prompt was admitted' : c.timed_out ? 'timed out' : c.exit_code !== 0 ? `exit ${c.exit_code}` : w == null ? 'no usable job-turn usage' : null,
  });
}

console.log('| job | arm | rep | context | valid | quality | admitted | cacheR | out | msgs | src | host/stream | job turn $ |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const c of cells.sort((a, b) => a.rung - b.rung || a.arm.localeCompare(b.arm) || a.rep - b.rep))
  console.log(`| ${c.job} | ${c.arm} | ${c.rep} | ${c.ctx} | ${c.valid ? 'ok' : 'INVALID: ' + c.invalid_reason} | ${c.quality} | ${c.admitted} | ${c.cacheR === null ? '-' : (c.cacheR / 1e6).toFixed(2) + 'M'} | ${c.out ?? '-'} | ${c.msgs ?? '-'} | ${c.src ?? '-'} | ${c.host && c.cacheR ? (c.host / c.cacheR * 100).toFixed(0) + '%' : '-'} | ${c.usd === null ? '-' : '$' + c.usd.toFixed(4)} |`);

const verdict = (label, n, s, fmt) => {
  const diff = (mean(n) - mean(s)) / mean(n) * 100;
  const widest = Math.max(spread(n), spread(s));
  const mag = Math.abs(diff), dir = diff >= 0 ? 'single LESS' : 'single MORE';
  const sep = mag >= FLOOR_PCT && mag > widest;
  console.log(`- ${label}: native ${fmt(mean(n))} [${n.map(fmt).join(', ')}] spread ${spread(n).toFixed(1)}% | single ${fmt(mean(s))} [${s.map(fmt).join(', ')}] spread ${spread(s).toFixed(1)}%`);
  console.log(`  → **${mag.toFixed(1)}% ${dir}** — ${sep ? 'SEPARATION' : mag < FLOOR_PCT ? 'not quotable: under the 15% floor' : "direction only: does not beat the arms' own spread"}`);
  return { mag: +mag.toFixed(1), dir, sep };
};

console.log('\n## rungs, work unit (rules of PREREGISTRATION-WORK-2026-09-20.md)\n');
const summary = {};
for (const j of [...new Set(cells.map((c) => c.job))].sort((a, b) => rung(a) - rung(b))) {
  const all = cells.filter((c) => c.job === j), valid = all.filter((c) => c.valid);
  const nat = valid.filter((c) => c.arm === 'sonnet_native'), sin = valid.filter((c) => c.arm === 'jev_single');
  const admitted = sin.filter((c) => c.admitted), failed = valid.filter((c) => c.quality !== 'pass');
  console.log(`### ${j} — ${valid.length}/${all.length} valid, jev_single admitted ${admitted.length}/${sin.length}`);
  for (const c of all.filter((x) => !x.valid)) console.log(`- invalid: ${c.arm} r${c.rep} — ${c.invalid_reason}`);
  if (failed.length) { console.log(`- **${failed.length} valid cell(s) failed the checker — nothing is quoted for this rung.**`); continue; }
  if (admitted.length < 2 || nat.length < 2) { console.log('- **fewer than 2 usable cells in an arm — nothing is quoted for this rung.**'); continue; }
  summary[j] = {
    cache_reads: verdict('cache reads', nat.map((c) => c.cacheR), admitted.map((c) => c.cacheR), (x) => (x / 1e6).toFixed(2) + 'M'),
    output_tokens: verdict('output tokens', nat.map((c) => c.out), admitted.map((c) => c.out), (x) => x.toFixed(0)),
    dollars: verdict('dollars (co-primary)', nat.map((c) => c.usd), admitted.map((c) => c.usd), (x) => '$' + x.toFixed(4)),
  };
}
console.log('\n```json\n' + JSON.stringify(summary, null, 2) + '\n```');
