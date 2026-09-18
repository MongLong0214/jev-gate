import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { SqlSemanticError, SqlSyntaxError } from '../src/errors.js';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';

const build = () => {
  const db = createDatabase();
  db.createTable('users', [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }, { name: 'city', type: 'text' }]);
  db.insert('users', [
    { id: 1, name: 'ada', city: 'seoul' },
    { id: 2, name: 'bob', city: null },
    { id: 3, name: 'cho', city: 'seoul' },
  ]);
  db.createTable('orders', [{ name: 'id', type: 'int' }, { name: 'user_id', type: 'int' }, { name: 'qty', type: 'int' }, { name: 'price', type: 'float' }]);
  db.insert('orders', [
    { id: 10, user_id: 1, qty: 2, price: 1.5 },
    { id: 11, user_id: 1, qty: null, price: 4 },
    { id: 12, user_id: 3, qty: 3, price: 2.25 },
    { id: 13, user_id: 9, qty: 1, price: 1 },
  ]);
  return db;
};

test('keywords are case insensitive and doubled quotes are one quote', () => {
  assert.deepEqual(tokenize("select 'it''s'"), [{ type: 'keyword', value: 'SELECT', pos: 0 }, { type: 'string', value: "it's", pos: 7 }]);
});

test('multiplication binds tighter than addition and AND tighter than OR', () => {
  const db = build();
  assert.deepEqual(db.query('SELECT 1 + 2 * 3 AS v FROM users LIMIT 1').rows, [[7]]);
  assert.deepEqual(db.query("SELECT name FROM users WHERE city = 'seoul' AND id = 1 OR id = 2").rows, [['ada'], ['bob']]);
});

test('an inner join keeps only matching pairs and reports a hash join', () => {
  const result = build().query('SELECT u.name, o.qty FROM users AS u JOIN orders AS o ON u.id = o.user_id', { explain: true });
  assert.deepEqual(result.rows, [['ada', 2], ['ada', null], ['cho', 3]]);
  assert.equal(result.plan.op, 'hash_join');
  assert.deepEqual(result.plan.on, ['u.id', 'o.user_id']);
});

test('aggregates ignore NULL except COUNT(*) and AVG returns a float', () => {
  const result = build().query('SELECT user_id, COUNT(*) AS n, COUNT(qty) AS q, AVG(price) AS avg_price FROM orders GROUP BY user_id ORDER BY user_id');
  assert.deepEqual(result.rows, [[1, 2, 1, 2.75], [3, 1, 1, 2.25], [9, 1, 1, 1]]);
});

test('syntax and semantic problems raise their own error types', () => {
  assert.throws(() => parse('SELECT id FROM users WHERE id = '), (e) => e instanceof SqlSyntaxError && e.position === 32);
  assert.throws(() => build().query('SELECT id FROM missing'), (e) => e instanceof SqlSemanticError);
  assert.throws(() => build().query('SELECT id, name FROM users GROUP BY id'), (e) => e instanceof SqlSemanticError);
});
