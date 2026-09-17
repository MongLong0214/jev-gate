const KNOWN_STATUSES = ['open', 'closed'];

export function countByStatus(items) {
  const counts = Object.fromEntries(KNOWN_STATUSES.map((status) => [status, 0]));
  for (const item of items) {
    if (item.status in counts) counts[item.status] += 1;
  }
  return counts;
}
