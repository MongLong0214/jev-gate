export function createTtlCache(ttlMs, now = () => Date.now()) {
  const store = new Map();
  return {
    set(key, value) {
      store.set(key, { value, expiresAt: now() + ttlMs });
    },
    get(key) {
      const entry = store.get(key);
      return entry ? entry.value : undefined;
    },
    size() {
      return store.size;
    },
  };
}
