import { runChecker } from './_lib.mjs';

await runChecker(
  ['module_loads', 'counts_unlisted_status', 'missing_status_as_unknown', 'no_zero_keys', 'plain_object', 'existing_tests_pass'],
  async ({ check, importModule, runTests }) => {
    let mod;
    await check('module_loads', async () => {
      mod = await importModule('src/count-by-status.mjs');
      return typeof mod.countByStatus === 'function';
    });
    if (!mod) return;
    const items = [{ status: 'open' }, { status: 'closed' }, { status: 'open' }, { status: 'blocked' }, {}];
    await check('counts_unlisted_status', () => {
      const r = mod.countByStatus(items);
      return r.open === 2 && r.closed === 1 && r.blocked === 1;
    });
    await check('missing_status_as_unknown', () => mod.countByStatus(items).unknown === 1);
    await check('no_zero_keys', () => Object.keys(mod.countByStatus([])).length === 0 && !('open' in mod.countByStatus([{ status: 'closed' }])));
    await check('plain_object', () => {
      const r = mod.countByStatus(items);
      return Object.getPrototypeOf(r) === Object.prototype || Object.getPrototypeOf(r) === null;
    });
    await check('existing_tests_pass', () => runTests());
  },
);
