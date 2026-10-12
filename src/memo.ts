/** Dashboard rebuilds revisit the same strings across the whole history; remember a pure string function's results.
 * The cache is dropped whole at a bound so a long-running server cannot grow without limit. */
export const memo = <T>(fn: (v: string) => T, limit = 200_000): ((v: string) => T) => {
  const cache = new Map<string, T>();
  return (v: string): T => {
    let value = cache.get(v);
    if (value === undefined) {
      if (cache.size >= limit) cache.clear();
      value = fn(v); cache.set(v, value);
    }
    return value;
  };
};
