import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecker } from './_lib.mjs';
const BROKEN_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'job-queue', 'src');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, wait(ms).then(() => { throw new Error('timeout'); })]);
await runChecker(
  ['module_loads', 'rejection_propagates', 'queue_continues_after_failure', 'sync_throw_rejects', 'onError_receives_error_and_job_id', 'drain_resolves_with_failures', 'concurrency_preserved', 'regression_tests_detect_bug', 'test_suite_passes'],
  async ({ check, importModule, runTests, runTestsAgainst }) => {
    let mod;
    await check('module_loads', async () => { mod = await importModule('src/queue.mjs'); return typeof mod.createQueue === 'function'; });
    if (!mod) return;
    await check('rejection_propagates', async () => { const q = mod.createQueue({ concurrency: 1 }); try { await withTimeout(q.enqueue(async () => { throw new Error('boom'); }), 500); return false; } catch (e) { return e.message === 'boom'; } });
    await check('queue_continues_after_failure', async () => { const q = mod.createQueue({ concurrency: 1 }); q.enqueue(async () => { throw new Error('x'); }).catch(() => undefined); const v = await withTimeout(q.enqueue(async () => 'ok'), 500); return v === 'ok'; });
    await check('sync_throw_rejects', async () => { const q = mod.createQueue({ concurrency: 1 }); try { await withTimeout(q.enqueue(() => { throw new Error('sync'); }), 500); return false; } catch (e) { return e.message === 'sync'; } });
    await check('onError_receives_error_and_job_id', async () => { const seen = []; const q = mod.createQueue({ concurrency: 1, onError: (e, id) => seen.push([e.message, id]) }); await withTimeout(q.enqueue(async () => { throw new Error('e1'); }).catch(() => undefined), 500); await withTimeout(q.enqueue(async () => 'fine'), 500); return seen.length === 1 && seen[0][0] === 'e1' && seen[0][1] !== undefined && seen[0][1] !== null; });
    await check('drain_resolves_with_failures', async () => { const q = mod.createQueue({ concurrency: 2 }); q.enqueue(async () => { await wait(5); throw new Error('a'); }).catch(() => undefined); q.enqueue(async () => { await wait(5); return 1; }); await withTimeout(q.drain(), 500); return q.size() === 0; });
    await check('concurrency_preserved', async () => { const q = mod.createQueue({ concurrency: 2 }); let active = 0; let peak = 0; let done = 0; const job = (fail) => async () => { active++; peak = Math.max(peak, active); await wait(5); active--; done++; if (fail) throw new Error('f'); return 1; }; await withTimeout(Promise.allSettled([q.enqueue(job(true)), q.enqueue(job(false)), q.enqueue(job(true)), q.enqueue(job(false))]), 1000); return peak === 2 && done === 4; });
    await check('regression_tests_detect_bug', () => runTestsAgainst(BROKEN_SRC) === false);
    await check('test_suite_passes', () => runTests());
  },
);
