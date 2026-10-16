import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Live check of the context_exceeded mapping: Gate A requests of growing size through the production callJev, no header.
const R = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const { callJev } = await import(`${R}/dist/jev.js`);
const { buildAtomicAdmissionRequest } = await import(`${R}/dist/admission.js`);
const { DEFAULT_CONFIG } = await import(`${R}/dist/config.js`);
const walk = (d, out = []) => { for (const f of readdirSync(d).sort()) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p, out); else if (/\.(ts|md|mjs)$/.test(f)) out.push(p); } return out; };
const corpus = [...walk(`${R}/src`), ...walk(`${R}/docs`)].map((p) => readFileSync(p, 'utf8')).join('\n');
for (const chars of [60000, 95000, 100000, 105000, 110000, 120000]) {
  const req = buildAtomicAdmissionRequest(corpus.slice(0, chars), DEFAULT_CONFIG);
  const res = [];
  for (let i = 0; i < 2; i++) {
    const o = await callJev(req, { apiKey: process.env.TYPESAFE_API_KEY, deadlineMs: 10000 });
    res.push(o.ok ? `ok(${o.response.usage.input_tokens} tok)` : `${o.code}/${o.status}`);
  }
  console.log(chars, 'chars', res.join(' '));
}
