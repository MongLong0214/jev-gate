// Tokenizer: a first pass that only ever saw uppercase queries and quote-free strings.
const KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'NULL'];

export const tokenize = (sql) => {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === ' ' || ch === '\n' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === "'") {
      const close = sql.indexOf("'", i + 1);
      if (close < 0) throw new Error('unterminated string');
      tokens.push({ type: 'string', value: sql.slice(i + 1, close), pos: i });
      i = close + 1;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') j += 1;
      tokens.push({ type: 'number', value: Number(sql.slice(i, j)), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j += 1;
      const text = sql.slice(i, j);
      tokens.push(KEYWORDS.includes(text) ? { type: 'keyword', value: text, pos: i } : { type: 'ident', value: text, pos: i });
      i = j;
      continue;
    }
    if (ch === '=' || ch === '<' || ch === '>' || ch === '*') {
      tokens.push({ type: 'op', value: ch, pos: i });
      i += 1;
      continue;
    }
    if (ch === ',' || ch === '.') {
      tokens.push({ type: 'punct', value: ch, pos: i });
      i += 1;
      continue;
    }
    throw new Error('unexpected character ' + ch);
  }
  return tokens;
};
