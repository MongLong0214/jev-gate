import { cutSlug, MAX_SLUG, slugify } from './slugify.mjs';

export const uniqueSlug = (title, existing) => {
  const taken = new Set(existing);
  const base = slugify(title);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = cutSlug(base, MAX_SLUG - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
};
