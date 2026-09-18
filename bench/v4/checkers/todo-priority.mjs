import { runChecker } from './_lib.mjs';
await runChecker(
  ['modules_load', 'add_default_normal', 'add_with_priority_and_setPriority', 'invalid_priority_rejected', 'v1_data_migrates_to_normal', 'v2_round_trip_keeps_priority', 'view_orders_high_first_stable', 'view_marks_non_normal_only', 'existing_tests_pass'],
  async ({ check, importModule, runTests }) => {
    let model, ser, view;
    await check('modules_load', async () => { model = await importModule('src/model.mjs'); ser = await importModule('src/serialize.mjs'); view = await importModule('src/view.mjs'); return typeof model.createTodoList === 'function' && typeof ser.serialize === 'function' && typeof ser.deserialize === 'function' && typeof view.renderList === 'function'; });
    if (!model || !ser || !view) return;
    await check('add_default_normal', () => { const l = model.createTodoList(); const it = l.add('a'); return it.priority === 'normal' && l.list()[0].priority === 'normal'; });
    await check('add_with_priority_and_setPriority', () => { const l = model.createTodoList(); const it = l.add('a', 'high'); const b = l.add('b'); l.setPriority(b.id, 'low'); const items = l.list(); return it.priority === 'high' && items[1].priority === 'low'; });
    await check('invalid_priority_rejected', () => { const l = model.createTodoList(); try { l.add('x', 'urgent'); return false; } catch { } const it = l.add('y'); try { l.setPriority(it.id, 'meh'); return false; } catch { return true; } });
    await check('v1_data_migrates_to_normal', () => { const l = ser.deserialize(JSON.stringify({ version: 1, items: [{ id: 1, title: 'old', done: true }] })); const items = l.list(); return items.length === 1 && items[0].priority === 'normal' && items[0].done === true && items[0].title === 'old'; });
    await check('v2_round_trip_keeps_priority', () => { const l = model.createTodoList(); l.add('h', 'high'); l.add('n'); l.add('lo', 'low'); const copy = ser.deserialize(ser.serialize(l)); const p = copy.list().map((x) => x.priority); return JSON.stringify(p) === JSON.stringify(['high', 'normal', 'low']) && JSON.parse(ser.serialize(l)).version !== 1; });
    await check('view_orders_high_first_stable', () => { const l = model.createTodoList(); l.add('n1'); l.add('h1', 'high'); l.add('n2'); l.add('l1', 'low'); l.add('h2', 'high'); const lines = view.renderList(l).split('\n').map((s) => s.replace(/^\[.\] (\(\w+\) )?/, '')); return JSON.stringify(lines) === JSON.stringify(['h1', 'h2', 'n1', 'n2', 'l1']); });
    await check('view_marks_non_normal_only', () => { const l = model.createTodoList(); l.add('n'); l.add('h', 'high'); l.toggle(1); const out = view.renderList(l); return out.includes('[x] n') && !out.includes('(normal)') && out.includes('(high) h'); });
    await check('existing_tests_pass', () => runTests());
  },
);
