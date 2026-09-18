import { SqlSyntaxError } from './errors.js';

const KEYWORDS = new Set(['SELECT', 'FROM', 'AS', 'JOIN', 'ON', 'WHERE', 'GROUP', 'BY', 'ORDER', 'ASC', 'DESC', 'LIMIT', 'AND', 'OR', 'NOT', 'IS', 'NULL']);
const OPERATORS = ['<=', '>=', '<>', '=', '<', '>', '+', '-', '*', '/'];
const PUNCT = new Set(['(', ')', ',', '.']);
const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);

export const tokenize = (sql) => {
  if (typeof sql !== 'string') throw new SqlSyntaxError('query must be a string', 0);
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }
    if (ch === "'") {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= sql.length) throw new SqlSyntaxError('unterminated string literal', i);
        if (sql[j] === "'") {
          // Two adjacent quotes inside a literal are one quote character, not the end of the literal.
          if (sql[j + 1] === "'") { value += "'"; j += 2; continue; }
          j += 1;
          break;
        }
        value += sql[j];
        j += 1;
      }
      tokens.push({ type: 'string', value, pos: i });
      i = j;
      continue;
    }
    if (isDigit(ch)) {
      let j = i;
      while (j < sql.length && isDigit(sql[j])) j += 1;
      if (sql[j] === '.' && isDigit(sql[j + 1])) {
        j += 1;
        while (j < sql.length && isDigit(sql[j])) j += 1;
      }
      tokens.push({ type: 'number', value: Number(sql.slice(i, j)), pos: i });
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i;
      while (j < sql.length && isIdentPart(sql[j])) j += 1;
      const text = sql.slice(i, j);
      const upper = text.toUpperCase();
      tokens.push(KEYWORDS.has(upper) ? { type: 'keyword', value: upper, pos: i } : { type: 'ident', value: text, pos: i });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => sql.startsWith(o, i));
    if (op) { tokens.push({ type: 'op', value: op, pos: i }); i += op.length; continue; }
    if (PUNCT.has(ch)) { tokens.push({ type: 'punct', value: ch, pos: i }); i += 1; continue; }
    throw new SqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`, i);
  }
  return tokens;
};
