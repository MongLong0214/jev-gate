// Todo list model. Items: { id, title, done }
export function createTodoList() {
  const items = [];
  let nextId = 1;
  return {
    add(title) { const item = { id: nextId++, title, done: false }; items.push(item); return item; },
    toggle(id) { const it = items.find((x) => x.id === id); if (!it) throw new Error(`no item ${id}`); it.done = !it.done; return it; },
    list() { return items.map((x) => ({ ...x })); },
  };
}
