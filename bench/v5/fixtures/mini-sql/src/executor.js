// Scans one table and filters it row by row. No joins, no grouping, no ordering, no plan.
const matches = (row, where) => {
  const value = row[where.column.toLowerCase()];
  if (where.op === '=') return value === where.value;
  if (where.op === '<') return value < where.value;
  if (where.op === '>') return value > where.value;
  throw new Error('unsupported operator ' + where.op);
};

export const execute = (db, ast) => {
  const schema = db.schema();
  const table = ast.table.toLowerCase();
  if (!schema[table]) throw new Error('unknown table ' + ast.table);
  const columns = ast.star ? schema[table].map((c) => c.name) : ast.columns.map((c) => c.toLowerCase());
  const rows = [];
  for (const row of db.rows(table)) {
    if (ast.where && !matches(row, ast.where)) continue;
    rows.push(columns.map((c) => row[c]));
  }
  return { columns, rows };
};
