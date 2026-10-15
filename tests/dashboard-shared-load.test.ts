import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/activity.js', async (original) => {
  const actual = await original<typeof import('../src/activity.js')>();
  return { ...actual, loadActivity: (...args: Parameters<typeof actual.loadActivity>) => { loads.count++; return actual.loadActivity(...args); } };
});
// A held gate keeps a finished rebuild in flight, standing in for a long history; `fail` makes the next rebuilds fail.
// `ms` reports a rebuild as that long; `starts` and `ends` record when each rebuild began and finished.
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, fail: false, started: 0, ms: null as number | null, starts: [] as number[], ends: [] as number[] }));
vi.mock('../src/activity-engine.js', async (original) => {
  const actual = await original<typeof import('../src/activity-engine.js')>();
  return { ...actual, activityEngine: (sources: Parameters<typeof actual.activityEngine>[0]) => {
    const engine = actual.activityEngine(sources);
    return { ...engine, load: async () => {
      gate.started++; gate.starts.push(Date.now());
      const value = await engine.load(); await gate.hold; if (gate.fail) throw new Error('unreadable');
      gate.ends.push(Date.now());
      return gate.ms === null ? value : { ...value, ms: gate.ms };
    } };
  } };
});
const { startDashboard, pruneViewers, rebuildWait, VIEWER_LEASES } = await import('../src/dashboard.js');
const { activityHandler } = await import('../src/activity-engine.js');

const dirs: string[] = [];
afterEach(() => { gate.hold = null; gate.fail = false; gate.ms = null; gate.starts = []; gate.ends = []; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const make = (): string => { const dir = mkdtempSync(join(tmpdir(), 'jev-shared-load-')); dirs.push(dir); return dir; };

// #210: concurrent viewers and snapshot requests share one rebuild instead of each computing the history.
describe('dashboard rebuild sharing (#210)', () => {
  it('computes once for simultaneous viewers and once more per change', async () => {
    const trace = make();
    writeFileSync(join(trace, 'a.json'), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
    const server = await startDashboard({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
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

  it('does not rebuild without a new record before the next edge, even with a missing host directory', async () => {
    // Open viewers ask for a rebuild at least every 30 seconds; with an unchanged history each one rebuilt the whole of it.
    const trace = make(), handler = activityHandler({ traceDir: null, traceDirs: [{ host: 'claude', dir: trace }, { host: 'codex', dir: join(trace, 'missing') }], env: { HOME: make(), JEV_GATE_STATE_DIR: make() } });
    writeFileSync(join(trace, 'a.json'), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
    loads.count = 0;
    const first = await handler.load(), again = await handler.load();
    expect(loads.count).toBe(1);
    expect(again).toMatchObject({ key: first.key, base: null, patch: null });
    writeFileSync(join(trace, 'b.json'), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
    handler.invalidate(trace, ['b.json']);
    const changed = await handler.load();
    expect(loads.count).toBe(2);
    expect(changed.base).toBe(first.key);
  });

  it('rebuilds when only the liveness ring changed', async () => {
    const trace = make(), state = make(), handler = activityHandler({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: state } });
    writeFileSync(join(trace, 'a.json'), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
    const first = await handler.load();
    mkdirSync(join(state, 'jev-gate'));
    writeFileSync(join(state, 'jev-gate', 'liveness.json'), JSON.stringify({ version: 1, recent: [{ at: new Date().toISOString(), attempted: true, reason: null }] }));
    const changed = await handler.load();
    expect(changed.base).toBe(first.key);
    expect(changed.patch).toContain('"recorded":1');
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
    const server = await startDashboard({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
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
    const server = await startDashboard({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
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
    const server = await startDashboard({ traceDir: make(), env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    try {
      const response = await fetch(`${server.url}api/snapshot`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'activity_unavailable' });
    } finally {
      await server.close();
    }
  });
});

// A stream of records once kept the activity thread rebuilding half the time: each pause lasted as long as the last rebuild.
describe('dashboard rebuild pacing', () => {
  const record = (dir: string, name: string): void => writeFileSync(join(dir, name), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));

  it('waits four times the last rebuild from its start, between one and four seconds', () => {
    expect([0, 100, 400, 1000, 9000].map(rebuildWait)).toEqual([1000, 1000, 1600, 4000, 4000]);
  });

  it('starts the first load at once, then keeps each pause and still shows a new record within seconds', async () => {
    const trace = make();
    record(trace, 'r0.json');
    gate.ms = 400; // 1.6 seconds from one rebuild's start to the next
    const server = await startDashboard({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    const opened = Date.now();
    const reader = (await fetch(`${server.url}api/live`)).body!.getReader();
    let written = 0;
    const writer = setInterval(() => record(trace, `r${++written}.json`), 100);
    try {
      let text = '';
      const shows = async (files: number): Promise<void> => {
        while (!text.includes(`"traceFiles":${files}`)) text += new TextDecoder().decode((await reader.read()).value);
      };
      await shows(1);
      expect(gate.starts[0]! - opened).toBeLessThan(500);
      await new Promise(resolve => setTimeout(resolve, 3500));
      clearInterval(writer);
      const last = written + 1, stopped = Date.now();
      await shows(last);
      expect(Date.now() - stopped).toBeLessThan(3000);
      expect(gate.starts.length).toBeGreaterThan(2);
      for (let i = 1; i < gate.starts.length; i++) expect(gate.starts[i]! - gate.starts[i - 1]!).toBeGreaterThanOrEqual(rebuildWait(400) - 5);
    } finally {
      clearInterval(writer);
      await reader.cancel().catch(() => undefined);
      await server.close();
    }
  }, 15_000);

  it('starts the rebuild for a record written after a slow one a second after that one started, not a second after it ended', async () => {
    // The pause once counted from the end of a rebuild, so a record waited its whole length on top of the pause.
    const trace = make();
    record(trace, 'r0.json');
    gate.ms = 0; gate.hold = new Promise(resolve => setTimeout(resolve, 800));
    const server = await startDashboard({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    const reader = (await fetch(`${server.url}api/live`)).body!.getReader();
    try {
      let text = '';
      const shows = async (files: number): Promise<void> => {
        while (!text.includes(`"traceFiles":${files}`)) text += new TextDecoder().decode((await reader.read()).value);
      };
      await shows(1);
      record(trace, 'r1.json');
      await shows(2);
      expect(gate.starts[1]! - gate.starts[0]!).toBeGreaterThanOrEqual(rebuildWait(0) - 5);
      expect(gate.starts[1]! - gate.starts[0]!).toBeLessThan(1500);
    } finally {
      await reader.cancel().catch(() => undefined);
      await server.close();
    }
  }, 10_000);
});

describe('dashboard viewer leases', () => {
  it('drops expired reconnect leases and keeps at most VIEWER_LEASES, newest first', () => {
    const viewers = new Map<string, number>([['open', Infinity], ['gone', 5]]);
    for (let i = 0; i < 200; i++) viewers.set(`legacy-${i}`, 100 + i);
    pruneViewers(viewers, 10);
    expect(viewers.get('open')).toBe(Infinity);
    expect(viewers.has('gone')).toBe(false);
    expect(viewers.size).toBe(VIEWER_LEASES + 1);
    expect(viewers.has('legacy-199')).toBe(true);
    expect(viewers.has('legacy-0')).toBe(false);
  });
});
