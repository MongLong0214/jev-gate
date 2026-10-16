// Summarises long-context-needle.mjs output: status and latency per size and header, Gate A needle detection at the
// production threshold (forbids_delegation >= 0.6), and Router top-choice agreement with the label by position.
import { readFileSync } from 'node:fs';
const { rows } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const FACT_TRUE = 0.6;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : null; };
const f0 = (x) => (x === null ? '-' : String(Math.round(x)));
const f2 = (x) => (x === null ? '-' : x.toFixed(2));
const keyOf = (r) => `${r.part} size=${r.size} header=${r.header}`;
const groups = [...new Set(rows.map(keyOf))];
console.log('== status, latency, billed input tokens ==');
for (const g of groups) {
  const rs = rows.filter((r) => keyOf(r) === g);
  const ok = rs.filter((r) => r.status === 200);
  const errs = {};
  for (const r of rs.filter((x) => x.status !== 200)) errs[`${r.status}${r.err ? ':' + r.err : ''}`] = (errs[`${r.status}${r.err ? ':' + r.err : ''}`] ?? 0) + 1;
  const ms = ok.map((r) => r.ms), tk = ok.map((r) => r.tokens).filter((x) => x !== null);
  console.log(`${g.padEnd(36)} ok ${ok.length}/${rs.length}  latency p50 ${f0(q(ms, 0.5))} p90 ${f0(q(ms, 0.9))} max ${f0(Math.max(...ms))} ms  tokens p50 ${f0(q(tk, 0.5))}${Object.keys(errs).length ? '  errors ' + JSON.stringify(errs) : ''}`);
}
console.log('\n== Gate A: forbids_delegation, a labelled no-delegation prompt buried in the paste (threshold 0.6) ==');
console.log('size(header)  variant        n   mean   min   max   >=0.6');
const ga = rows.filter((r) => r.part === 'gateA' && r.status === 200 && r.value !== null);
for (const size of [-1, 0, ...new Set(ga.filter((r) => r.size > 0).map((r) => r.size))]) {
  for (const header of [false, true]) {
    const rs = ga.filter((r) => r.size === size && r.header === header);
    if (!rs.length) continue;
    for (const v of ['control', 'needle@10', 'needle@50', 'needle@90', 'needle@end', 'needle-only']) {
      const x = rs.filter((r) => r.variant === v).map((r) => r.value);
      if (!x.length) continue;
      console.log(`${String(size).padStart(6)}(${header ? 'on ' : 'off'})  ${v.padEnd(12)} ${String(x.length).padStart(3)}  ${f2(x.reduce((s, y) => s + y, 0) / x.length)}  ${f2(Math.min(...x))}  ${f2(Math.max(...x))}   ${x.filter((y) => y >= FACT_TRUE).length}/${x.length}`);
    }
  }
}
console.log('\n== Router: capability top choice against the label (6 dev items: two mechanical, two routine, two complex) ==');
console.log('size(header)  position  n    agree');
const rt = rows.filter((r) => r.part === 'router');
for (const size of [0, ...new Set(rt.filter((r) => r.size > 0).map((r) => r.size))]) {
  for (const header of [false, true]) {
    const rs = rt.filter((r) => r.size === size && r.header === header);
    if (!rs.length) continue;
    for (const v of ['short', 'start', 'mid', 'end', 'all']) {
      const x = v === 'all' ? rs : rs.filter((r) => r.variant === v);
      if (!x.length) continue;
      const answered = x.filter((r) => r.status === 200 && r.value !== null);
      console.log(`${String(size).padStart(6)}(${header ? 'on ' : 'off'})  ${v.padEnd(8)} ${String(x.length).padStart(3)}  ${answered.filter((r) => r.value === r.label).length}/${answered.length} answered`);
    }
  }
}
