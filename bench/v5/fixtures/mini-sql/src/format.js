// Prints a result grid. Everything is left aligned and padded to a fixed width.
export const formatTable = ({ columns, rows }) => {
  const lines = [columns.join(' ')];
  lines.push(columns.map(() => '---').join(' '));
  for (const row of rows) lines.push(row.map((v) => String(v === null ? '' : v)).join(' '));
  return lines.join('\n');
};
