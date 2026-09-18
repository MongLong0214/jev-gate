import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecker, sameKeys } from './_lib.mjs';
const BROKEN_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'cart-total', 'src');
await runChecker(
  ['module_loads', 'api_shape_preserved', 'fixed_coupon_floors_at_zero', 'integer_won_totals', 'invalid_quantity_rejected', 'existing_behavior_kept', 'regression_tests_detect_bugs', 'test_suite_passes'],
  async ({ check, importModule, runTests, runTestsAgainst }) => {
    let mod;
    await check('module_loads', async () => { mod = await importModule('src/cart.mjs'); return typeof mod.cartTotal === 'function'; });
    if (!mod) return;
    await check('api_shape_preserved', () => sameKeys(mod.cartTotal([{ price: 10, quantity: 1 }]), ['subtotal', 'discount', 'total']) && sameKeys(mod, ['cartTotal']));
    await check('fixed_coupon_floors_at_zero', () => { const r = mod.cartTotal([{ price: 300, quantity: 1 }], { coupon: { type: 'fixed', value: 500 } }); return r.total === 0 && r.discount === 300; });
    await check('integer_won_totals', () => { const a = mod.cartTotal([{ price: 333, quantity: 1 }], { taxRate: 0.1 }); const b = mod.cartTotal([{ price: 999, quantity: 1 }], { coupon: { type: 'percent', value: 33 } }); return Number.isInteger(a.total) && a.total === 366 && Number.isInteger(b.discount) && Number.isInteger(b.total); });
    await check('invalid_quantity_rejected', () => { let ok = true; try { mod.cartTotal([{ price: 100, quantity: 1.5 }]); ok = false; } catch (e) { ok = e instanceof RangeError; } try { mod.cartTotal([{ price: 100, quantity: -1 }]); return false; } catch (e) { return ok && e instanceof RangeError; } });
    await check('existing_behavior_kept', () => { const r = mod.cartTotal([{ price: 1000, quantity: 2 }, { price: 500, quantity: 1 }], { coupon: { type: 'percent', value: 10 } }); return r.subtotal === 2500 && r.discount === 250 && r.total === 2250; });
    await check('regression_tests_detect_bugs', () => runTestsAgainst(BROKEN_SRC) === false);
    await check('test_suite_passes', () => runTests());
  },
);
