// Job-turn work measured from the persisted stream, not from the host's reported cost.
//
// Written 2026-09-20, after the 13-note rung reversed. It answers a question the dollar unit could not:
// did the work change, or did the accounting? For every cell it reports, for the job turn only:
//   stream_cacheR  summed cache_read_input_tokens over every assistant message in that turn (subagents included)
//   stream_out     summed output_tokens over the same messages
//   host_cacheR    the cache_read_input_tokens the host reported on that turn's result event
//   job_turn_usd   the pre-registered unit, for comparison
// This is post-hoc analysis and is labelled as such wherever it is published. It replaces no rule.
const fs = require('fs'), path = require('path');
const RUN = process.argv[2];
if (!RUN) { console.error('usage: stream-usage.cjs <run dir>'); process.exit(2); }

const jobTurnFromStream = (file) => {
  if (!fs.existsSync(file)) return null;
  const segs = [{ r: 0, o: 0, n: 0 }];
  const results = [];
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
  const job = filled[filled.length - 1];
  const last = results[results.length - 1];
  return { stream_cacheR: job.r, stream_out: job.o, msgs: job.n, host_cacheR: last.usage?.cache_read_input_tokens ?? null };
};

const rows = [];
const cells = path.join(RUN, 'cells');
for (const job of fs.readdirSync(cells)) for (const arm of fs.readdirSync(path.join(cells, job))) for (const rep of fs.readdirSync(path.join(cells, job, arm))) {
  const dir = path.join(cells, job, arm, rep);
  const c = JSON.parse(fs.readFileSync(path.join(dir, 'cell.json'), 'utf8'));
  // A cell the session limit killed still leaves a stream file with a result event and no messages.
  // Averaging those in silently reported a dead arm as zero work (found while first running this script).
  if (c.exit_code !== 0 || c.timed_out) continue;
  const t = c.turn_totals_usd;
  const usd = Array.isArray(t) && t.length >= 2 ? t[t.length - 1] - t[t.length - 2] : null;
  const st = jobTurnFromStream(path.join(dir, 'stream.jsonl'));
  if (!st || st.msgs === 0) continue;
  rows.push({ job, arm, rep, usd, ...st });
}

console.log('| job | arm | rep | job turn $ | stream cacheR | stream out | host-reported cacheR | host/stream |');
console.log('|---|---|---|---|---|---|---|---|');
for (const r of rows.sort((a, b) => a.job.localeCompare(b.job) || a.arm.localeCompare(b.arm) || a.rep.localeCompare(b.rep)))
  console.log(`| ${r.job} | ${r.arm} | ${r.rep} | ${r.usd === null ? '-' : '$' + r.usd.toFixed(4)} | ${(r.stream_cacheR / 1e6).toFixed(2)}M | ${r.stream_out} | ${r.host_cacheR === null ? '-' : (r.host_cacheR / 1e6).toFixed(2) + 'M'} | ${r.host_cacheR === null ? '-' : (r.host_cacheR / r.stream_cacheR * 100).toFixed(0) + '%'} |`);

const byJob = {};
for (const r of rows) (byJob[r.job] ??= []).push(r);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
console.log('\n## job-turn work, arm means (stream-derived)');
for (const [job, rs] of Object.entries(byJob)) {
  const nat = rs.filter((r) => r.arm === 'sonnet_native'), sin = rs.filter((r) => r.arm === 'jev_single');
  if (!nat.length || !sin.length) continue;
  const cr = (a) => mean(a.map((r) => r.stream_cacheR)), ou = (a) => mean(a.map((r) => r.stream_out)), dl = (a) => mean(a.map((r) => r.usd));
  console.log(`### ${job}`);
  console.log(`- cache reads: native ${(cr(nat) / 1e6).toFixed(2)}M vs single ${(cr(sin) / 1e6).toFixed(2)}M — single ${((1 - cr(sin) / cr(nat)) * 100).toFixed(1)}% less`);
  console.log(`- output tokens: native ${ou(nat).toFixed(0)} vs single ${ou(sin).toFixed(0)} — single ${((1 - ou(sin) / ou(nat)) * 100).toFixed(1)}% less`);
  console.log(`- dollars (pre-registered unit): native $${dl(nat).toFixed(4)} vs single $${dl(sin).toFixed(4)} — single ${((1 - dl(sin) / dl(nat)) * 100).toFixed(1)}% less`);
}
