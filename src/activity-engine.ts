import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { loadActivity } from './activity.js';
import { activityStableUntil } from './doctor-activity.js';
import type { DashboardSources } from './dashboard.js';
import { diffFrame, frameOperations, type FrameMemo, type FrameSnapshot } from './dashboard-patch.js';
import { TraceDirectoryReader, type TraceRead } from './explain.js';
import { livenessPath } from './liveness.js';
import { operationsStableUntil, type OperationsView } from './operations.js';
import { credentialsPath } from './credentials.js';
import { recordingPath } from './recording.js';

/** One rebuild. `key` advances only when content changed; `patch` turns the frame `base` into it. The whole frame is built
 * only when a viewer needs one (`full`), so a rebuild sends the changed part across the thread, not the history. Without new
 * records the frame stays the same until `until`, when a running step can turn unconfirmed. `ms` is the rebuild's own time,
 * without reading the directories first: a cold read or a reconciliation pass says nothing about what the next record costs. */
export interface LoadedActivity { key: string; base: string | null; patch: string | null; until: number; ms: number }

/** Owns the readers and their caches. It runs on the activity thread, or in process when that thread is unavailable. */
export const activityHandler = (sources: DashboardSources) => {
  const traceReader = new TraceDirectoryReader(1000);
  const dirs = sources.traceDirs?.map(source => source.dir) ?? (sources.traceDir ? [sources.traceDir] : []);
  // A replacement thread starts a new key series, so no viewer can apply its patches to an older thread's frame.
  const epoch = randomUUID().slice(0, 8);
  let sequence = 0, memo: FrameMemo | null = null, current: FrameSnapshot | null = null, whole: { key: string; json: string } | null = null;
  let operations: OperationsView | null = null;
  let last: { loaded: LoadedActivity; reads: TraceRead[]; liveness: string; preferences: string } | null = null;
  // The liveness ring is read on every rebuild; it is rewritten by rename, so a new inode or mtime marks a change.
  const livenessFile = sources.host === 'codex' ? null : livenessPath(sources.env);
  const livenessStamp = (): string => {
    try { const stat = livenessFile ? statSync(livenessFile, { throwIfNoEntry: false }) : undefined; return stat ? `${stat.ino}:${stat.mtimeMs}:${stat.size}` : ''; } catch { return ''; }
  };
  const preferenceStamp = (): string => [recordingPath(sources.env), credentialsPath(sources.env)].map(path => {
    try { const stat = statSync(path, { throwIfNoEntry: false }); return stat ? `${stat.ino}:${stat.mtimeMs}:${stat.size}` : ''; } catch { return ''; }
  }).join('|');
  return {
    async load(): Promise<LoadedActivity> {
      for (const dir of dirs) await traceReader.prepare(dir);
      const started = performance.now();
      // No record changed and no age or window edge passed: a rebuild would draw the same frame, so it is skipped.
      const reads = dirs.map(dir => traceReader.read(dir)), liveness = livenessStamp(), preferences = preferenceStamp();
      if (last && Date.now() < last.loaded.until && liveness === last.liveness && preferences === last.preferences && reads.every((read, i) => read === last!.reads[i])) return { ...last.loaded, base: null, patch: null };
      const now = new Date(), activity = loadActivity({ ...sources, traceReader, now, feed: false });
      const { events: _events, live: _live, ...rest } = activity, shown = { ...rest, operations: frameOperations(activity.operations) };
      const base = memo?.key ?? null, diff = diffFrame(memo, shown, () => `${epoch}.${++sequence}`);
      memo = diff.memo; current = shown; whole = null; operations = activity.operations;
      const until = Math.min(operationsStableUntil(), ...reads.map(read => activityStableUntil(read.records, now.getTime())));
      const loaded = { key: memo.key, base: diff.patch ? base : null, patch: diff.patch, until, ms: performance.now() - started };
      last = { loaded, reads, liveness, preferences };
      return loaded;
    },
    full(): { key: string; json: string } | null {
      if (!current || !memo) return null;
      return whole ??= { key: memo.key, json: JSON.stringify(current) };
    },
    /** One step as the last rebuild recorded it, with the detail fields frames leave out. */
    step(runId: string, stepId: string): string | null {
      const step = operations?.runs.find(run => run.id === runId)?.steps.find(step => step.id === stepId);
      return step ? JSON.stringify(step) : null;
    },
    invalidate(dir: string, names?: string[]): void { if (names) for (const name of names) traceReader.invalidate(dir, name); else traceReader.invalidate(dir); },
    reconcile(dir: string): void { traceReader.reconcile(dir); },
  };
};

type Handler = ReturnType<typeof activityHandler>;
type Call = { [K in keyof Handler]: { op: K; args: Parameters<Handler[K]> } }[keyof Handler];
export type ActivityEngine = { [K in keyof Handler]: (...args: Parameters<Handler[K]>) => Promise<Awaited<ReturnType<Handler[K]>>> } & { close(): Promise<void> };

/** Rebuilding a long history takes seconds of CPU; a separate thread keeps health checks and live streams answering.
 * Without the compiled worker (source tests) or after it stops, the same handler runs in process. */
export const activityEngine = (sources: DashboardSources): ActivityEngine => {
  let local: Handler | undefined;
  const inline = (): Handler => local ??= activityHandler(sources);
  const script = new URL(import.meta.url.endsWith('.mjs') ? './activity-worker.mjs' : './activity-worker.js', import.meta.url);
  let worker: Worker | null = null;
  const calls = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  const stop = (): void => {
    worker = null;
    for (const call of calls.values()) call.reject(new Error('activity worker stopped'));
    calls.clear();
  };
  if (existsSync(fileURLToPath(script))) {
    try {
      // The thread needs no Node flags, and an inherited `--input-type`/`-e` from the parent would stop it from starting.
      const started: Worker = new Worker(script, { execArgv: [], workerData: { ...sources, env: { ...sources.env } } });
      started.on('message', ({ id, value, error }: { id: number; value?: never; error?: string }) => {
        const call = calls.get(id); if (!call) return;
        calls.delete(id);
        if (error === undefined) call.resolve(value!); else call.reject(new Error(error));
      });
      started.on('error', () => { if (worker === started) stop(); });
      started.on('exit', () => { if (worker === started) stop(); });
      started.unref();
      worker = started;
    } catch { worker = null; }
  }
  const call = <T>({ op, args }: Call): Promise<T> => {
    const thread = worker;
    if (!thread) return (async () => (inline()[op] as (...a: unknown[]) => unknown)(...args) as T)();
    const id = ++sequence;
    return new Promise<T>((resolve, reject) => { calls.set(id, { resolve: resolve as (value: never) => void, reject }); thread.postMessage({ id, op, args }); });
  };
  return {
    load: () => call({ op: 'load', args: [] }),
    full: () => call({ op: 'full', args: [] }),
    step: (runId, stepId) => call({ op: 'step', args: [runId, stepId] }),
    invalidate: (dir, names) => call({ op: 'invalidate', args: [dir, names] }),
    reconcile: dir => call({ op: 'reconcile', args: [dir] }),
    close: async () => { const thread = worker; stop(); await thread?.terminate(); },
  };
};
