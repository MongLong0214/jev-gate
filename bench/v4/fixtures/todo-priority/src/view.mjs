// Text view: one line per item, "[x] title" or "[ ] title", in insertion order.
export function renderList(list) {
  return list.list().map((it) => `[${it.done ? 'x' : ' '}] ${it.title}`).join('\n');
}
