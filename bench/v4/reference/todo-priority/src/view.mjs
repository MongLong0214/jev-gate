const ORDER = { high: 0, normal: 1, low: 2 };
export function renderList(list) {
  return list.list()
    .map((it, index) => ({ it, index }))
    .sort((a, b) => ORDER[a.it.priority] - ORDER[b.it.priority] || a.index - b.index)
    .map(({ it }) => `[${it.done ? 'x' : ' '}] ${it.priority === 'normal' ? '' : `(${it.priority}) `}${it.title}`)
    .join('\n');
}
