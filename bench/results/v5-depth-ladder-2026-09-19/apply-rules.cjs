// Applies the pre-registered rules of v5-depth-ladder-2026-09-19 to a run directory.
// Written before any cell of that run finished, so no threshold here was chosen after seeing a number.
const fs = require('fs'), path = require('path');
const RUN = process.argv[2] || process.env.HOME + '/jev-gate-runs/v5-depth-ladder';
const BANDS = { 13: [120000, 250000], 21: [200000, 340000], 30: [330000, 450000] }; // rule 1
const FLOOR_PCT = 15; // rule 5 / rule 10

const rung = (job) => Number(job.match(/primed-(\d+)$/)[1]);
const jobTurn = (t) => (Array.isArray(t) && t.length >= 2 ? t[t.length - 1] - t[t.length - 2] : null);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const spread = (a) => (a.length < 2 ? null : (Math.max(...a) - Math.min(...a)) / Math.min(...a) * 100);

const admissions = (dir) => {
  const t = path.join(dir, 'trace');
  if (!fs.existsSync(t)) return [];
  return fs.readdirSync(t).filter((f) => f.startsWith('admission_result-')).map((f) => {
    const o = JSON.parse(fs.readFileSync(path.join(t, f), 'utf8'));
    const d = o.decision ?? o.data?.decision ?? {};
    return { shape: d.shape, reason: d.reason, ctx: o.context_tokens ?? o.data?.context_tokens ?? null, plen: o.prompt_len ?? o.data?.prompt_len ?? null };
  }).sort((a, b) => (a.ctx ?? 0) - (b.ctx ?? 0));
};

const cells = [];
for (const job of fs.readdirSync(path.join(RUN, 'cells'))) {
  for (const arm of fs.readdirSync(path.join(RUN, 'cells', job))) {
    for (const rep of fs.readdirSync(path.join(RUN, 'cells', job, arm))) {
      const dir = path.join(RUN, 'cells', job, arm, rep);
      const c = JSON.parse(fs.readFileSync(path.join(dir, 'cell.json'), 'utf8'));
      const adm = admissions(dir);
      const jobPrompt = adm.length ? adm[adm.length - 1] : null;      // deepest = the job turn
      const priming = adm.slice(0, -1);
      const r = rung(job);
      const ctx = c.context_at_job_prompt;
      const inBand = ctx != null && ctx >= BANDS[r][0] && ctx <= BANDS[r][1];
      const primingOrchestrated = priming.some((a) => a.shape === 'orchestrated');   // rule 2
      cells.push({
        job, rung: r, arm, rep: Number(rep), ctx,
        quality: c.grade?.quality ?? c.grade?.verdict ?? null,
        job_turn_usd: jobTurn(c.turn_totals_usd),
        session_usd: c.result?.total_cost_usd ?? null,
        elapsed_s: c.elapsed_ms != null ? +(c.elapsed_ms / 1000).toFixed(1) : null,
        agent_calls: (c.agent_calls || []).length,
        admitted: jobPrompt?.shape === 'orchestrated',               // rule 4
        admission_reason: jobPrompt?.reason ?? null,
        receipts: Object.entries(c.gate?.receipts || {}).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`),
        outcome: c.gate?.outcome ?? null,
        valid: inBand && !primingOrchestrated && !c.timed_out && c.exit_code === 0,
        invalid_reason: !inBand ? `context ${ctx} outside band ${BANDS[r].join('-')}` : primingOrchestrated ? 'a priming prompt was admitted (rule 2)' : c.timed_out ? 'timed out' : c.exit_code !== 0 ? `exit ${c.exit_code}` : null,
      });
    }
  }
}

console.log('| job | arm | rep | context | valid | quality | admitted | job turn $ | session $ | wall s | agents | receipts | outcome |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const c of cells.sort((a, b) => a.rung - b.rung || a.job.localeCompare(b.job) || a.arm.localeCompare(b.arm) || a.rep - b.rep))
  console.log(`| ${c.job} | ${c.arm} | ${c.rep} | ${c.ctx} | ${c.valid ? 'ok' : 'INVALID: ' + c.invalid_reason} | ${c.quality} | ${c.admitted} | ${c.job_turn_usd?.toFixed(4)} | ${c.session_usd?.toFixed(4)} | ${c.elapsed_s} | ${c.agent_calls} | ${c.receipts.join(',') || '-'} | ${c.outcome ?? '-'} |`);

console.log('\n## rungs (pre-registered rules applied)\n');
for (const j of [...new Set(cells.map((c) => c.job))].sort((a, b) => rung(a) - rung(b))) {
  const r = rung(j);
  const all = cells.filter((c) => c.job === j);
  const valid = all.filter((c) => c.valid);
  const nat = valid.filter((c) => c.arm === 'sonnet_native');
  const sin = valid.filter((c) => c.arm === 'jev_single');
  const admitted = sin.filter((c) => c.admitted);
  const failed = valid.filter((c) => c.quality !== 'pass');
  console.log(`### ${j} (${r}-note) — ${valid.length}/${all.length} valid, jev_single admitted ${admitted.length}/${sin.length}`);
  if (all.length !== valid.length) for (const c of all.filter((x) => !x.valid)) console.log(`- invalid: ${c.arm} r${c.rep} — ${c.invalid_reason}`);
  if (failed.length) { console.log(`- **rule 3: ${failed.length} valid cell(s) failed the checker — no cost percentage is quoted for this rung.**`); continue; }
  if (admitted.length < 2) { console.log(`- **rule 4: fewer than 2 admitted jev_single cells — no percentage is quoted for this rung.**`); continue; }
  if (nat.length < 2) { console.log('- fewer than 2 valid native cells — no percentage quoted.'); continue; }
  const n = nat.map((c) => c.job_turn_usd), s = admitted.map((c) => c.job_turn_usd);
  const diff = (mean(n) - mean(s)) / mean(n) * 100;
  const widest = Math.max(spread(n), spread(s));
  const sep = diff >= FLOOR_PCT && diff > widest;
  console.log(`- native mean $${mean(n).toFixed(4)} [${n.map((x) => x.toFixed(4)).join(', ')}], spread ${spread(n).toFixed(1)}%`);
  console.log(`- single mean $${mean(s).toFixed(4)} [${s.map((x) => x.toFixed(4)).join(', ')}], spread ${spread(s).toFixed(1)}%`);
  console.log(`- difference **${diff.toFixed(1)}%**, widest arm spread ${widest.toFixed(1)}%`);
  console.log(`- **${sep ? 'SEPARATION (rule 5 met)' : diff < FLOOR_PCT ? 'not quotable: under the 15% floor' : 'direction only: does not beat the arms\' own spread (rule 5)'}**`);
  const wn = mean(nat.map((c) => c.elapsed_s)), ws = mean(admitted.map((c) => c.elapsed_s));
  console.log(`- wall: native ${wn.toFixed(0)}s vs single ${ws.toFixed(0)}s (${((ws - wn) / wn * 100).toFixed(1)}%)`);
}
