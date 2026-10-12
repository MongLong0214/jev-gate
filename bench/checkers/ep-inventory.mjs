import { runChecker } from './_lib.mjs';
import { testMentions, throwsExactly } from './_episode.mjs';

await runChecker(
  ['module_loads', 'transfer_moves', 'transfer_drops_empty', 'insufficient_changes_nothing', 'unknown_sku_changes_nothing', 'invalid_qty_changes_nothing', 'transfer_test_added', 'test_suite_passes'],
  async ({ evalDir, check, importModule, runTests }) => {
    let inv;
    let tr;
    await check('module_loads', async () => {
      inv = await importModule('src/inventory.mjs');
      tr = await importModule('src/transfer.mjs');
      return typeof inv.createInventory === 'function' && typeof tr.transfer === 'function';
    });
    if (!inv || !tr) return;
    const pair = (qa, qb = 0) => {
      const a = inv.createInventory();
      const b = inv.createInventory();
      if (qa) a.addItem('A-1', qa);
      if (qb) b.addItem('A-1', qb);
      return [a, b];
    };
    const same = (x, y) => JSON.stringify(x.list()) === JSON.stringify(y);
    await check('transfer_moves', () => {
      const [a, b] = pair(5, 2);
      tr.transfer(a, b, 'A-1', 3);
      return a.getQty('A-1') === 2 && b.getQty('A-1') === 5;
    });
    await check('transfer_drops_empty', () => {
      const [a, b] = pair(3);
      tr.transfer(a, b, 'A-1', 3);
      return a.list().length === 0 && b.getQty('A-1') === 3;
    });
    await check('insufficient_changes_nothing', () => {
      const [a, b] = pair(3, 1);
      return throwsExactly(() => tr.transfer(a, b, 'A-1', 4), RangeError, 'inventory: insufficient stock') && same(a, [{ sku: 'A-1', qty: 3 }]) && same(b, [{ sku: 'A-1', qty: 1 }]);
    });
    await check('unknown_sku_changes_nothing', () => {
      const [a, b] = pair(3);
      return throwsExactly(() => tr.transfer(a, b, 'B-2', 1), RangeError, 'inventory: insufficient stock') && same(a, [{ sku: 'A-1', qty: 3 }]) && same(b, []);
    });
    await check('invalid_qty_changes_nothing', () => {
      const [a, b] = pair(3);
      return [0, -1, 1.5].every((q) => throwsExactly(() => tr.transfer(a, b, 'A-1', q), RangeError, 'inventory: invalid qty')) && same(a, [{ sku: 'A-1', qty: 3 }]) && same(b, []);
    });
    await check('transfer_test_added', () => testMentions(evalDir, /transfer/));
    await check('test_suite_passes', () => runTests());
  },
);
