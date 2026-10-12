import { cutSlug, MAX_SLUG, slugify } from './slugify.mjs';

export const uniqueSlug = (title, existing) => {
  const base = slugify(title);
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = cutSlug(base, MAX_SLUG - suffix.length) + suffix;
    if (!existing.has(candidate)) return candidate;
  }
};
