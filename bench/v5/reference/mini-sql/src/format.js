/** Six significant digits at most, no trailing zeros; whole numbers print without a decimal point. */
const cell = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(6)));
  return String(value);
};

export const formatTable = ({ columns, rows }) => {
  const headers = columns.map(String);
  const body = rows.map((row) => row.map(cell));
  // A column is numeric when it holds at least one number and no non-numeric value; those are right aligned.
  const numeric = headers.map((_, c) => {
    const values = rows.map((row) => row[c]).filter((v) => v !== null && v !== undefined);
    return values.length > 0 && values.every((v) => typeof v === 'number');
  });
  const widths = headers.map((header, c) => Math.max(header.length, ...body.map((row) => row[c].length), 0));
  const pad = (text, c) => (numeric[c] ? text.padStart(widths[c]) : text.padEnd(widths[c]));
  const line = (cells) => cells.join('  ').replace(/\s+$/, '');
  const out = [line(headers.map(pad)), line(widths.map((w) => '-'.repeat(w)))];
  for (const row of body) out.push(line(row.map(pad)));
  out.push(`(${rows.length} rows)`);
  return out.join('\n') + '\n';
};
