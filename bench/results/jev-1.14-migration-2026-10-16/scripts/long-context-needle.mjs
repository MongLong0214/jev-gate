// Long-context header check: needle-style states of ~20k/40k/80k/150k real Jev tokens, with and without
// `TypeSafe-Danger-Zone-Long-Context: true`. Two call shapes that production sends:
//   gateA  - Gate A atomic admission request whose prompt is a long paste, with (or without) one explicit sentence
//            forbidding delegation (a labelled no-delegation prompt) buried at 10/50/90% of it. Reads the `forbids_delegation` noul.
//   router - the Router capability question on a labelled request placed at the start / middle / end of the paste.
// Real token counts come from the response `usage.input_tokens`, not an estimate.
import https from 'node:https';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const R = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) throw new Error('no key');
const OUT = process.argv[2];
const SIZES = (process.argv[3] ?? '20000,40000,80000,150000').split(',').map(Number);
const REPS = Number(process.argv[4] ?? 3);
const PARTS = (process.argv[5] ?? 'gateA,router').split(',');

const imp = (p) => import(`${R}/dist/${p}`);
const { buildAtomicAdmissionRequest } = await imp('admission.js');
const { DEFAULT_CONFIG } = await imp('config.js');
const { offerRoute } = await imp('router-selection.js');
const { claudeCandidates } = await imp('claude-candidates.js');
const { routingContext } = await imp('router-context.js');
const { ordered } = await imp('bench/router.js');
const { validateChoice } = await imp('router-answers.js');

// Filler: this repository's own source, in a fixed order, started at a different offset per repetition.
const walk = (d, out = []) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p, out); else if (/\.(ts|md|mjs)$/.test(f)) out.push(p); } return out; };
const files = [...walk(`${R}/src`), ...walk(`${R}/docs`), ...walk(`${R}/mods`).filter((p) => !p.includes('/types/'))];
const corpus = files.map((p) => `\n// ===== ${p.slice(R.length + 1)} =====\n${readFileSync(p, 'utf8')}`).join('');
const fill = (chars, rep) => { const start = (rep * 131_071) % Math.max(1, corpus.length - chars); return corpus.slice(start, start + chars); };

const post = (body, longContext) => new Promise((resolve) => {
  const t0 = performance.now();
  const buf = Buffer.from(body);
  const req = https.request({ hostname: 'api.typesafe.ai', path: '/v1/systemone', method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'content-length': buf.length, ...(longContext ? { 'typesafe-danger-zone-long-context': 'true' } : {}) } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      resolve({ status: res.statusCode, ms: performance.now() - t0, json, errType: json?.detail?.error_type ?? null });
    });
  });
  req.on('error', (e) => resolve({ status: 0, ms: performance.now() - t0, json: null, errType: e.code ?? e.message }));
  req.end(buf);
});

// The three labelled no-delegation prompts of bench/v5/admission-set.json, one per repetition, buried in the paste.
const NEEDLES = JSON.parse(readFileSync(`${R}/bench/v5/admission-set.json`, 'utf8')).items.filter((i) => i.id.startsWith('no-delegation-')).map((i) => i.prompt);
const REQUEST = 'Please find why the second test in the file above fails and fix it.';
const place = (filler, frac, text) => { const at = filler.lastIndexOf('\n', Math.floor(filler.length * frac)); return filler.slice(0, at) + '\n' + text + '\n' + filler.slice(at); };

// null: no needle; a number: the needle buried at that fraction of the paste, the request last; 'end': the needle is the last thing said.
const gateAPrompt = (base, frac, rep) => {
  const needle = NEEDLES[rep % NEEDLES.length];
  if (frac === null) return base + '\n\n' + REQUEST;
  if (frac === 'end') return base + '\n\n' + needle;
  return place(base, frac, needle) + '\n\n' + REQUEST;
};
const gateA = (prompt) => JSON.stringify(buildAtomicAdmissionRequest(prompt, DEFAULT_CONFIG));
const args = { baseline: { model: 'claude-opus-5-5', effort: 'xhigh' }, candidates: claudeCandidates({ baseline: 'claude-opus-5-5', aliases: {}, allowFable: false }), model: true, effort: true, upgrade: 0.8, downgrade: 0.6, scope: 'root' };
const offer = ordered(offerRoute(args), true);
const router = (text) => JSON.stringify({ model: DEFAULT_CONFIG.jevModel, state: routingContext(text), questions: offer.questions });
const golden = JSON.parse(readFileSync(`${R}/bench/router/golden.json`, 'utf8')).items.filter((i) => i.split === 'dev' && !i.pair_of);
const items = ['mechanical', 'routine', 'complex', 'open_problem'].flatMap((label) => golden.filter((i) => i.label === label && !(i.tags ?? []).includes('hard_short')).slice(0, 2));

// chars per real token for this filler, from one call with the header on.
let ratio = 3.4;
for (let k = 0; k < 2; k++) {
  const chars = 90_000;
  const r = await post(gateA(fill(chars, 0)), true);
  const t = r.json?.usage?.input_tokens;
  if (t) ratio = chars / t; // includes the fixed ~1.4k-token question overhead; refined below by the per-size solve
}
console.log('chars per token (rough)', ratio.toFixed(2));
const solve = async (target, build) => {
  let chars = Math.round(target * ratio);
  for (let k = 0; k < 3; k++) {
    const r = await post(build(fill(chars, 0)), true);
    const t = r.json?.usage?.input_tokens;
    if (!t) return chars;
    chars = Math.round(chars * (target / t));
    if (Math.abs(t - target) / target < 0.03) break;
  }
  return chars;
};

const rows = [];
const log = (row) => { rows.push(row); };
for (const size of SIZES) {
  const chars = await solve(size, (f) => gateA(f));
  console.log('size', size, 'chars', chars);
  for (const header of size <= 30000 ? [false, true] : [true]) {
    if (PARTS.includes('gateA')) {
      for (let rep = 0; rep < REPS; rep++) {
        const base = fill(chars, rep);
        const variants = [['control', null], ['needle@10', 0.1], ['needle@50', 0.5], ['needle@90', 0.9], ['needle@end', 'end']];
        for (const [name, frac] of variants) {
          const prompt = gateAPrompt(base, frac, rep);
          const r = await post(gateA(prompt), header);
          const noul = r.json?.answers?.forbids_delegation?.noul ?? null;
          log({ part: 'gateA', size, header, rep, variant: name, status: r.status, err: r.errType, ms: r.ms, tokens: r.json?.usage?.input_tokens ?? null, value: noul, label: frac === null ? 0 : 1 });
        }
      }
    }
    if (PARTS.includes('router')) {
      for (let rep = 0; rep < REPS; rep++) {
        const base = fill(chars, rep);
        for (const it of items) {
          for (const [name, frac] of [['start', 0], ['mid', 0.5], ['end', 1]]) {
            const text = frac === 0 ? `${it.text}\n\n${base}` : frac === 1 ? `${base}\n\n${it.text}` : place(base, 0.5, it.text);
            const r = await post(router(text), header);
            const cap = r.json?.answers?.capability;
            const a = cap ? validateChoice(cap, Object.keys(offer.questions.capability.criteria)) : null;
            log({ part: 'router', size, header, rep, item: it.id, variant: name, status: r.status, err: r.errType, ms: r.ms, tokens: r.json?.usage?.input_tokens ?? null, value: a?.choice ?? null, label: it.label });
          }
        }
      }
    }
  }
  writeFileSync(OUT, JSON.stringify({ ratio, rows }));
}
// Short-state references (no header): the Gate A needle in a 4,000-character paste, and the router items alone.
if (PARTS.includes('gateA')) {
  for (let rep = 0; rep < REPS; rep++) {
    const base = fill(4000, rep);
    for (const [name, frac] of [['control', null], ['needle@10', 0.1], ['needle@50', 0.5], ['needle@90', 0.9], ['needle@end', 'end']]) {
      const prompt = gateAPrompt(base, frac, rep);
      const r = await post(gateA(prompt), false);
      log({ part: 'gateA', size: 0, header: false, rep, variant: name, status: r.status, err: r.errType, ms: r.ms, tokens: r.json?.usage?.input_tokens ?? null, value: r.json?.answers?.forbids_delegation?.noul ?? null, label: frac === null ? 0 : 1 });
    }
  }
}
if (PARTS.includes('gateA')) {
  for (let rep = 0; rep < REPS; rep++) {
    const r = await post(gateA(NEEDLES[rep % NEEDLES.length]), false);
    log({ part: 'gateA', size: -1, header: false, rep, variant: 'needle-only', status: r.status, err: r.errType, ms: r.ms, tokens: r.json?.usage?.input_tokens ?? null, value: r.json?.answers?.forbids_delegation?.noul ?? null, label: 1 });
  }
}
// Short-state reference for the router items (no filler, no header).
for (const it of items) {
  for (let rep = 0; rep < REPS; rep++) {
    const r = await post(router(it.text), false);
    const a = r.json?.answers?.capability ? validateChoice(r.json.answers.capability, Object.keys(offer.questions.capability.criteria)) : null;
    log({ part: 'router', size: 0, header: false, rep, item: it.id, variant: 'short', status: r.status, err: r.errType, ms: r.ms, tokens: r.json?.usage?.input_tokens ?? null, value: a?.choice ?? null, label: it.label });
  }
}
writeFileSync(OUT, JSON.stringify({ ratio, rows }));
console.log('done', rows.length);
