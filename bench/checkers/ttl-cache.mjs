import { runChecker } from './_lib.mjs';

await runChecker(
  ['module_loads', 'api_preserved', 'fresh_value_returned', 'expired_value_hidden', 'expired_entry_removed', 'existing_tests_pass'],
  async ({ check, importModule, runTests }) => {
    let mod;
    await check('module_loads', async () => {
      mod = await importModule('src/ttl-cache.mjs');
      return typeof mod.createTtlCache === 'function';
    });
    if (!mod) return;
    let clock = 0;
    const make = () => mod.createTtlCache(100, () => clock);
    await check('api_preserved', () => {
      const c = make();
      return typeof c.set === 'function' && typeof c.get === 'function' && typeof c.size === 'function';
    });
    await check('fresh_value_returned', () => {
      clock = 0;
      const c = make();
      c.set('a', 'A');
      clock = 99;
      return c.get('a') === 'A' && c.size() === 1;
    });
    await check('expired_value_hidden', () => {
      clock = 0;
      const c = make();
      c.set('a', 'A');
      clock = 150;
      return c.get('a') === undefined;
    });
    await check('expired_entry_removed', () => {
      clock = 0;
      const c = make();
      c.set('a', 'A');
      c.set('b', 'B');
      clock = 150;
      c.get('a');
      return c.size() === 1 && c.get('b') === undefined && c.size() === 0;
    });
    await check('existing_tests_pass', () => runTests());
  },
);
