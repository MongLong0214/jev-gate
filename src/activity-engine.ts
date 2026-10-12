import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { loadActivity } from './activity.js';
import { ClaudeWorkerActivityReader } from './claude-worker-activity.js';
import type { DashboardSources } from './dashboard.js';
import { TraceDirectoryReader } from './explain.js';

/** A serialized snapshot. The dashboard sends it as is and compares only the short key. */
export interface LoadedActivity { json: string; key: string; pending: boolean; directories: string[]; ms: number }

/** Owns the readers and their caches. It runs on the activity thread, or in process when that thread is unavailable. */
export const activityHandler = (sources: DashboardSources) => {
  const traceReader = new TraceDirectoryReader(), workerReader = new ClaudeWorkerActivityReader();
  const dirs = sources.traceDirs?.map(source => source.dir) ?? (sources.traceDir ? [sources.traceDir] : []);
  return {
    async load(): Promise<LoadedActivity> {
      const started = performance.now();
      for (const dir of dirs) await traceReader.prepare(dir);
      const activity = loadActivity({ ...sources, traceReader, workerReader, now: new Date() });
      const pending = activity.live.mode === 'working' || activity.operations.feed.some(step => step.state === 'active') || activity.workerActivity?.items.some(worker => worker.state === 'active') === true;
      return { json: JSON.stringify(activity), key: `${activity.live.sig}:${activity.operations.sig}:${activity.workerActivity?.sig}:${activity.unreadable}`,
        pending, directories: workerReader.directories(), ms: performance.now() - started };
    },
    invalidate(dir: string, names?: string[]): void { if (names) for (const name of names) traceReader.invalidate(dir, name); else traceReader.invalidate(dir); },
    list(offset: number) { return workerReader.list(offset, new Date()); },
    history(session: string, agent: string, offset: number) { return workerReader.history(session, agent, offset, sources.env, new Date()); },
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
    invalidate: (dir, names) => call({ op: 'invalidate', args: [dir, names] }),
    list: (offset) => call({ op: 'list', args: [offset] }),
    history: (session, agent, offset) => call({ op: 'history', args: [session, agent, offset] }),
    close: async () => { const thread = worker; stop(); await thread?.terminate(); },
  };
};
