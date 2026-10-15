const caches: Array<{ now: Map<string, unknown>; last: Map<string, unknown> }> = [];
/** Starts a rebuild's generation: a result the previous rebuild did not use is dropped, so the caches hold what the live
 * window reads rather than every string the history ever had, and no rebuild meets an emptied cache. */
export const memoGeneration = (): void => { for (const c of caches) { c.last = c.now; c.now = new Map(); } };
/** Dashboard rebuilds revisit the same strings across the whole history; remember a pure string function's results. */
export const memo = <T extends string | null>(fn: (v: string) => T): ((v: string) => T) => {
  const c = { now: new Map<string, T>(), last: new Map<string, T>() };
  caches.push(c);
  return (v: string): T => {
    let value = c.now.get(v);
    if (value === undefined) { value = c.last.get(v) ?? (c.last.has(v) ? null as T : fn(v)); c.now.set(v, value); }
    return value;
  };
};
