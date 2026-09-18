import { SqlSemanticError } from './errors.js';

const lower = (s) => String(s).toLowerCase();

const children = (expr) => {
  if (!expr) return [];
  if (expr.type === 'binary') return [expr.left, expr.right];
  if (expr.type === 'unary' || expr.type === 'isnull') return [expr.expr];
  if (expr.type === 'aggregate') return expr.arg ? [expr.arg] : [];
  return [];
};

const walk = (expr, visit) => {
  if (!expr) return;
  visit(expr);
  for (const child of children(expr)) walk(child, visit);
};

const hasAggregate = (expr) => {
  let found = false;
  walk(expr, (e) => { if (e.type === 'aggregate') found = true; });
  return found;
};

/** Validates an AST against `{ table: [{ name, type }] }` and returns the resolution every stage shares. */
export const analyze = (ast, schema) => {
  const sources = [ast.from, ...ast.joins].map((ref) => {
    const table = lower(ref.table);
    const columns = schema[table];
    if (!columns) throw new SqlSemanticError(`unknown table ${ref.table}`);
    return { table, name: lower(ref.alias ?? ref.table), columns: columns.map((c) => ({ name: lower(c.name), type: c.type })) };
  });
  const names = sources.map((s) => s.name);
  const duplicate = names.find((n, idx) => names.indexOf(n) !== idx);
  if (duplicate) throw new SqlSemanticError(`duplicate table name ${duplicate}; use AS to give each source a distinct name`);

  const resolve = (col) => {
    const name = lower(col.name);
    if (col.table) {
      const index = sources.findIndex((s) => s.name === lower(col.table));
      if (index < 0) throw new SqlSemanticError(`unknown table ${col.table}`);
      if (!sources[index].columns.some((c) => c.name === name)) throw new SqlSemanticError(`unknown column ${col.table}.${col.name}`);
      return { index, column: name };
    }
    const matches = sources.map((s, index) => ({ s, index })).filter(({ s }) => s.columns.some((c) => c.name === name));
    if (matches.length === 0) throw new SqlSemanticError(`unknown column ${col.name}`);
    if (matches.length > 1) throw new SqlSemanticError(`ambiguous column ${col.name}; qualify it with a table name`);
    return { index: matches[0].index, column: name };
  };

  const validate = (expr, where) => walk(expr, (e) => {
    if (e.type === 'column') resolve(e);
    if (e.type === 'aggregate') {
      if (where === 'WHERE' || where === 'ON') throw new SqlSemanticError(`aggregate ${e.fn} is not allowed in ${where}`);
      if (e.arg && hasAggregate(e.arg)) throw new SqlSemanticError(`aggregate ${e.fn} may not contain another aggregate`);
    }
  });

  for (const join of ast.joins) validate(join.on, 'ON');
  validate(ast.where, 'WHERE');
  for (const item of ast.items) validate(item.expr, 'SELECT');
  for (const col of ast.groupBy) validate(col, 'GROUP BY');

  // ORDER BY resolves a bare name against the select aliases first, then against the columns in scope.
  const orderBy = ast.orderBy.map((o) => {
    if (o.expr.type === 'column' && !o.expr.table) {
      const item = ast.items.find((it) => it.alias && lower(it.alias) === lower(o.expr.name));
      if (item) return { expr: item.expr, dir: o.dir };
    }
    validate(o.expr, 'ORDER BY');
    return { expr: o.expr, dir: o.dir };
  });

  const grouped = ast.groupBy.length > 0 || ast.items.some((it) => hasAggregate(it.expr)) || orderBy.some((o) => hasAggregate(o.expr));
  const groupBy = ast.groupBy.map(resolve);
  const groupKeys = new Set(groupBy.map((g) => `${g.index}.${g.column}`));
  if (grouped) {
    if (ast.star) throw new SqlSemanticError('SELECT * is not allowed with GROUP BY or aggregates');
    const requireGrouped = (expr, where) => {
      if (!expr || expr.type === 'aggregate') return;
      if (expr.type === 'column') {
        const { index, column } = resolve(expr);
        if (!groupKeys.has(`${index}.${column}`)) throw new SqlSemanticError(`column ${sources[index].name}.${column} in ${where} must appear in GROUP BY or be used in an aggregate`);
        return;
      }
      for (const child of children(expr)) requireGrouped(child, where);
    };
    for (const item of ast.items) requireGrouped(item.expr, 'SELECT');
    for (const o of orderBy) requireGrouped(o.expr, 'ORDER BY');
  }

  const aggregates = [];
  const collect = (expr) => walk(expr, (e) => { if (e.type === 'aggregate' && !aggregates.includes(e)) aggregates.push(e); });
  for (const item of ast.items) collect(item.expr);
  for (const o of orderBy) collect(o.expr);

  return { sources, resolve, orderBy, grouped, groupBy, groupKeys, aggregates };
};
