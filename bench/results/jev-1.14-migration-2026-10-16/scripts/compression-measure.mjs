// Plain vs gzip vs zstd request bodies to the TypeSafe endpoint, per call-site body corpus. Latency includes client compression.
import https from 'node:https';
import zlib from 'node:zlib';
import { appendFileSync, readFileSync } from 'node:fs';

const KEY = process.env.TYPESAFE_API_KEY;
if (!KEY) throw new Error('no key');
const corpus = JSON.parse(readFileSync(new URL('./corpus.json', import.meta.url), 'utf8'));
const OUT = process.argv[2];
const SITES = (process.argv[3] ?? 'gateA,gateB,router,evidence,compact').split(',');
const MODES = (process.argv[4] ?? 'fresh-seq,reuse-seq,par8').split(',');
const N = Number(process.argv[5] ?? 200);
const ENCS = ['plain', 'gzip', 'zstd'];
const URLO = new URL('https://api.typesafe.ai/v1/systemone');

const encode = (enc, body) => {
  if (enc === 'plain') return { buf: Buffer.from(body), headers: {} };
  if (enc === 'gzip') return { buf: zlib.gzipSync(body), headers: { 'content-encoding': 'gzip' } };
  return { buf: zlib.zstdCompressSync(body), headers: { 'content-encoding': 'zstd' } };
};

const keepAlive = new https.Agent({ keepAlive: true, maxSockets: 8 });
const send = (enc, body, agent) => new Promise((resolve) => {
  const t0 = performance.now();
  const { buf, headers } = encode(enc, body);
  const tCompress = performance.now() - t0;
  const req = https.request({ hostname: URLO.hostname, path: URLO.pathname, method: 'POST', agent, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'content-length': buf.length, ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let ok = false;
      if (res.statusCode === 200) { try { ok = typeof JSON.parse(text).answers === 'object'; } catch { /* not json */ } }
      resolve({ enc, status: res.statusCode, ok, ms: performance.now() - t0, compress_ms: tCompress, wire: buf.length, raw: Buffer.byteLength(body) });
    });
  });
  req.on('error', (e) => resolve({ enc, status: 0, ok: false, ms: performance.now() - t0, compress_ms: tCompress, wire: buf.length, raw: Buffer.byteLength(body), err: e.code ?? e.message }));
  req.end(buf);
});

const mulberry = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

for (const site of SITES) {
  const bodies = corpus[site];
  for (const mode of MODES) {
    const rnd = mulberry(site.length * 7919 + mode.length);
    const rows = [];
    if (mode === 'par8') {
      const tasks = [];
      for (let i = 0; i < N; i++) for (const enc of ENCS) tasks.push({ i, enc });
      tasks.sort(() => rnd() - 0.5);
      let next = 0;
      const t0 = performance.now();
      await Promise.all(Array.from({ length: 8 }, async () => { for (;;) { const k = next++; if (k >= tasks.length) return; const { i, enc } = tasks[k]; rows.push({ i, ...(await send(enc, bodies[i % bodies.length], keepAlive)) }); } }));
      appendFileSync(OUT, JSON.stringify({ site, mode, wall_ms: performance.now() - t0, rows }) + '\n');
    } else {
      const fresh = mode === 'fresh-seq';
      const agent = fresh ? false : new https.Agent({ keepAlive: true, maxSockets: 1 });
      for (let i = 0; i < N; i++) {
        const order = [...ENCS].sort(() => rnd() - 0.5);
        for (const enc of order) rows.push({ i, ...(await send(enc, bodies[i % bodies.length], agent)) });
      }
      if (!fresh) agent.destroy();
      appendFileSync(OUT, JSON.stringify({ site, mode, rows }) + '\n');
    }
    console.log(new Date().toISOString(), site, mode, 'done', rows.length);
  }
}
