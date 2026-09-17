import { runChecker, sameKeys } from './_lib.mjs';

await runChecker(
  ['module_loads', 'export_preserved', 'return_shape_preserved', 'stale_response_ignored', 'late_response_test_added', 'test_suite_passes'],
  async ({ check, importModule, runTests, countTestFiles }) => {
    let mod;
    await check('module_loads', async () => {
      mod = await importModule('src/search-client.mjs');
      return true;
    });
    if (!mod) return;
    await check('export_preserved', () => typeof mod.createSearchClient === 'function' && sameKeys(mod, ['createSearchClient']));
    await check('return_shape_preserved', async () => {
      const client = mod.createSearchClient(async (q) => [`${q}-1`]);
      const result = await client.search('x');
      return sameKeys(result, ['query', 'items']) && result.query === 'x' && JSON.stringify(result.items) === JSON.stringify(['x-1']);
    });
    await check('stale_response_ignored', async () => {
      const pending = new Map();
      const client = mod.createSearchClient((q) => new Promise((resolve) => pending.set(q, resolve)));
      const first = client.search('old');
      const second = client.search('new');
      pending.get('new')(['new-1']);
      await second;
      pending.get('old')(['old-1']);
      await first;
      const state = client.getState();
      return state.query === 'new' && JSON.stringify(state.results) === JSON.stringify(['new-1']);
    });
    await check('late_response_test_added', () => countTestFiles() >= 2);
    await check('test_suite_passes', () => runTests());
  },
);
