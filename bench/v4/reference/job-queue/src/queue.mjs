export function createQueue({ concurrency = 2, onError = null } = {}) {
  const pending = [];
  let running = 0;
  let drainResolvers = [];
  let nextId = 1;

  function settle() {
    running--;
    next();
  }

  function next() {
    while (running < concurrency && pending.length) {
      const job = pending.shift();
      running++;
      Promise.resolve()
        .then(() => job.fn())
        .then((value) => { job.resolve(value); settle(); }, (error) => { if (onError) { try { onError(error, job.id); } catch { /* observer errors never break the queue */ } } job.reject(error); settle(); });
    }
    if (running === 0 && pending.length === 0) {
      for (const r of drainResolvers) r();
      drainResolvers = [];
    }
  }

  return {
    enqueue(fn) {
      return new Promise((resolve, reject) => {
        pending.push({ id: nextId++, fn, resolve, reject });
        next();
      });
    },
    size() { return pending.length + running; },
    drain() { return new Promise((resolve) => { if (running === 0 && pending.length === 0) resolve(); else drainResolvers.push(resolve); }); },
  };
}
