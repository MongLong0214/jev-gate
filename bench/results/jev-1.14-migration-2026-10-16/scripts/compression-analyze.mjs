import { readFileSync } from 'node:fs';
const file = process.argv[2] ?? 'measure.jsonl';
const cells = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * p)]; };
const med = (a) => q(a, 0.5);
const rnd = (() => { let a = 12345; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
const boot = (f, n = 2000) => { const xs = []; for (let i = 0; i < n; i++) xs.push(f()); xs.sort((a, b) => a - b); return [xs[Math.floor(n * 0.025)], xs[Math.floor(n * 0.975)]]; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
console.log('site | mode | enc | n ok/total | wire B | p50 | p90 | mean | median diff vs plain [95% CI]');
for (const c of cells) {
  const by = { plain: [], gzip: [], zstd: [] };
  for (const r of c.rows) by[r.enc].push(r);
  const ok = (r) => r.status === 200 && r.ok;
  for (const enc of ['plain', 'gzip', 'zstd']) {
    const rs = by[enc], good = rs.filter(ok), ms = good.map((r) => r.ms);
    let diff = '';
    if (enc !== 'plain') {
      if (c.mode !== 'par8') {
        const plainByI = new Map(by.plain.filter(ok).map((r) => [r.i, r.ms]));
        const d = good.filter((r) => plainByI.has(r.i)).map((r) => r.ms - plainByI.get(r.i));
        const [lo, hi] = boot(() => med(Array.from({ length: d.length }, () => pick(d))));
        diff = `${f1(med(d))} [${f1(lo)}, ${f1(hi)}] (paired)`;
      } else {
        const p = by.plain.filter(ok).map((r) => r.ms);
        const [lo, hi] = boot(() => med(Array.from({ length: ms.length }, () => pick(ms))) - med(Array.from({ length: p.length }, () => pick(p))));
        diff = `${f1(med(ms) - med(p))} [${f1(lo)}, ${f1(hi)}] (unpaired)`;
      }
    }
    const wire = Math.round(good.reduce((s, r) => s + r.wire, 0) / Math.max(1, good.length));
    console.log(`${c.site} | ${c.mode} | ${enc} | ${good.length}/${rs.length} | ${wire} | ${f1(q(ms, 0.5))} | ${f1(q(ms, 0.9))} | ${f1(ms.reduce((s, x) => s + x, 0) / ms.length)} | ${diff}`);
  }
  const cm = c.rows.filter((r) => r.enc !== 'plain').map((r) => r.compress_ms);
  const errs = c.rows.filter((r) => !ok(r));
  if (errs.length) console.log(`  non-200/invalid: ${errs.length}`, JSON.stringify(errs.slice(0, 3)));
}

// Client compression cost and the pooled paired difference over the sequential modes of every site.
const allRows = cells.flatMap((c) => c.rows);
for (const site of [...new Set(cells.map((c) => c.site))]) {
  for (const enc of ['gzip', 'zstd']) {
    const r = cells.filter((c) => c.site === site).flatMap((c) => c.rows).filter((x) => x.enc === enc).map((x) => x.compress_ms);
    console.log(`${site} ${enc} compress ms p50 ${q(r, 0.5).toFixed(2)} p90 ${q(r, 0.9).toFixed(2)} max ${Math.max(...r).toFixed(1)} n ${r.length}`);
  }
}
const pooled = { gzip: [], zstd: [] };
for (const c of cells) {
  if (c.mode === 'par8') continue;
  const by = {};
  for (const r of c.rows) (by[r.i] ??= {})[r.enc] = r;
  for (const i of Object.keys(by)) {
    const p = by[i].plain;
    if (!p || !(p.status === 200 && p.ok)) continue;
    for (const e of ['gzip', 'zstd']) if (by[i][e] && by[i][e].status === 200 && by[i][e].ok) pooled[e].push(by[i][e].ms - p.ms);
  }
}
for (const e of ['gzip', 'zstd']) console.log(`pooled paired (sequential modes, all sites) ${e} n ${pooled[e].length} median diff ${q(pooled[e], 0.5).toFixed(2)} ms mean ${(pooled[e].reduce((s, x) => s + x, 0) / pooled[e].length).toFixed(2)} ms`);
console.log(`non-ok rows ${allRows.filter((r) => !(r.status === 200 && r.ok)).length} of ${allRows.length}`);
