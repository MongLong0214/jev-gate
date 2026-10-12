export const MAX_SLUG = 50;

// Cuts at the last '-' within max, or hard at max when the head has no boundary.
export const cutSlug = (slug, max = MAX_SLUG) => {
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max);
  if (slug[max] === '-') return head;
  const at = head.lastIndexOf('-');
  return at > 0 ? head.slice(0, at) : head;
};

export const slugify = (title) =>
  cutSlug(
    title
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, '-')
      .replace(/^-+|-+$/g, ''),
  );
