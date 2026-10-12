export const toCsv = (rows) => ['sku,qty', ...rows.map((r) => `${r.sku},${r.qty}`)].join('\n');
