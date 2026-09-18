import { createTodoList } from './model.mjs';
export function serialize(list) { return JSON.stringify({ version: 2, items: list.list() }); }
export function deserialize(text) {
  const data = JSON.parse(text);
  if (data.version !== 1 && data.version !== 2) throw new Error(`unsupported version ${data.version}`);
  const list = createTodoList();
  for (const it of data.items) {
    const added = list.add(it.title, data.version === 1 ? 'normal' : it.priority);
    if (it.done) list.toggle(added.id);
  }
  return list;
}
