import { parentPort, workerData } from 'node:worker_threads';
import { activityHandler } from './activity-engine.js';
import type { DashboardSources } from './dashboard.js';

// The dashboard's activity thread: one handler, so the history caches persist between snapshots.
const handler = activityHandler(workerData as DashboardSources);
parentPort?.on('message', async ({ id, op, args }: { id: number; op: keyof typeof handler; args: unknown[] }) => {
  try { parentPort?.postMessage({ id, value: await (handler[op] as (...a: unknown[]) => unknown)(...args) }); }
  catch (error) { parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
});
