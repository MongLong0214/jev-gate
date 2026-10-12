export const paginate = (items, page, size) => {
  if (page < 1) throw new RangeError('page must be at least 1');
  if (size <= 0) throw new RangeError('size must be positive');
  return items.slice((page - 1) * size, page * size);
};
