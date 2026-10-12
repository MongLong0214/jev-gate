export const paginate = (items, page, size) => items.slice(page * size, page * size + size);
