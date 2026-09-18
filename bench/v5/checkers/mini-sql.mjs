import { runChecker } from './_lib.mjs';

// Fixed dataset: three tables, thirty rows, NULLs in every column that allows one.
const USERS = [
  { id: 1, name: 'ada', city: 'seoul', age: 36 },
  { id: 2, name: 'bo', city: 'busan', age: null },
  { id: 3, name: 'cho', city: null, age: 41 },
  { id: 4, name: 'dae', city: 'seoul', age: 29 },
  { id: 5, name: 'eun', city: 'daegu', age: 36 },
  { id: 6, name: 'fay', city: 'seoul', age: null },
  { id: 7, name: 'gil', city: 'busan', age: 52 },
  { id: 8, name: 'hana', city: null, age: 29 },
  { id: 9, name: 'ino', city: 'seoul', age: 23 },
  { id: 10, name: 'jun', city: 'daegu', age: 41 },
];
const PRODUCTS = [
  { id: 1, title: 'mug', category: 'home', price: 8.5 },
  { id: 2, title: 'lamp', category: 'home', price: 23 },
  { id: 3, title: 'pen', category: 'office', price: 1.25 },
  { id: 4, title: 'chair', category: null, price: 99.99 },
  { id: 5, title: 'note', category: 'office', price: 3.5 },
  { id: 6, title: 'cable', category: 'tech', price: 12 },
];
const ORDERS = [
  { id: 100, user_id: 1, product_id: 1, qty: 2 },
  { id: 101, user_id: 1, product_id: 3, qty: null },
  { id: 102, user_id: 2, product_id: 2, qty: 1 },
  { id: 103, user_id: 3, product_id: 1, qty: 5 },
  { id: 104, user_id: 4, product_id: 6, qty: 3 },
  { id: 105, user_id: 4, product_id: 4, qty: 1 },
  { id: 106, user_id: 5, product_id: 3, qty: 10 },
  { id: 107, user_id: null, product_id: 5, qty: 2 },
  { id: 108, user_id: 7, product_id: 5, qty: null },
  { id: 109, user_id: 9, product_id: 1, qty: 4 },
  { id: 110, user_id: 9, product_id: 2, qty: 1 },
  { id: 111, user_id: 11, product_id: 3, qty: 7 },
  { id: 112, user_id: 1, product_id: 6, qty: 2 },
  { id: 113, user_id: 6, product_id: null, qty: 1 },
];

const SCHEMA = {
  users: [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }, { name: 'city', type: 'text' }, { name: 'age', type: 'int' }],
  products: [{ name: 'id', type: 'int' }, { name: 'title', type: 'text' }, { name: 'category', type: 'text' }, { name: 'price', type: 'float' }],
  orders: [{ name: 'id', type: 'int' }, { name: 'user_id', type: 'int' }, { name: 'product_id', type: 'int' }, { name: 'qty', type: 'int' }],
};

const seed = (createDatabase) => {
  const db = createDatabase();
  for (const [table, columns] of Object.entries(SCHEMA)) db.createTable(table, columns);
  db.insert('users', USERS.map((r) => ({ ...r })));
  db.insert('products', PRODUCTS.map((r) => ({ ...r })));
  db.insert('orders', ORDERS.map((r) => ({ ...r })));
  db.createIndex('users', 'city');
  db.createIndex('orders', 'user_id');
  db.createIndex('products', 'category');
  return db;
};

// ---------------------------------------------------------------------------
// Independent brute-force evaluator: plain loops over the raw arrays above, with
// no dependency on the candidate (or on the reference solution). Used for the
// seventeen expectations marked `rows: () => ...` below.
// ---------------------------------------------------------------------------
const NULLS = (a, b, dir) => {
  if (a === null && b === null) return 0;
  if (a === null) return dir === 'DESC' ? -1 : 1;
  if (b === null) return dir === 'DESC' ? 1 : -1;
  if (a === b) return 0;
  const less = a < b ? -1 : 1;
  return dir === 'DESC' ? -less : less;
};
/** Stable multi-key sort with NULLs last ascending and first descending. */
const bfSort = (rows, keys) =>
  rows
    .map((row, position) => ({ row, position }))
    .sort((x, y) => {
      for (const [pick, dir] of keys) {
        const c = NULLS(pick(x.row), pick(y.row), dir ?? 'ASC');
        if (c !== 0) return c;
      }
      return x.position - y.position;
    })
    .map((d) => d.row);
const bfJoin = (left, right, matches) => {
  const out = [];
  for (const l of left) for (const r of right) if (matches(l, r)) out.push([l, r]);
  return out;
};
const bfGroup = (rows, pick) => {
  const groups = new Map();
  for (const row of rows) {
    const key = pick(row) === null ? '#null' : `v:${pick(row)}`;
    if (!groups.has(key)) groups.set(key, { key: pick(row), rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
};
const bfNums = (rows, pick) => rows.map(pick).filter((v) => v !== null);
const bfSum = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0));
const bfAvg = (values) => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length);
const bfMin = (values) => (values.length === 0 ? null : values.reduce((a, b) => (b < a ? b : a)));
const bfMax = (values) => (values.length === 0 ? null : values.reduce((a, b) => (b > a ? b : a)));
const userOrders = () => bfJoin(USERS, ORDERS, (u, o) => o.user_id !== null && o.user_id === u.id);

// ---------------------------------------------------------------------------
// Forty queries. `rows` is either a literal table or an independently computed one.
// ---------------------------------------------------------------------------
const QUERIES = [
  { check: 'select_projection_and_arithmetic', sql: 'SELECT name FROM users ORDER BY id', columns: ['name'], rows: [['ada'], ['bo'], ['cho'], ['dae'], ['eun'], ['fay'], ['gil'], ['hana'], ['ino'], ['jun']] },
  { check: 'select_projection_and_arithmetic', sql: 'SELECT id, name AS who FROM users WHERE id < 4 ORDER BY id', columns: ['id', 'who'], rows: [[1, 'ada'], [2, 'bo'], [3, 'cho']] },
  { check: 'select_projection_and_arithmetic', sql: 'SELECT title, price * 2 AS double_price FROM products ORDER BY id', columns: ['title', 'double_price'], rows: [['mug', 17], ['lamp', 46], ['pen', 2.5], ['chair', 199.98], ['note', 7], ['cable', 24]] },
  { check: 'select_projection_and_arithmetic', sql: 'SELECT qty + 1 AS q1, qty / 2 AS half FROM orders WHERE id = 100', rows: [[3, 1]] },
  { check: 'select_projection_and_arithmetic', sql: 'SELECT 5 / 2 AS a, 5 / 0 AS b, 1 + 2 * 3 AS c, (1 + 2) * 3 AS d, 0 - 3 + 1 AS e FROM users LIMIT 1', rows: [[2.5, null, 7, 9, -2]] },

  { check: 'where_filtering', sql: "SELECT name FROM users WHERE age >= 36 AND city = 'seoul' ORDER BY id", rows: [['ada']] },
  { check: 'where_filtering', sql: "SELECT name FROM users WHERE city = 'seoul' OR city = 'daegu' ORDER BY id", rows: [['ada'], ['dae'], ['eun'], ['fay'], ['ino'], ['jun']] },
  { check: 'where_filtering', sql: "SELECT name FROM users WHERE NOT city = 'seoul' ORDER BY id", rows: [['bo'], ['eun'], ['gil'], ['jun']] },
  { check: 'where_filtering', sql: 'SELECT title FROM products WHERE price < 10 ORDER BY id', rows: [['mug'], ['pen'], ['note']] },
  { check: 'where_filtering', sql: 'SELECT id FROM orders WHERE qty <> 1 ORDER BY id', rows: [[100], [103], [104], [106], [107], [109], [111], [112]] },

  { check: 'null_three_valued', sql: 'SELECT name FROM users WHERE city = NULL', rows: [] },
  { check: 'null_three_valued', sql: 'SELECT name FROM users WHERE city IS NULL ORDER BY id', rows: [['cho'], ['hana']] },
  { check: 'null_three_valued', sql: 'SELECT name FROM users WHERE age IS NOT NULL AND city IS NULL ORDER BY id', rows: [['cho'], ['hana']] },
  { check: 'null_three_valued', sql: 'SELECT name FROM users WHERE NOT age = 36 ORDER BY id', rows: [['cho'], ['dae'], ['gil'], ['hana'], ['ino'], ['jun']] },
  { check: 'null_three_valued', sql: 'SELECT id FROM orders WHERE qty > 1 OR qty IS NULL ORDER BY id', rows: [[100], [101], [103], [104], [106], [107], [108], [109], [111], [112]] },
  { check: 'null_three_valued', sql: "SELECT name FROM users WHERE age = 36 OR city = 'busan' ORDER BY id", rows: [['ada'], ['bo'], ['eun'], ['gil']] },

  { check: 'join_inner_hash', sql: 'SELECT u.name, o.id FROM users AS u JOIN orders AS o ON u.id = o.user_id ORDER BY o.id', columns: ['name', 'id'], rows: () => bfSort(userOrders(), [[([, o]) => o.id]]).map(([u, o]) => [u.name, o.id]) },
  { check: 'join_inner_hash', sql: 'SELECT o.id, p.title FROM orders AS o JOIN products AS p ON o.product_id = p.id ORDER BY o.id', rows: () => bfSort(bfJoin(ORDERS, PRODUCTS, (o, p) => o.product_id !== null && o.product_id === p.id), [[([o]) => o.id]]).map(([o, p]) => [o.id, p.title]) },
  { check: 'join_inner_hash', sql: 'SELECT u.name, p.title FROM users AS u JOIN orders AS o ON u.id = o.user_id JOIN products AS p ON o.product_id = p.id ORDER BY o.id', rows: () => bfSort(bfJoin(userOrders(), PRODUCTS, ([, o], p) => o.product_id !== null && o.product_id === p.id), [[([[, o]]) => o.id]]).map(([[u, o], p]) => [u.name, p.title]) },
  { check: 'join_inner_hash', sql: 'SELECT u.name, o.id FROM orders AS o JOIN users AS u ON o.user_id = u.id ORDER BY u.id, o.id', rows: () => bfSort(userOrders(), [[([u]) => u.id], [([, o]) => o.id]]).map(([u, o]) => [u.name, o.id]) },
  // The hashed side holds three rows under the same key here, so a build that keeps one row per key loses two rows.
  { check: 'join_inner_hash', sql: 'SELECT u.name, o.id FROM orders AS o JOIN users AS u ON o.user_id = u.id WHERE o.user_id = 1 ORDER BY o.id', rows: () => bfSort(userOrders().filter(([, o]) => o.user_id === 1), [[([, o]) => o.id]]).map(([u, o]) => [u.name, o.id]) },
  { check: 'join_inner_hash', sql: "SELECT u.name, o.qty FROM users AS u JOIN orders AS o ON u.id = o.user_id WHERE u.city = 'seoul' ORDER BY o.id", rows: () => bfSort(userOrders().filter(([u]) => u.city === 'seoul'), [[([, o]) => o.id]]).map(([u, o]) => [u.name, o.qty]) },

  { check: 'join_nested_loop', sql: 'SELECT u.name, o.id FROM users AS u JOIN orders AS o ON u.id < o.qty ORDER BY u.id, o.id', rows: () => bfSort(bfJoin(USERS, ORDERS, (u, o) => o.qty !== null && u.id < o.qty), [[([u]) => u.id], [([, o]) => o.id]]).map(([u, o]) => [u.name, o.id]) },
  { check: 'join_nested_loop', sql: 'SELECT u.name, o.id FROM users AS u JOIN orders AS o ON u.id = o.user_id AND o.qty > 2 ORDER BY o.id', rows: () => bfSort(userOrders().filter(([, o]) => o.qty !== null && o.qty > 2), [[([, o]) => o.id]]).map(([u, o]) => [u.name, o.id]) },
  // No ORDER BY: the join must emit its left input's order whichever side was hashed.
  { check: 'join_nested_loop', sql: 'SELECT o.id, u.name FROM orders AS o JOIN users AS u ON o.user_id = u.id', rows: () => bfJoin(ORDERS, USERS, (o, u) => o.user_id !== null && o.user_id === u.id).map(([o, u]) => [o.id, u.name]) },

  { check: 'group_by_aggregates', sql: 'SELECT city, COUNT(*) AS n FROM users GROUP BY city ORDER BY city', columns: ['city', 'n'], rows: () => bfSort(bfGroup(USERS, (u) => u.city), [[(g) => g.key]]).map((g) => [g.key, g.rows.length]) },
  { check: 'group_by_aggregates', sql: 'SELECT city, AVG(age) AS avg_age, MIN(age) AS mn, MAX(age) AS mx FROM users GROUP BY city ORDER BY city', rows: () => bfSort(bfGroup(USERS, (u) => u.city), [[(g) => g.key]]).map((g) => { const ages = bfNums(g.rows, (u) => u.age); return [g.key, bfAvg(ages), bfMin(ages), bfMax(ages)]; }) },
  { check: 'group_by_aggregates', sql: 'SELECT COUNT(*) AS n, COUNT(age) AS with_age FROM users', rows: [[10, 8]] },
  { check: 'group_by_aggregates', sql: 'SELECT SUM(qty) AS total FROM orders WHERE user_id = 99', rows: [[null]] },
  { check: 'group_by_aggregates', sql: 'SELECT COUNT(*) AS n FROM orders WHERE user_id = 99', rows: [[0]] },
  { check: 'group_by_aggregates', sql: 'SELECT category, COUNT(*) AS n, SUM(price) AS total FROM products GROUP BY category ORDER BY n DESC, category', rows: () => bfSort(bfGroup(PRODUCTS, (p) => p.category), [[(g) => g.rows.length, 'DESC'], [(g) => g.key]]).map((g) => [g.key, g.rows.length, bfSum(bfNums(g.rows, (p) => p.price))]) },
  { check: 'group_by_aggregates', sql: 'SELECT u.city, COUNT(*) AS n, SUM(o.qty) AS q FROM users AS u JOIN orders AS o ON u.id = o.user_id GROUP BY u.city ORDER BY n DESC, u.city', rows: () => bfSort(bfGroup(userOrders(), ([u]) => u.city), [[(g) => g.rows.length, 'DESC'], [(g) => g.key]]).map((g) => [g.key, g.rows.length, bfSum(bfNums(g.rows, ([, o]) => o.qty))]) },

  { check: 'order_by_sorting', sql: 'SELECT name, age FROM users ORDER BY age', rows: () => bfSort(USERS, [[(u) => u.age]]).map((u) => [u.name, u.age]) },
  { check: 'order_by_sorting', sql: 'SELECT name, age FROM users ORDER BY age DESC', rows: () => bfSort(USERS, [[(u) => u.age, 'DESC']]).map((u) => [u.name, u.age]) },
  { check: 'order_by_sorting', sql: 'SELECT name, age, city FROM users ORDER BY city ASC, age DESC', rows: () => bfSort(USERS, [[(u) => u.city], [(u) => u.age, 'DESC']]).map((u) => [u.name, u.age, u.city]) },
  { check: 'order_by_sorting', sql: 'SELECT name FROM users ORDER BY name DESC LIMIT 3', rows: [['jun'], ['ino'], ['hana']] },
  { check: 'order_by_sorting', sql: 'SELECT title FROM products ORDER BY price DESC LIMIT 0', rows: [] },

  { check: 'limit_after_order_by', sql: 'SELECT name, age FROM users ORDER BY age LIMIT 3', rows: [['ino', 23], ['dae', 29], ['hana', 29]] },
  { check: 'limit_after_order_by', sql: 'SELECT name FROM users ORDER BY id DESC LIMIT 2', rows: [['jun'], ['ino']] },
  { check: 'limit_after_order_by', sql: 'SELECT id FROM orders ORDER BY qty DESC LIMIT 4', rows: [[101], [108], [106], [111]] },
];

const CHECKS = [
  'modules_load',
  'lexer_tokens',
  'parser_ast_shape',
  'select_projection_and_arithmetic',
  'where_filtering',
  'null_three_valued',
  'join_inner_hash',
  'join_nested_loop',
  'group_by_aggregates',
  'order_by_sorting',
  'limit_after_order_by',
  'order_by_stability',
  'syntax_errors_with_positions',
  'semantic_errors',
  'explain_index_scan',
  'explain_seq_scan_and_join_plan',
  'format_table_exact',
  'case_insensitive_identifiers',
  'test_suite_passes',
];

const show = (v) => JSON.stringify(v);
const sameValue = (a, b) => {
  if (typeof b === 'number' && typeof a === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));
  return a === b;
};
const sameRows = (actual, expected) =>
  Array.isArray(actual) && actual.length === expected.length && actual.every((row, r) => Array.isArray(row) && row.length === expected[r].length && row.every((v, c) => sameValue(v, expected[r][c])));

const report = (failures) => ({ passed: failures.length === 0, reason: failures.length === 0 ? null : `${failures.length} failure(s): ${failures.slice(0, 2).join(' | ')}` });

const runGroup = (db, id) => {
  const failures = [];
  for (const q of QUERIES.filter((x) => x.check === id)) {
    let actual;
    try {
      actual = db.query(q.sql);
    } catch (err) {
      failures.push(`${q.sql} threw ${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`);
      continue;
    }
    const expected = typeof q.rows === 'function' ? q.rows() : q.rows;
    if (!actual || !sameRows(actual.rows, expected)) failures.push(`${q.sql} returned ${show(actual?.rows)}, expected ${show(expected)}`);
    else if (q.columns && show(actual.columns) !== show(q.columns)) failures.push(`${q.sql} named its columns ${show(actual.columns)}, expected ${show(q.columns)}`);
  }
  return report(failures);
};

const deepHas = (actual, expected) => {
  if (expected === null || typeof expected !== 'object') return sameValue(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => deepHas(actual[i], v));
  return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([k, v]) => deepHas(actual[k], v));
};

await runChecker(CHECKS, async ({ check, importModule, runTests }) => {
  let db = null;
  let parse = null;
  let tokenize = null;
  let formatTable = null;
  let errors = null;

  await check('modules_load', async () => {
    const dbModule = await importModule('src/db.js');
    ({ parse } = await importModule('src/parser.js'));
    ({ tokenize } = await importModule('src/lexer.js'));
    ({ formatTable } = await importModule('src/format.js'));
    errors = await importModule('src/errors.js');
    await importModule('src/analyzer.js');
    await importModule('src/executor.js');
    if (typeof dbModule.createDatabase !== 'function') return { passed: false, reason: 'src/db.js does not export createDatabase' };
    if (typeof parse !== 'function' || typeof tokenize !== 'function' || typeof formatTable !== 'function') return { passed: false, reason: 'parse, tokenize or formatTable is missing' };
    if (typeof errors.SqlSyntaxError !== 'function' || typeof errors.SqlSemanticError !== 'function') return { passed: false, reason: 'src/errors.js does not export both error types' };
    db = seed(dbModule.createDatabase);
    return true;
  });
  if (!db) return;

  await check('lexer_tokens', () => {
    const failures = [];
    const tokens = tokenize("select 'it''s', 1.5 FROM x.y <= 3");
    const expected = [
      { type: 'keyword', value: 'SELECT', pos: 0 },
      { type: 'string', value: "it's", pos: 7 },
      { type: 'punct', value: ',', pos: 14 },
      { type: 'number', value: 1.5, pos: 16 },
      { type: 'keyword', value: 'FROM', pos: 20 },
      { type: 'ident', value: 'x', pos: 25 },
      { type: 'punct', value: '.', pos: 26 },
      { type: 'ident', value: 'y', pos: 27 },
      { type: 'op', value: '<=', pos: 29 },
      { type: 'number', value: 3, pos: 32 },
    ];
    if (!deepHas(tokens, expected)) failures.push(`tokens were ${show(tokens)}, expected ${show(expected)}`);
    try {
      tokenize("SELECT 'open");
      failures.push('an unterminated string did not raise SqlSyntaxError');
    } catch (err) {
      if (!(err instanceof errors.SqlSyntaxError) || err.position !== 7) failures.push(`unterminated string raised ${err?.name} at ${show(err?.position)}, expected SqlSyntaxError at 7`);
    }
    try {
      tokenize('SELECT a # b');
      failures.push('an unexpected character did not raise SqlSyntaxError');
    } catch (err) {
      if (!(err instanceof errors.SqlSyntaxError) || err.position !== 9) failures.push(`unexpected character raised ${err?.name} at ${show(err?.position)}, expected SqlSyntaxError at 9`);
    }
    return report(failures);
  });

  await check('parser_ast_shape', () => {
    const failures = [];
    const expect = (sql, shape) => {
      const ast = parse(sql);
      if (!deepHas(ast, shape)) failures.push(`${sql} produced ${show(ast)}, which does not match ${show(shape)}`);
    };
    expect('SELECT u.name AS who, COUNT(*) AS n FROM users AS u JOIN orders AS o ON u.id = o.user_id WHERE u.age IS NOT NULL GROUP BY u.name ORDER BY n DESC LIMIT 5', {
      star: false,
      items: [{ expr: { type: 'column', name: 'name' }, alias: 'who' }, { expr: { type: 'aggregate', fn: 'COUNT', arg: null }, alias: 'n' }],
      from: { table: 'users', alias: 'u' },
      joins: [{ table: 'orders', alias: 'o', on: { type: 'binary', op: '=' } }],
      where: { type: 'isnull', negated: true },
      groupBy: [{ type: 'column', name: 'name' }],
      orderBy: [{ dir: 'DESC' }],
      limit: 5,
    });
    expect('SELECT * FROM users', { star: true, items: [], from: { table: 'users', alias: null }, joins: [], where: null, groupBy: [], orderBy: [], limit: null });
    expect('SELECT 1 + 2 * 3 FROM users', { items: [{ expr: { type: 'binary', op: '+', left: { type: 'literal', value: 1 }, right: { type: 'binary', op: '*' } } }] });
    expect('SELECT id FROM users WHERE NOT age = 1 AND id = 2 OR id = 3', { where: { type: 'binary', op: 'OR', left: { type: 'binary', op: 'AND', left: { type: 'unary', op: 'NOT', expr: { type: 'binary', op: '=' } } } } });
    expect('SELECT 0 - age FROM users', { items: [{ expr: { type: 'binary', op: '-', right: { type: 'column', name: 'age' } } }] });
    expect('SELECT id FROM users ORDER BY age ASC, id', { orderBy: [{ dir: 'ASC' }, { dir: 'ASC' }] });
    return report(failures);
  });

  for (const id of ['select_projection_and_arithmetic', 'where_filtering', 'null_three_valued', 'join_inner_hash', 'join_nested_loop', 'group_by_aggregates', 'order_by_sorting', 'limit_after_order_by']) {
    await check(id, () => runGroup(db, id));
  }

  await check('order_by_stability', () => {
    const failures = [];
    // Ties must keep the insertion order of the rows, ascending and descending alike.
    const ties = [
      ['SELECT name, age FROM users ORDER BY age', [['ino', 23], ['dae', 29], ['hana', 29], ['ada', 36], ['eun', 36], ['cho', 41], ['jun', 41], ['gil', 52], ['bo', null], ['fay', null]]],
      ['SELECT name, age FROM users ORDER BY age DESC', [['bo', null], ['fay', null], ['gil', 52], ['cho', 41], ['jun', 41], ['ada', 36], ['eun', 36], ['dae', 29], ['hana', 29], ['ino', 23]]],
      ['SELECT name, city FROM users ORDER BY city', [['bo', 'busan'], ['gil', 'busan'], ['eun', 'daegu'], ['jun', 'daegu'], ['ada', 'seoul'], ['dae', 'seoul'], ['fay', 'seoul'], ['ino', 'seoul'], ['cho', null], ['hana', null]]],
      ['SELECT id, qty FROM orders ORDER BY qty', [[102, 1], [105, 1], [110, 1], [113, 1], [100, 2], [107, 2], [112, 2], [104, 3], [109, 4], [103, 5], [111, 7], [106, 10], [101, null], [108, null]]],
    ];
    for (const [sql, expected] of ties) {
      const actual = db.query(sql);
      if (!sameRows(actual.rows, expected)) failures.push(`${sql} returned ${show(actual.rows)}, expected ${show(expected)}`);
    }
    return report(failures);
  });

  await check('syntax_errors_with_positions', () => {
    const failures = [];
    const cases = [
      ['SELECT FROM users', 7],
      ["SELECT name FROM users WHERE city = 'seoul", 36],
      ['SELECT name FROM users WHERE id # 3', 32],
      ['SELECT id FROM users LIMIT x', 27],
      ['SELECT a = b = c FROM users', 13],
      ['SELECT id FROM', 14],
    ];
    for (const [sql, position] of cases) {
      try {
        parse(sql);
        failures.push(`${sql} parsed without an error, expected SqlSyntaxError at ${position}`);
      } catch (err) {
        if (!(err instanceof errors.SqlSyntaxError) || err.name !== 'SqlSyntaxError') failures.push(`${sql} raised ${err?.name ?? String(err)}, expected SqlSyntaxError`);
        else if (err.position !== position) failures.push(`${sql} reported position ${show(err.position)}, expected ${position}`);
      }
    }
    return report(failures);
  });

  await check('semantic_errors', () => {
    const failures = [];
    const cases = [
      'SELECT id FROM nope',
      'SELECT nope FROM users',
      'SELECT id FROM users AS u JOIN orders AS o ON u.id = o.user_id',
      'SELECT name, COUNT(*) AS n FROM users',
      'SELECT name FROM users WHERE COUNT(*) > 1',
      'SELECT city, COUNT(*) AS n FROM users GROUP BY city ORDER BY nope',
      'SELECT city, name FROM users GROUP BY city',
      'SELECT * FROM users GROUP BY city',
    ];
    for (const sql of cases) {
      try {
        db.query(sql);
        failures.push(`${sql} ran without an error, expected SqlSemanticError`);
      } catch (err) {
        if (!(err instanceof errors.SqlSemanticError) || err.name !== 'SqlSemanticError') failures.push(`${sql} raised ${err?.name ?? String(err)}, expected SqlSemanticError`);
      }
    }
    // The same bare name is legal when it resolves to a select alias.
    const aliased = db.query('SELECT city, COUNT(*) AS n FROM users GROUP BY city ORDER BY n DESC, city LIMIT 1');
    if (!sameRows(aliased.rows, [['seoul', 4]])) failures.push(`ORDER BY on a select alias returned ${show(aliased.rows)}, expected [["seoul",4]]`);
    return report(failures);
  });

  await check('explain_index_scan', () => {
    const failures = [];
    const cases = [
      ["SELECT name FROM users WHERE city = 'seoul'", { op: 'index_scan', table: 'users', column: 'city' }, [['ada'], ['dae'], ['fay'], ['ino']]],
      ['SELECT id FROM orders WHERE user_id = 1', { op: 'index_scan', table: 'orders', column: 'user_id' }, [[100], [101], [112]]],
      ["SELECT title FROM products WHERE category = 'office' ORDER BY id", { op: 'index_scan', table: 'products', column: 'category' }, [['pen'], ['note']]],
      ["SELECT name FROM users WHERE name = 'ada'", { op: 'seq_scan', table: 'users' }, [['ada']]],
      ["SELECT name FROM users WHERE city <> 'seoul' ORDER BY id", { op: 'seq_scan', table: 'users' }, [['bo'], ['eun'], ['gil'], ['jun']]],
    ];
    for (const [sql, plan, rows] of cases) {
      const actual = db.query(sql, { explain: true });
      if (show(actual.plan) !== show(plan)) failures.push(`${sql} planned ${show(actual.plan)}, expected ${show(plan)}`);
      if (!sameRows(actual.rows, rows)) failures.push(`${sql} returned ${show(actual.rows)}, expected ${show(rows)}`);
      const withoutExplain = db.query(sql);
      if (withoutExplain.plan !== undefined) failures.push(`${sql} returned a plan without explain`);
    }
    return report(failures);
  });

  await check('explain_seq_scan_and_join_plan', () => {
    const failures = [];
    const users = { op: 'seq_scan', table: 'users' };
    const orders = { op: 'seq_scan', table: 'orders' };
    const cases = [
      ['SELECT id FROM users', users],
      ['SELECT u.name, o.id FROM users AS u JOIN orders AS o ON u.id = o.user_id', { op: 'hash_join', left: users, right: orders, on: ['u.id', 'o.user_id'] }],
      ['SELECT u.name, o.id FROM orders AS o JOIN users AS u ON o.user_id = u.id', { op: 'hash_join', left: orders, right: users, on: ['o.user_id', 'u.id'] }],
      ["SELECT u.name, o.id FROM users AS u JOIN orders AS o ON u.id = o.user_id WHERE u.city = 'busan'", { op: 'hash_join', left: { op: 'index_scan', table: 'users', column: 'city' }, right: orders, on: ['u.id', 'o.user_id'] }],
      ['SELECT u.name, o.id FROM users AS u JOIN orders AS o ON u.id < o.qty', { op: 'nested_loop_join', left: users, right: orders }],
      ['SELECT u.name, p.title FROM users AS u JOIN orders AS o ON u.id = o.user_id JOIN products AS p ON o.product_id = p.id', { op: 'hash_join', left: { op: 'hash_join', left: users, right: orders, on: ['u.id', 'o.user_id'] }, right: { op: 'seq_scan', table: 'products' }, on: ['o.product_id', 'p.id'] }],
    ];
    for (const [sql, plan] of cases) {
      const actual = db.query(sql, { explain: true }).plan;
      if (!deepHas(actual, plan)) failures.push(`${sql} planned ${show(actual)}, expected ${show(plan)}`);
    }
    return report(failures);
  });

  await check('format_table_exact', () => {
    const failures = [];
    const cases = [
      ['SELECT id, name, city, age FROM users ORDER BY id LIMIT 4', 'id  name  city    age\n--  ----  -----  ----\n 1  ada   seoul    36\n 2  bo    busan  NULL\n 3  cho   NULL     41\n 4  dae   seoul    29\n(4 rows)\n'],
      ['SELECT title, price FROM products ORDER BY price DESC LIMIT 3', 'title  price\n-----  -----\nchair  99.99\nlamp      23\ncable     12\n(3 rows)\n'],
      ['SELECT city, COUNT(*) AS n, AVG(age) AS avg_age FROM users GROUP BY city ORDER BY city', 'city   n  avg_age\n-----  -  -------\nbusan  2       52\ndaegu  2     38.5\nseoul  4  29.3333\nNULL   2       35\n(4 rows)\n'],
    ];
    for (const [sql, expected] of cases) {
      const actual = formatTable(db.query(sql));
      if (actual !== expected) failures.push(`${sql} formatted as ${show(actual)}, expected ${show(expected)}`);
    }
    return report(failures);
  });

  await check('case_insensitive_identifiers', () => {
    const failures = [];
    const cases = [
      ["select NAME from USERS where CITY = 'seoul' order by ID limit 2", [['ada'], ['dae']]],
      ['SELECT U.Name FROM Users AS U JOIN Orders AS O ON U.ID = O.User_Id ORDER BY O.ID LIMIT 3', [['ada'], ['ada'], ['bo']]],
      ["SELECT name FROM users WHERE city = 'SEOUL'", []],
    ];
    for (const [sql, expected] of cases) {
      const actual = db.query(sql);
      if (!sameRows(actual.rows, expected)) failures.push(`${sql} returned ${show(actual.rows)}, expected ${show(expected)}`);
    }
    return report(failures);
  });

  await check('test_suite_passes', () => {
    const result = runTests();
    // Accepts both the bare boolean and the {passed, reason} shape so the check reports why a suite did not pass.
    if (typeof result === 'boolean') return { passed: result, reason: result ? null : 'node --test did not pass' };
    return { passed: Boolean(result?.passed), reason: result?.reason ?? null };
  });
});
