export function createTtlCache(ttlMs, now = () => Date.now()) {
  const store = new Map();
  return {
    set(key, value) {
      store.set(key, { value, expiresAt: now() + ttlMs });
    },
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (now() >= entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    size() {
      return store.size;
    },
  };
}
