import { runChecker, sameKeys } from './_lib.mjs';

await runChecker(
  ['module_loads', 'admin_ignores_coupon', 'customer_applies_coupon', 'unknown_role_throws', 'return_shape_preserved', 'existing_tests_pass'],
  async ({ check, importModule, runTests }) => {
    let mod;
    await check('module_loads', async () => {
      mod = await importModule('src/quote.mjs');
      return typeof mod.quote === 'function';
    });
    if (!mod) return;
    await check('admin_ignores_coupon', () => mod.quote({ role: 'admin', price: 15000, coupon: 2000 }).amount === 15000);
    await check('customer_applies_coupon', () => mod.quote({ role: 'customer', price: 15000, coupon: 2000 }).amount === 13000);
    await check('unknown_role_throws', () => {
      try {
        mod.quote({ role: 'guest', price: 100, coupon: 0 });
        return false;
      } catch {
        return true;
      }
    });
    await check('return_shape_preserved', () => {
      const r = mod.quote({ role: 'customer', price: 500, coupon: 100 });
      return sameKeys(r, ['role', 'amount']) && r.role === 'customer';
    });
    await check('existing_tests_pass', () => runTests());
  },
);
