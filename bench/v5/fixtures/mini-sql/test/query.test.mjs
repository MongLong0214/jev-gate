import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { formatTable } from '../src/format.js';

const build = () => {
  const db = createDatabase();
  db.createTable('users', [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }, { name: 'city', type: 'text' }]);
  db.insert('users', [
    { id: 1, name: 'ada', city: 'seoul' },
    { id: 2, name: 'bob', city: null },
    { id: 3, name: 'cho', city: 'busan' },
  ]);
  return db;
};

test('a filtered select returns the matching rows', () => {
  const result = build().query("SELECT name FROM users WHERE city = 'seoul'");
  assert.deepEqual(result.columns, ['name']);
  assert.deepEqual(result.rows, [['ada']]);
});

test('* expands to every column of the table', () => {
  const result = build().query('SELECT * FROM users');
  assert.deepEqual(result.columns, ['id', 'name', 'city']);
  assert.deepEqual(result.rows.length, 3);
});

test('comparing a column with NULL matches nothing', () => {
  assert.deepEqual(build().query('SELECT name FROM users WHERE city = NULL').rows, []);
});

test('ORDER BY sorts and LIMIT cuts the sorted result', () => {
  assert.deepEqual(build().query('SELECT name FROM users ORDER BY name DESC LIMIT 2').rows, [['cho'], ['bob']]);
});

test('formatTable right aligns numbers, prints NULL and counts the rows', () => {
  const expected = ['id  name  city', '--  ----  -----', ' 1  ada   seoul', ' 2  bob   NULL', ' 3  cho   busan', '(3 rows)', ''].join('\n');
  assert.equal(formatTable(build().query('SELECT id, name, city FROM users ORDER BY id')), expected);
});

test('an equality filter on an indexed column is answered by an index scan', () => {
  const db = build();
  db.createIndex('users', 'city');
  const result = db.query("SELECT name FROM users WHERE city = 'busan'", { explain: true });
  assert.deepEqual(result.rows, [['cho']]);
  assert.deepEqual(result.plan, { op: 'index_scan', table: 'users', column: 'city' });
});
