import type { HttpReply } from '../../mods/router/hooks/client.ts';
import { JEV_MODEL } from '../../mods/router/hooks/client.ts';
import type { HostPins, RouterEngine } from '../../mods/router/hooks/router.ts';

/** Shaped like a key and matching nothing real. */
export const FAKE_KEY = 'sk-router-testonlynotakey';

export interface SentRequest {
  url: string;
  headers: Record<string, string>;
  state: unknown;
  questions: Record<string, { criteria: Record<string, string> }>;
}

export type Responder = (req: SentRequest) => HttpReply | Promise<HttpReply>;

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export const deferred = <T>(): Deferred<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

export interface FakeEngineOptions {
  respond?: Responder;
  envKey?: string | undefined;
  pins?: Partial<HostPins>;
  availableModels?: readonly string[] | undefined;
  hostBase?: string | undefined;
}

/**
 * A fake `$`: HTTP answered by `respond`, and a clock whose waits never end on their own (`expire()` ends them), so a
 * test says exactly when an assessment times out.
 */
export const fakeEngine = (o: FakeEngineOptions = {}) => {
  const sent: SentRequest[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const timers: Array<{ ms: number; resolve: () => void }> = [];
  const engine: RouterEngine = {
    fetch: async (url, init) => {
      const body = JSON.parse(init.body) as { model: string; state: unknown; questions: SentRequest['questions'] };
      if (body.model !== JEV_MODEL) throw new Error('wrong model in request');
      const req: SentRequest = { url, headers: init.headers, state: body.state, questions: body.questions };
      sent.push(req);
      if (!o.respond) throw new Error('unexpected request');
      return o.respond(req);
    },
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        timers.push({ ms, resolve });
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    envKey: async () => ('envKey' in o ? o.envKey : FAKE_KEY),
    pins: async () => ({ mainModel: false, mainEffort: false, subagentModel: false, aliasRemap: false, ...o.pins }),
    availableModels: async () => o.availableModels,
    hostBase: async () => ('hostBase' in o ? o.hostBase : '2.1.282'),
    log: (line) => {
      if (!line.startsWith('jev-router ')) throw new Error(`unprefixed log line: ${line}`);
      logs.push(JSON.parse(line.slice('jev-router '.length)) as Record<string, unknown>);
    },
  };
  return {
    engine,
    sent,
    logs,
    expire: (): void => {
      for (const t of timers.splice(0)) t.resolve();
    },
  };
};

type Pick = [choice: string, confidence: number];

/** A valid choice: the pick at 0.9, the rest sharing 0.1. */
export const choice = (keys: readonly string[], [pick, confidence]: Pick): Record<string, unknown> => ({
  type: 'choice',
  choice: pick,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 0.9 : 0.1 / (keys.length - 1)])),
  confidence,
});

/** Answers each question that was actually asked, from `picks`; a question without a pick is left out. */
export const answering =
  (picks: Partial<Record<'control' | 'tier' | 'effort' | 'action_risk', Pick>>, usage = { input_tokens: 900, output_tokens: 40 }): Responder =>
  (req) => ({
    status: 200,
    text: JSON.stringify({
      model: JEV_MODEL,
      answers: Object.fromEntries(
        Object.entries(req.questions).flatMap(([name, q]) => {
          const pick = picks[name as keyof typeof picks];
          return pick ? [[name, choice(Object.keys(q.criteria), pick)]] : [];
        }),
      ),
      usage,
    }),
  });

/** Clear, ordinary, and confident: every gate open, so only the dimension answers decide. */
export const CLEAR: Partial<Record<'control' | 'action_risk', Pick>> = { control: ['task_clear', 0.97], action_risk: ['ordinary', 0.97] };

/** A `next` for a streaming hook: records what it was called with, yields one chunk, returns a result. */
export const streamNext = <E extends { model: string }>(usageModel: ((e: E) => string | null) | null = (e) => e.model) => {
  const calls: E[] = [];
  const controller = new AbortController();
  const fn = Object.assign(
    async function* (e: E): AsyncGenerator<string, { usage: { model: string } | null }> {
      calls.push(e);
      yield 'chunk';
      const model = usageModel ? usageModel(e) : null;
      return { usage: model === null ? null : { model } };
    },
    { signal: controller.signal },
  );
  return { next: fn, calls, controller };
};

export const drain = async <C, R>(gen: AsyncGenerator<C, R>): Promise<{ chunks: C[]; result: R }> => {
  const chunks: C[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { chunks, result: r.value };
    chunks.push(r.value);
  }
};
