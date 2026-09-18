// Bounded-concurrency job queue. Public API: createQueue({ concurrency }) -> { enqueue(fn), size(), drain() }
export function createQueue({ concurrency = 2 } = {}) {
  const pending = [];
  let running = 0;
  let drainResolvers = [];

  function next() {
    while (running < concurrency && pending.length) {
      const job = pending.shift();
      running++;
      job.fn().then((value) => {
        running--;
        job.resolve(value);
        next();
      });
    }
    if (running === 0 && pending.length === 0) {
      for (const r of drainResolvers) r();
      drainResolvers = [];
    }
  }

  return {
    enqueue(fn) {
      return new Promise((resolve) => {
        pending.push({ fn, resolve });
        next();
      });
    },
    size() { return pending.length + running; },
    drain() { return new Promise((resolve) => { if (running === 0 && pending.length === 0) resolve(); else drainResolvers.push(resolve); }); },
  };
}
