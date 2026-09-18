import { SqlSyntaxError } from './errors.js';
import { tokenize } from './lexer.js';

const AGGREGATES = new Set(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const COMPARISONS = new Set(['=', '<>', '<', '<=', '>', '>=']);

export const parse = (sql) => {
  const tokens = tokenize(sql);
  const end = typeof sql === 'string' ? sql.length : 0;
  let i = 0;

  const peek = () => tokens[i] ?? null;
  const posOf = (t) => (t ? t.pos : end);
  const fail = (message, t = peek()) => { throw new SqlSyntaxError(message, posOf(t)); };
  const at = (type, value) => { const t = peek(); return Boolean(t) && t.type === type && (value === undefined || t.value === value); };
  const eat = (type, value) => { if (!at(type, value)) return null; const t = tokens[i]; i += 1; return t; };
  const expect = (type, value, what) => eat(type, value) ?? fail(`expected ${what}`);

  const identifier = (what) => expect('ident', undefined, what).value;

  const primary = () => {
    const t = peek();
    if (!t) fail('expected an expression');
    if (t.type === 'number' || t.type === 'string') { i += 1; return { type: 'literal', value: t.value }; }
    if (t.type === 'keyword' && t.value === 'NULL') { i += 1; return { type: 'literal', value: null }; }
    if (t.type === 'punct' && t.value === '(') {
      i += 1;
      const inner = expression();
      expect('punct', ')', 'a closing parenthesis');
      return inner;
    }
    if (t.type === 'ident') {
      const upper = t.value.toUpperCase();
      if (tokens[i + 1]?.type === 'punct' && tokens[i + 1].value === '(') {
        if (!AGGREGATES.has(upper)) fail(`unknown function ${t.value}`, t);
        i += 2;
        if (eat('op', '*')) {
          if (upper !== 'COUNT') fail(`${upper}(*) is not allowed`, t);
          expect('punct', ')', 'a closing parenthesis');
          return { type: 'aggregate', fn: 'COUNT', arg: null };
        }
        const arg = expression();
        expect('punct', ')', 'a closing parenthesis');
        return { type: 'aggregate', fn: upper, arg };
      }
      i += 1;
      if (eat('punct', '.')) return { type: 'column', table: t.value, name: identifier('a column name after "."') };
      return { type: 'column', table: null, name: t.value };
    }
    return fail('expected an expression', t);
  };

  const unary = () => (eat('op', '-') ? { type: 'unary', op: '-', expr: unary() } : primary());

  const multiplicative = () => {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t?.type === 'op' && (t.value === '*' || t.value === '/')) { i += 1; left = { type: 'binary', op: t.value, left, right: unary() }; continue; }
      return left;
    }
  };

  const additive = () => {
    let left = multiplicative();
    for (;;) {
      const t = peek();
      if (t?.type === 'op' && (t.value === '+' || t.value === '-')) { i += 1; left = { type: 'binary', op: t.value, left, right: multiplicative() }; continue; }
      return left;
    }
  };

  // Non-associative: one comparison (or one IS [NOT] NULL) per operand pair, so `a = b = c` is a syntax error.
  const comparison = () => {
    const left = additive();
    if (eat('keyword', 'IS')) {
      const negated = Boolean(eat('keyword', 'NOT'));
      expect('keyword', 'NULL', 'NULL after IS');
      return { type: 'isnull', expr: left, negated };
    }
    const t = peek();
    if (t?.type === 'op' && COMPARISONS.has(t.value)) { i += 1; return { type: 'binary', op: t.value, left, right: additive() }; }
    return left;
  };

  const notExpr = () => (eat('keyword', 'NOT') ? { type: 'unary', op: 'NOT', expr: notExpr() } : comparison());

  const andExpr = () => {
    let left = notExpr();
    while (eat('keyword', 'AND')) left = { type: 'binary', op: 'AND', left, right: notExpr() };
    return left;
  };

  const expression = () => {
    let left = andExpr();
    while (eat('keyword', 'OR')) left = { type: 'binary', op: 'OR', left, right: andExpr() };
    return left;
  };

  const tableRef = () => {
    const table = identifier('a table name');
    return { table, alias: eat('keyword', 'AS') ? identifier('an alias after AS') : null };
  };

  expect('keyword', 'SELECT', 'SELECT');
  const ast = { type: 'select', star: false, items: [], from: null, joins: [], where: null, groupBy: [], orderBy: [], limit: null };
  if (eat('op', '*')) {
    ast.star = true;
  } else {
    do {
      const expr = expression();
      ast.items.push({ expr, alias: eat('keyword', 'AS') ? identifier('an alias after AS') : null });
    } while (eat('punct', ','));
  }
  expect('keyword', 'FROM', 'FROM');
  ast.from = tableRef();
  while (eat('keyword', 'JOIN')) {
    const ref = tableRef();
    expect('keyword', 'ON', 'ON after a joined table');
    ast.joins.push({ ...ref, on: expression() });
  }
  if (eat('keyword', 'WHERE')) ast.where = expression();
  if (eat('keyword', 'GROUP')) {
    expect('keyword', 'BY', 'BY after GROUP');
    do {
      const expr = primary();
      if (expr.type !== 'column') fail('GROUP BY accepts column names only');
      ast.groupBy.push(expr);
    } while (eat('punct', ','));
  }
  if (eat('keyword', 'ORDER')) {
    expect('keyword', 'BY', 'BY after ORDER');
    do {
      const expr = expression();
      const dir = eat('keyword', 'DESC') ? 'DESC' : (eat('keyword', 'ASC'), 'ASC');
      ast.orderBy.push({ expr, dir });
    } while (eat('punct', ','));
  }
  if (eat('keyword', 'LIMIT')) {
    const t = peek();
    if (!t || t.type !== 'number' || !Number.isInteger(t.value) || t.value < 0) fail('LIMIT expects a non-negative integer literal', t);
    i += 1;
    ast.limit = t.value;
  }
  if (i < tokens.length) fail(`unexpected token ${JSON.stringify(String(tokens[i].value))}`);
  return ast;
};
