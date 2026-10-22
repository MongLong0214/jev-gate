import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyPatch } from './live-frames.js';

const settingsReads = vi.hoisted(() => ({ count: 0 }));
const watchEvents = vi.hoisted(() => ({ dropped: false }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, watch: (path: string, listener: (event: string, name: string | null) => void) => actual.watch(path, (event, name) => { if (!watchEvents.dropped) listener(event, name); }) };
});
vi.mock('../src/recording.js', async original => {
  const actual = await original<typeof import('../src/recording.js')>();
  return { ...actual, recordingStatus: (...args: Parameters<typeof actual.recordingStatus>) => { settingsReads.count++; return actual.recordingStatus(...args); } };
});
vi.mock('../src/dashboard-settings.js', async original => {
  const actual = await original<typeof import('../src/dashboard-settings.js')>();
  return { ...actual, dashboardStatus: (...args: Parameters<typeof actual.dashboardStatus>) => { settingsReads.count++; return actual.dashboardStatus(...args); } };
});

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
const { setRecording } = await import('../src/recording.js');

const dirs: string[] = [];
afterEach(() => { watchEvents.dropped = false; gate.hold = null; gate.fail = false; gate.ms = null; gate.starts = []; gate.ends = []; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
    writeFileSync(join(trace, 'c.json'), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
    // Directory mtime also discovers a new filename when a watch notification has not arrived yet.
    expect((await handler.load()).base).toBe(changed.key);
    expect(loads.count).toBe(3);
  });

  it('discovers a missed name alongside a notified name on explicit name reconciliation', async () => {
    const trace = make(), handler = activityHandler({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } });
    const record = (name: string): void => writeFileSync(join(trace, name), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
    record('a.json'); await handler.load();
    record('b.json'); record('missed.json');
    handler.invalidate(trace, ['b.json']); await handler.load();
    handler.reconcile(trace); await handler.load();
    expect(JSON.parse(handler.full()!.json).traceFiles).toBe(3);
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

  it('refreshes doctor facts at the 24-hour boundary and Compact grace edge without a new trace', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = new Date('2026-10-20T06:00:00.000Z'); vi.setSystemTime(now);
      const trace = make(), handler = activityHandler({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } });
      writeFileSync(join(trace, 'a.json'), JSON.stringify({ phase: 'admission_result', session_id: 's', written_at: new Date(+now - 86_400_000 + 1000).toISOString(), decision: { shape: 'orchestrated' } }));
      writeFileSync(join(trace, 'c.json'), JSON.stringify({ phase: 'mod_compact', stage: 'pre', mode: 'active', session_id: 'c', written_at: now.toISOString() }));
      const facts = () => (JSON.parse(handler.full()!.json) as { activity24h: { all: Array<{ feature: string; level: string; metrics: { fired: number } }> } }).activity24h.all;
      const first = await handler.load();
      expect(facts().find(c => c.feature === 'admission')?.metrics.fired).toBe(1);
      expect(facts().find(c => c.feature === 'compact')?.level).toBe('ok');
      vi.setSystemTime(+now + 1000);
      expect((await handler.load()).base).toBe(first.key);
      expect(facts().find(c => c.feature === 'admission')?.metrics.fired).toBe(0);
      vi.setSystemTime(+now + 600_001);
      await handler.load();
      expect(facts().find(c => c.feature === 'compact')?.level).toBe('fail');
    } finally { vi.useRealTimers(); }
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

  it('coalesces fast bursts within one frame and never adds more than 100 ms of pacing', () => {
    expect([0, 100, 400, 1000, 9000].map(rebuildWait)).toEqual([16, 100, 100, 100, 100]);
  });

  it('starts the first load at once, then keeps each pause and still shows a new record within seconds', async () => {
    const trace = make();
    record(trace, 'r0.json');
    gate.ms = 400; // A slow rebuild is shared; arrivals never queue another load behind it.
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

  it('starts the rebuild for a record written after a slow one as soon as that one has ended without another long pause', async () => {
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

describe('event driven dashboard (#327)', () => {
  const record = (dir: string, name: string): void => writeFileSync(join(dir, name), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
  const viewer = async (url: string) => {
    const reader = (await fetch(url + 'api/live')).body!.getReader();
    const states: Record<string, unknown>[] = [], events: string[] = [];
    const reading = (async () => {
      const decoder = new TextDecoder(); let buffer = '', state: Record<string, unknown> | null = null;
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined })); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const lines = buffer.slice(0, end).split('\n'); buffer = buffer.slice(end + 2);
          const type = lines.find(line => line.startsWith('event: '))?.slice(7) ?? 'frame';
          const data = lines.find(line => line.startsWith('data: '))?.slice(6); events.push(type);
          if (data && type !== 'heartbeat') { state = type === 'patch' ? applyPatch(state, JSON.parse(data)) : JSON.parse(data); states.push(state!); }
        }
      }
    })();
    return { states, events, close: async () => { await reader.cancel().catch(() => undefined); await reading; } };
  };
  it('does no loads, rebuilds or preference reads during a quiet heartbeat interval with an open stream', async () => {
    const trace = make(); record(trace, 'a.json');
    const server = await startDashboard({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    const stream = await viewer(server.url);
    try {
      await vi.waitFor(() => expect(stream.states.length).toBeGreaterThan(0));
      await new Promise(resolve => setTimeout(resolve, 100));
      const before = { loads: gate.started, rebuilds: loads.count, reads: settingsReads.count };
      await vi.waitFor(() => expect(stream.events).toContain('heartbeat'), { timeout: 6000 });
      expect({ loads: gate.started, rebuilds: loads.count, reads: settingsReads.count }).toEqual(before);
      expect(stream.states).toHaveLength(1);
    } finally { await stream.close(); await server.close(); }
  }, 10_000);

  it('follows initially absent nested directories, replacement, appends and preference-only changes', async () => {
    const base = make(), trace = join(base, 'new', 'trace'), env = { HOME: make(), JEV_GATE_STATE_DIR: make() };
    const server = await startDashboard({ traceDir: trace, env }, 0);
    const stream = await viewer(server.url);
    const latest = () => stream.states.at(-1)!;
    try {
      await vi.waitFor(() => expect(latest()?.['traceFiles']).toBe(0));
      mkdirSync(trace, { recursive: true }); record(trace, 'a.json');
      await vi.waitFor(() => expect(latest()?.['traceFiles']).toBe(1));
      renameSync(trace, trace + '-old'); mkdirSync(trace); record(trace, 'b.json'); record(trace, 'c.json');
      await vi.waitFor(() => expect(latest()?.['traceFiles']).toBe(2));
      record(trace, 'd.json');
      await vi.waitFor(() => expect(latest()?.['traceFiles']).toBe(3));
      const frame = latest()['frame']; setRecording(env, false);
      await vi.waitFor(() => expect(latest()?.['recording']).toEqual({ enabled: false }));
      expect(latest()['frame']).not.toBe(frame);
      setRecording(env, true);
      await vi.waitFor(() => expect(latest()?.['recording']).toEqual({ enabled: true }));
      // The liveness ring may be the only record emitted; creating its parent must not need a trace event.
      mkdirSync(join(env.JEV_GATE_STATE_DIR, 'jev-gate'));
      writeFileSync(join(env.JEV_GATE_STATE_DIR, 'jev-gate/liveness.json'), JSON.stringify({ version: 1, recent: [{ at: new Date().toISOString(), attempted: true, reason: null }] }));
      await vi.waitFor(() => expect(latest()?.['liveness']).toMatchObject({ recorded: 1 }));
    } finally { await stream.close(); await server.close(); }
  });

  it('does not lose a record that arrives while an earlier rebuild is held', async () => {
    const trace = make(); record(trace, 'a.json');
    let release = (): void => undefined; gate.hold = new Promise(resolve => { release = resolve; });
    const server = await startDashboard({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    const stream = await viewer(server.url), before = gate.started;
    try {
      await vi.waitFor(() => expect(gate.started).toBeGreaterThanOrEqual(before));
      record(trace, 'b.json'); record(trace, 'c.json');
      await new Promise(resolve => setTimeout(resolve, 100)); release(); gate.hold = null;
      await vi.waitFor(() => expect(stream.states.at(-1)?.['traceFiles']).toBe(3));
      expect(stream.states.every(state => Number(state['traceFiles']) >= 1)).toBe(true);
    } finally { release(); await stream.close(); await server.close(); }
  });

  it('recovers dropped file and preference notifications promptly with one load only when metadata changes', async () => {
    const trace = make(), env = { HOME: make(), JEV_GATE_STATE_DIR: make() }; record(trace, 'a.json');
    const server = await startDashboard({ traceDir: trace, env }, 0), stream = await viewer(server.url);
    try {
      await vi.waitFor(() => expect(stream.states.at(-1)?.['traceFiles']).toBe(1));
      watchEvents.dropped = true; record(trace, 'b.json'); setRecording(env, false);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(stream.states.at(-1)?.['traceFiles']).toBe(1);
      const before = gate.started;
      await vi.waitFor(() => expect(stream.states.at(-1)?.['traceFiles']).toBe(2), { timeout: 1500 });
      expect(stream.states.at(-1)?.['recording']).toEqual({ enabled: false });
      expect(gate.started - before).toBe(1);
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(gate.started - before).toBe(1);
    } finally { watchEvents.dropped = false; await stream.close(); await server.close(); }
  });

  it('updates the 24-hour fact boundary on its deadline without a new file or polling', async () => {
    const trace = make(), env = { HOME: make(), JEV_GATE_STATE_DIR: make() };
    writeFileSync(join(trace, 'a.json'), JSON.stringify({ phase: 'admission_result', session_id: 's', written_at: new Date(Date.now() - 86_400_000 + 1500).toISOString(), decision: { shape: 'orchestrated' } }));
    record(trace, 'current.json'); // Keep trace visibility known after the older admission leaves the fact window.
    const server = await startDashboard({ traceDir: trace, env }, 0), stream = await viewer(server.url);
    const fired = () => (stream.states.at(-1)?.['activity24h'] as { all?: Array<{ feature: string; metrics: { fired: number } }> } | undefined)?.all?.find(row => row.feature === 'admission')?.metrics.fired;
    try {
      await vi.waitFor(() => expect(fired()).toBe(1));
      await vi.waitFor(() => expect(fired()).toBe(0), { timeout: 3000 });
    } finally { await stream.close(); await server.close(); }
  });
});
