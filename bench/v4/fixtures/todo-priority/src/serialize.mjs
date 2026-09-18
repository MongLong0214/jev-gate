// Persistence format v1: { version: 1, items: [{ id, title, done }] }
import { createTodoList } from './model.mjs';
export function serialize(list) { return JSON.stringify({ version: 1, items: list.list() }); }
export function deserialize(text) {
  const data = JSON.parse(text);
  if (data.version !== 1) throw new Error(`unsupported version ${data.version}`);
  const list = createTodoList();
  for (const it of data.items) { const added = list.add(it.title); if (it.done) list.toggle(added.id); }
  return list;
}
