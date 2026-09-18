export const PRIORITIES = ['low', 'normal', 'high'];
export function createTodoList() {
  const items = [];
  let nextId = 1;
  return {
    add(title, priority = 'normal') {
      if (!PRIORITIES.includes(priority)) throw new RangeError(`invalid priority ${priority}`);
      const item = { id: nextId++, title, done: false, priority };
      items.push(item);
      return item;
    },
    toggle(id) { const it = items.find((x) => x.id === id); if (!it) throw new Error(`no item ${id}`); it.done = !it.done; return it; },
    setPriority(id, priority) {
      if (!PRIORITIES.includes(priority)) throw new RangeError(`invalid priority ${priority}`);
      const it = items.find((x) => x.id === id); if (!it) throw new Error(`no item ${id}`); it.priority = priority; return it;
    },
    list() { return items.map((x) => ({ ...x })); },
  };
}
