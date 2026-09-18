import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTodoList } from '../src/model.mjs';
import { deserialize, serialize } from '../src/serialize.mjs';
import { renderList } from '../src/view.mjs';

test('round-trips items through the v1 format and renders them', () => {
  const list = createTodoList();
  list.add('write tests');
  list.toggle(list.add('ship').id);
  const copy = deserialize(serialize(list));
  assert.deepEqual(copy.list().map((x) => [x.title, x.done]), [['write tests', false], ['ship', true]]);
  assert.equal(renderList(copy), '[ ] write tests\n[x] ship');
});
