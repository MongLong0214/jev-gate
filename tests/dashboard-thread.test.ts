import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadActivity } from '../src/activity.js';
import { TraceDirectoryReader } from '../src/explain.js';

// #210: the compiled dashboard rebuilds a long history on its activity thread, so health and live streams keep answering.
describe('dashboard activity thread (#210)', () => {
  const root = join(__dirname, '..');
  let tmp: string, dist: string, trace: string, home: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jev-dashboard-thread-'));
    dist = join(tmp, 'dist'); trace = join(tmp, 'trace'); home = join(tmp, 'home');
    const r = spawnSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(root, 'tsconfig.json'), '--outDir', dist], { encoding: 'utf8' });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    mkdirSync(trace); mkdirSync(home);
    const at = Date.parse('2026-10-01T00:00:00.000Z');
    for (let i = 0; i < 4000; i++) {
      const base = { session_id: `s${i % 200}`, prompt_id: `p${i}`, written_at: new Date(at + i * 1000).toISOString() };
      writeFileSync(join(trace, `admission_intent-${i}.json`), JSON.stringify({ ...base, phase: 'admission_intent', attempted: true }));
      writeFileSync(join(trace, `admission_result-${i}.json`), JSON.stringify({ ...base, phase: 'admission_result', attempted: true, decision: { shape: 'direct' }, latency_ms: 900 }));
      writeFileSync(join(trace, `mod_router-${i}.json`), JSON.stringify({ ...base, phase: 'mod_router', event: 'root', turn: `t${i}`, sent: true, assessment: 'applied' }));
    }
  }, 120_000);
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('answers health during rebuilds, shares one frame across viewers, follows directory replacement, and exits on shutdown', async () => {
    const env = { HOME: home, JEV_GATE_STATE_DIR: join(tmp, 'state') };
    // The same history rebuilt on the calling thread after its files are read: how long a rebuild would block the server.
    const traceReader = new TraceDirectoryReader();
    await traceReader.prepare(trace);
    const started = performance.now();
    loadActivity({ traceDir: trace, debugDir: null, env, traceReader });
    const blocking = performance.now() - started;

    const script = `import { monitorEventLoopDelay } from 'node:perf_hooks';
const { startDashboard } = await import(${JSON.stringify(join(dist, 'dashboard.js'))});
const s = await startDashboard({ traceDir: ${JSON.stringify(trace)}, debugDir: null, env: ${JSON.stringify(env)} }, 0, { token: 't' });
// Measured from the first request on, not over module loading.
const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
process.on('exit', () => process.stderr.write('delay ' + (h.max / 1e6) + '\\n'));
process.stdout.write(s.url + '\\n');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', d => { stderr += String(d); });
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    const url = await new Promise<string>((resolve, reject) => { child.stdout.once('data', d => resolve(String(d).trim())); child.once('exit', () => reject(new Error(stderr))); });

    type Viewer = { frames: string[]; reader: ReadableStreamDefaultReader<Uint8Array> };
    const watch = async (): Promise<Viewer> => {
      const reader = (await fetch(`${url}api/live`)).body!.getReader(), viewer: Viewer = { frames: [], reader };
      void (async () => {
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
          if (done) return;
          buffer += new TextDecoder().decode(value);
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const data = buffer.slice(0, end).split('\n').find(line => line.startsWith('data: '));
            if (data && !buffer.slice(0, end).includes('event: heartbeat')) viewer.frames.push(data.slice(6));
            buffer = buffer.slice(end + 2);
          }
        }
      })();
      return viewer;
    };
    const until = async (done: () => boolean, label: string): Promise<number> => {
      let answered = 0;
      const deadline = Date.now() + 20_000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`${label} timed out`);
        expect((await fetch(`${url}api/health`)).status).toBe(200); answered++;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return answered;
    };
    const files = (frame: string): number => (JSON.parse(frame) as { traceFiles: number }).traceFiles;
    const viewers: Viewer[] = [];
    try {
      viewers.push(...await Promise.all([watch(), watch(), watch()]));
      const answered = await until(() => viewers.every(v => v.frames.length > 0), 'first frame');
      expect(answered).toBeGreaterThan(0);
      expect(new Set(viewers.map(v => v.frames[0])).size).toBe(1);
      expect(files(viewers[0]!.frames[0]!)).toBe(12_000);

      writeFileSync(join(trace, 'zz-new.json'), JSON.stringify({ phase: 'stop', session_id: 'late', written_at: new Date().toISOString(), outcome: 'completed' }));
      await until(() => viewers.every(v => v.frames.length > 1), 'update');
      expect(viewers.map(v => files(v.frames.at(-1)!))).toEqual([12_001, 12_001, 12_001]);

      rmSync(trace, { recursive: true }); mkdirSync(trace);
      writeFileSync(join(trace, 'replacement.json'), JSON.stringify({ phase: 'stop', session_id: 'next', written_at: new Date().toISOString(), outcome: 'completed' }));
      await until(() => viewers.every(v => files(v.frames.at(-1)!) === 1), 'replacement');
      const snapshot = await (await fetch(`${url}api/snapshot`)).json() as { traceFiles: number };
      expect(snapshot.traceFiles).toBe(1);

      expect((await fetch(`${url}api/shutdown`, { method: 'POST', headers: { authorization: 'Bearer t' } })).status).toBe(200);
      // Exiting on its own shows the activity thread does not hold the process open.
      expect(await exited).toBe(0);
      const delay = Number(/delay ([\d.]+)/.exec(stderr)?.[1]);
      // On the calling thread the server would stall for about `blocking` on each rebuild (verified by removing the worker file).
      expect(delay).toBeLessThan(blocking / 2);
    } finally {
      for (const v of viewers) await v.reader.cancel().catch(() => undefined);
      child.kill();
    }
  }, 60_000);
});
