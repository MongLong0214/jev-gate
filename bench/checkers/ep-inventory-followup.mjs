import { runChecker } from './_lib.mjs';
import { throwsExactly } from './_episode.mjs';

await runChecker(
  ['module_loads', 'same_location_rejected', 'transfer_still_moves', 'insufficient_still_changes_nothing', 'test_suite_passes'],
  async ({ check, importModule, runTests }) => {
    let inv;
    let tr;
    await check('module_loads', async () => {
      inv = await importModule('src/inventory.mjs');
      tr = await importModule('src/transfer.mjs');
      return typeof inv.createInventory === 'function' && typeof tr.transfer === 'function';
    });
    if (!inv || !tr) return;
    await check('same_location_rejected', () => {
      const a = inv.createInventory();
      a.addItem('A-1', 3);
      return throwsExactly(() => tr.transfer(a, a, 'A-1', 1), RangeError, 'inventory: same location') && a.getQty('A-1') === 3;
    });
    await check('transfer_still_moves', () => {
      const a = inv.createInventory();
      const b = inv.createInventory();
      a.addItem('A-1', 5);
      tr.transfer(a, b, 'A-1', 5);
      return a.list().length === 0 && b.getQty('A-1') === 5;
    });
    await check('insufficient_still_changes_nothing', () => {
      const a = inv.createInventory();
      const b = inv.createInventory();
      a.addItem('A-1', 1);
      return throwsExactly(() => tr.transfer(a, b, 'A-1', 2), RangeError, 'inventory: insufficient stock') && a.getQty('A-1') === 1 && b.list().length === 0;
    });
    await check('test_suite_passes', () => runTests());
  },
);
