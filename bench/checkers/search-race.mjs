import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runChecker, sameKeys } from './_lib.mjs';

// The pristine broken fixture, used only to verify that the candidate's tests actually fail on the bug.
const BROKEN_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'search-race', 'src');

await runChecker(
  ['module_loads', 'export_preserved', 'return_shape_preserved', 'stale_response_ignored', 'late_response_test_detects_bug', 'test_suite_passes'],
  async ({ check, importModule, runTests, runTestsAgainst }) => {
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
    // Requested behavior: a test that reproduces the late-response case. Checked by behavior, not file count:
    // the candidate's own tests must fail when run against the unfixed source.
    await check('late_response_test_detects_bug', () => runTestsAgainst(BROKEN_SRC) === false);
    await check('test_suite_passes', () => runTests());
  },
);
