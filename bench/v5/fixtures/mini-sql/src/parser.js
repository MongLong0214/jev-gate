import { tokenize } from './lexer.js';

// Handles exactly what the first demo needed: SELECT a list of columns (or *) FROM one table,
// optionally filtered by one comparison against a literal.
export const parse = (sql) => {
  const tokens = tokenize(sql);
  let i = 0;
  const take = () => tokens[i++];
  const expect = (value) => {
    const t = take();
    if (!t || t.value !== value) throw new Error('expected ' + value);
    return t;
  };

  expect('SELECT');
  const ast = { type: 'select', star: false, columns: [], table: null, where: null };
  if (tokens[i] && tokens[i].value === '*') {
    ast.star = true;
    i += 1;
  } else {
    for (;;) {
      const t = take();
      if (!t || t.type !== 'ident') throw new Error('expected a column name');
      ast.columns.push(t.value);
      if (tokens[i] && tokens[i].value === ',') {
        i += 1;
        continue;
      }
      break;
    }
  }
  expect('FROM');
  const table = take();
  if (!table || table.type !== 'ident') throw new Error('expected a table name');
  ast.table = table.value;
  if (tokens[i] && tokens[i].value === 'WHERE') {
    i += 1;
    const column = take();
    const op = take();
    const literal = take();
    if (!column || column.type !== 'ident' || !op || op.type !== 'op') throw new Error('malformed WHERE');
    if (!literal || (literal.type !== 'number' && literal.type !== 'string' && literal.value !== 'NULL')) throw new Error('malformed WHERE');
    ast.where = { column: column.value, op: op.value, value: literal.value === 'NULL' ? null : literal.value };
  }
  if (i < tokens.length) throw new Error('unexpected token ' + tokens[i].value);
  return ast;
};
