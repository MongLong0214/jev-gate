import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/activity.js', async (original) => {
  const actual = await original<typeof import('../src/activity.js')>();
  return { ...actual, loadActivity: (...args: Parameters<typeof actual.loadActivity>) => { loads.count++; return actual.loadActivity(...args); } };
});
// A held gate keeps a finished rebuild in flight, standing in for a long history; `fail` makes the next rebuilds fail.
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, fail: false, started: 0 }));
vi.mock('../src/activity-engine.js', async (original) => {
  const actual = await original<typeof import('../src/activity-engine.js')>();
  return { ...actual, activityEngine: (sources: Parameters<typeof actual.activityEngine>[0]) => {
    const engine = actual.activityEngine(sources);
    return { ...engine, load: async () => { gate.started++; const value = await engine.load(); await gate.hold; if (gate.fail) throw new Error('unreadable'); return value; } };
  } };
});
const { startDashboard } = await import('../src/dashboard.js');

const dirs: string[] = [];
afterEach(() => { gate.hold = null; gate.fail = false; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const make = (): string => { const dir = mkdtempSync(join(tmpdir(), 'jev-shared-load-')); dirs.push(dir); return dir; };

// #210: concurrent viewers and snapshot requests share one rebuild instead of each computing the history.
describe('dashboard rebuild sharing (#210)', () => {
  it('computes once for simultaneous viewers and once more per change', async () => {
    const trace = make();
    writeFileSync(join(trace, 'a.json'), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
    const server = await startDashboard({ traceDir: trace, debugDir: null, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
    const frame = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
      for (;;) {
        const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('frame timed out')), 5000))]);
        if (chunk.done) throw new Error('SSE ended');
        const text = new TextDecoder().decode(chunk.value);
        if (text.includes('data: {')) return text;
      }
    };
    try {
      loads.count = 0;
      const responses = await Promise.all([fetch(`${server.url}api/live`), fetch(`${server.url}api/live`), fetch(`${server.url}api/live`), fetch(`${server.url}api/snapshot`)]);
      readers.push(...responses.slice(0, 3).map(r => r.body!.getReader()));
      expect(((await responses[3]!.json()) as { traceFiles: number }).traceFiles).toBe(1);
      for (const reader of readers) expect(await frame(reader)).toContain('"traceFiles":1');
      expect(loads.count).toBe(1);

      writeFileSync(join(trace, 'b.json'), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
      for (const reader of readers) expect(await frame(reader)).toContain('"traceFiles":2');
      expect(loads.count).toBe(2);
    } finally {
      for (const reader of readers) await reader.cancel().catch(() => undefined);
      await server.close();
    }
  });
});

// #215: a snapshot request no longer waits behind the rebuild in flight while a viewer keeps the frame current.
describe('dashboard snapshot latency (#215)', () => {
  const record = (dir: string, name: string): void => writeFileSync(join(dir, name), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
  const files = async (response: Response): Promise<number> => ((await response.json()) as { traceFiles: number }).traceFiles;
  const timed = async (url: string): Promise<{ ms: number; response: Response }> => {
    const started = performance.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { ms: performance.now() - started, response };
  };
  const until = async (done: () => boolean): Promise<void> => {
    for (const deadline = Date.now() + 5000; !done();) { if (Date.now() > deadline) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };

  it('answers with the loaded frame during a slow rebuild, and waits only for the first load', async () => {
    const trace = make();
    record(trace, 'a.json');
    const server = await startDashboard({ traceDir: trace, debugDir: null, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    let release = (): void => undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // The first load has nothing to show yet, so the request waits for it.
      gate.hold = new Promise(resolve => { release = resolve; });
      const first = fetch(`${server.url}api/snapshot`);
      await until(() => gate.started > 0);
      const settled = await Promise.race([first.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 300))]);
      expect(settled).toBe(false);
      release(); gate.hold = null;
      expect(await files(await first)).toBe(1);

      reader = (await fetch(`${server.url}api/live`)).body!.getReader();
      gate.hold = new Promise(resolve => { release = resolve; });
      const before = gate.started;
      record(trace, 'b.json');
      await until(() => gate.started > before);
      const during = await timed(`${server.url}api/snapshot`);
      expect(during.ms).toBeLessThan(500);
      expect(during.response.status).toBe(200);
      expect(await files(during.response)).toBe(1);

      release(); gate.hold = null;
      for (let text = ''; !text.includes('"traceFiles":2');) text = new TextDecoder().decode((await reader.read()).value);
      expect(await files(await fetch(`${server.url}api/snapshot`))).toBe(2);
    } finally {
      release();
      await reader?.cancel().catch(() => undefined);
      await server.close();
    }
  });

  it('brings the frame up to date when no viewer keeps it current', async () => {
    const trace = make();
    record(trace, 'a.json');
    const server = await startDashboard({ traceDir: trace, debugDir: null, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    try {
      expect(await files(await fetch(`${server.url}api/snapshot`))).toBe(1);
      record(trace, 'b.json');
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(await files(await fetch(`${server.url}api/snapshot`))).toBe(2);
    } finally {
      await server.close();
    }
  });

  it('answers 503 while nothing has loaded', async () => {
    gate.fail = true;
    const server = await startDashboard({ traceDir: make(), debugDir: null, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    try {
      const response = await fetch(`${server.url}api/snapshot`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'activity_unavailable' });
    } finally {
      await server.close();
    }
  });
});
