const field = (v) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (rows) => ['sku,qty', ...rows.map((r) => `${field(r.sku)},${field(r.qty)}`)].join('\n');
