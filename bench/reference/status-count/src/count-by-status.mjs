export function countByStatus(items) {
  const counts = {};
  for (const item of items) {
    const key = item.status === undefined || item.status === null ? 'unknown' : item.status;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
