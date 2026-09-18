import { analyze } from './analyzer.js';

const NULL_KEY = '#null';
const keyOf = (v) => (v === null ? NULL_KEY : `${typeof v}:${String(v)}`);

/** -1/0/1 for two comparable values, null when the comparison is not defined (mixed or non-scalar types). */
const compareValues = (a, b) => {
  if (typeof a !== typeof b) return null;
  if (typeof a === 'number' || typeof a === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return null;
};

const flattenAnd = (expr) => (expr && expr.type === 'binary' && expr.op === 'AND' ? [...flattenAnd(expr.left), ...flattenAnd(expr.right)] : expr ? [expr] : []);

const arithmetic = (op, a, b) => {
  if (a === null || b === null || typeof a !== 'number' || typeof b !== 'number') return null;
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  if (op === '*') return a * b;
  return b === 0 ? null : a / b;
};

const booleanOf = (v) => (v === true || v === false ? v : null);

const cellOf = (row, index, column) => {
  const source = row[index];
  const value = source ? source[column] : undefined;
  return value === undefined ? null : value;
};

const evaluate = (expr, ctx) => {
  switch (expr.type) {
    case 'literal':
      return expr.value;
    case 'column': {
      const { index, column } = ctx.resolve(expr);
      return cellOf(ctx.row, index, column);
    }
    case 'aggregate':
      return ctx.aggregates ? ctx.aggregates.get(expr) ?? null : null;
    case 'isnull': {
      const v = evaluate(expr.expr, ctx);
      return expr.negated ? v !== null : v === null;
    }
    case 'unary': {
      const v = evaluate(expr.expr, ctx);
      if (expr.op === 'NOT') {
        const b = booleanOf(v);
        return b === null ? null : !b;
      }
      return v === null || typeof v !== 'number' ? null : -v;
    }
    case 'binary': {
      if (expr.op === 'AND' || expr.op === 'OR') {
        const a = booleanOf(evaluate(expr.left, ctx));
        const b = booleanOf(evaluate(expr.right, ctx));
        if (expr.op === 'AND') return a === false || b === false ? false : a === null || b === null ? null : true;
        return a === true || b === true ? true : a === null || b === null ? null : false;
      }
      const a = evaluate(expr.left, ctx);
      const b = evaluate(expr.right, ctx);
      if (expr.op === '+' || expr.op === '-' || expr.op === '*' || expr.op === '/') return arithmetic(expr.op, a, b);
      if (a === null || b === null) return null;
      const c = compareValues(a, b);
      if (c === null) return null;
      if (expr.op === '=') return c === 0;
      if (expr.op === '<>') return c !== 0;
      if (expr.op === '<') return c < 0;
      if (expr.op === '<=') return c <= 0;
      if (expr.op === '>') return c > 0;
      return c >= 0;
    }
    default:
      return null;
  }
};

const columnLabel = (expr) => (expr.type === 'column' ? (expr.table ? `${expr.table}.${expr.name}` : expr.name).toLowerCase() : 'expr');

const itemName = (item, position) => {
  if (item.alias) return item.alias;
  if (item.expr.type === 'column') return item.expr.name.toLowerCase();
  if (item.expr.type === 'aggregate') return `${item.expr.fn.toLowerCase()}(${item.expr.arg ? columnLabel(item.expr.arg) : '*'})`;
  return `expr${position + 1}`;
};

const aggregateValue = (agg, rows, resolve) => {
  if (agg.fn === 'COUNT' && !agg.arg) return rows.length;
  const values = rows.map((row) => evaluate(agg.arg, { row, resolve })).filter((v) => v !== null);
  if (agg.fn === 'COUNT') return values.length;
  if (values.length === 0) return null;
  if (agg.fn === 'SUM' || agg.fn === 'AVG') {
    if (!values.every((v) => typeof v === 'number')) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return agg.fn === 'SUM' ? sum : sum / values.length;
  }
  let best = values[0];
  for (const v of values.slice(1)) {
    const c = compareValues(v, best);
    if (c === null) return null;
    if (agg.fn === 'MIN' ? c < 0 : c > 0) best = v;
  }
  return best;
};

const scanFor = (db, source, index, conjuncts, resolve) => {
  for (const c of conjuncts) {
    if (c.type !== 'binary' || c.op !== '=') continue;
    for (const [colSide, litSide] of [[c.left, c.right], [c.right, c.left]]) {
      if (colSide.type !== 'column' || litSide.type !== 'literal' || litSide.value === null) continue;
      const r = resolve(colSide);
      if (r.index !== index || !db.hasIndex(source.table, r.column)) continue;
      return { plan: { op: 'index_scan', table: source.table, column: r.column }, rows: db.lookup(source.table, r.column, litSide.value) };
    }
  }
  return { plan: { op: 'seq_scan', table: source.table }, rows: db.rows(source.table) };
};

const equiJoin = (on, leftIndices, rightIndex, resolve) => {
  if (on.type !== 'binary' || on.op !== '=' || on.left.type !== 'column' || on.right.type !== 'column') return null;
  const a = resolve(on.left);
  const b = resolve(on.right);
  if (leftIndices.has(a.index) && b.index === rightIndex) return { left: a, right: b };
  if (leftIndices.has(b.index) && a.index === rightIndex) return { left: b, right: a };
  return null;
};

const bucketize = (keys) => {
  const buckets = new Map();
  keys.forEach((key, position) => {
    if (key === NULL_KEY) return;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(position);
  });
  return buckets;
};

export const execute = (db, ast, options = {}) => {
  const { sources, resolve, orderBy, grouped, groupBy, aggregates } = analyze(ast, db.schema());
  const conjuncts = flattenAnd(ast.where);
  const width = sources.length;
  const scans = sources.map((source, index) => scanFor(db, source, index, conjuncts, resolve));

  let plan = scans[0].plan;
  let rows = scans[0].rows.map((r) => {
    const slot = new Array(width).fill(null);
    slot[0] = r;
    return slot;
  });
  const covered = new Set([0]);

  for (let j = 0; j < ast.joins.length; j += 1) {
    const rightIndex = j + 1;
    const rightRows = scans[rightIndex].rows;
    const on = ast.joins[j].on;
    const equi = equiJoin(on, covered, rightIndex, resolve);
    const merge = (left, right) => {
      const slot = left.slice();
      slot[rightIndex] = right;
      return slot;
    };
    let joined;
    if (equi) {
      // Hash join: the smaller input is hashed and the larger one probes it, but the pairs are emitted in left-input
      // order (then right-input order), so which side was hashed never changes the result.
      const leftKeys = rows.map((row) => keyOf(cellOf(row, equi.left.index, equi.left.column)));
      const rightKeys = rightRows.map((row) => keyOf(row[equi.right.column] === undefined ? null : row[equi.right.column]));
      const pairs = [];
      if (rows.length <= rightRows.length) {
        const buckets = bucketize(leftKeys);
        rightKeys.forEach((key, ri) => {
          for (const li of buckets.get(key) ?? []) pairs.push([li, ri]);
        });
      } else {
        const buckets = bucketize(rightKeys);
        leftKeys.forEach((key, li) => {
          for (const ri of buckets.get(key) ?? []) pairs.push([li, ri]);
        });
      }
      pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      joined = pairs.map(([li, ri]) => merge(rows[li], rightRows[ri]));
      plan = { op: 'hash_join', left: plan, right: scans[rightIndex].plan, on: [`${sources[equi.left.index].name}.${equi.left.column}`, `${sources[equi.right.index].name}.${equi.right.column}`] };
    } else {
      joined = [];
      for (const row of rows) {
        for (const right of rightRows) {
          const candidate = merge(row, right);
          if (evaluate(on, { row: candidate, resolve }) === true) joined.push(candidate);
        }
      }
      plan = { op: 'nested_loop_join', left: plan, right: scans[rightIndex].plan, on: null };
    }
    covered.add(rightIndex);
    rows = joined;
  }

  if (ast.where) rows = rows.filter((row) => evaluate(ast.where, { row, resolve }) === true);

  let records;
  if (grouped) {
    const groups = new Map();
    for (const row of rows) {
      const key = JSON.stringify(groupBy.map((g) => keyOf(cellOf(row, g.index, g.column))));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    // Aggregates without GROUP BY still produce exactly one row when nothing matched (COUNT(*) = 0, SUM = NULL).
    const groupRows = groups.size === 0 && groupBy.length === 0 ? [[]] : [...groups.values()];
    records = groupRows.map((memberRows) => {
      const values = new Map(aggregates.map((agg) => [agg, aggregateValue(agg, memberRows, resolve)]));
      const ctx = { row: memberRows[0] ?? new Array(width).fill(null), resolve, aggregates: values };
      return { values: ast.items.map((item) => evaluate(item.expr, ctx)), keys: orderBy.map((o) => evaluate(o.expr, ctx)) };
    });
  } else {
    records = rows.map((row) => {
      const ctx = { row, resolve };
      const values = ast.star ? sources.flatMap((s, i) => s.columns.map((c) => cellOf(row, i, c.name))) : ast.items.map((item) => evaluate(item.expr, ctx));
      return { values, keys: orderBy.map((o) => evaluate(o.expr, ctx)) };
    });
  }

  if (orderBy.length > 0) {
    const decorated = records.map((record, index) => ({ record, index }));
    decorated.sort((x, y) => {
      for (let k = 0; k < orderBy.length; k += 1) {
        const dir = orderBy[k].dir;
        const a = x.record.keys[k];
        const b = y.record.keys[k];
        if (a === null && b === null) continue;
        if (a === null) return dir === 'ASC' ? 1 : -1;
        if (b === null) return dir === 'ASC' ? -1 : 1;
        const c = compareValues(a, b);
        if (c === null || c === 0) continue;
        return dir === 'ASC' ? c : -c;
      }
      return x.index - y.index;
    });
    records = decorated.map((d) => d.record);
  }
  if (ast.limit !== null) records = records.slice(0, ast.limit);

  const columns = ast.star ? sources.flatMap((s) => s.columns.map((c) => c.name)) : ast.items.map(itemName);
  const result = { columns, rows: records.map((r) => r.values) };
  return options.explain ? { ...result, plan } : result;
};
