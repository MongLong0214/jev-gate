import type { ChoiceAnswer, HttpCode, JevUsage, PlannerTier, Tier } from './types.js';

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MAX_REQUEST_BYTES = 128 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROB_SUM_TOLERANCE = 1e-3;
const ARGMAX_TOLERANCE = 1e-6;

/** Vendor-neutral tier descriptions (D3/D10): Jev sees capability profiles, never model or provider names. */
export const TIER_PROFILES: Record<Tier, string> = {
  fast: 'Mechanical, fully specified work under an established contract with cheap observable checks.',
  standard: 'Bounded implementation or investigation under established contracts, including substantial mechanical changes and tests.',
  deep: 'Concrete unresolved interacting constraints or an observed reasoning failure beyond ordinary cross-file work.',
  frontier: 'Exceptional unresolved foundational constraints or a documented unresolved reasoning problem.',
};

export const PLANNER_TIER_PROFILES: Record<PlannerTier, string> = {
  deep: 'Establish an implementation plan using recognizable interfaces, constraints and engineering approaches.',
  frontier: 'Resolve unusually consequential, interacting and unresolved architectural or domain constraints before implementation can be specified.',
};

/** Every gate builds this shape; the client is indifferent to which questions a gate asks. */
export interface JevRequest<S = unknown, Q = unknown> {
  model: string;
  state: S;
  questions: Q;
}

export interface JevResponse {
  model: string | null;
  usage: JevUsage;
  answers: Record<string, unknown>;
  bytes: number;
}

export type JevOutcome =
  | { ok: true; response: JevResponse; status: number; durationMs: number; requestBytes: number }
  | { ok: false; code: HttpCode; status: number | null; durationMs: number; requestBytes: number };

export interface JevCallDeps {
  apiKey: string;
  deadlineMs: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const statusToCode = (status: number): HttpCode => {
  if (status === 401) return 'http_401';
  if (status === 422) return 'http_422';
  if (status === 429) return 'http_429';
  if (status === 529) return 'http_529';
  return 'http_other';
};

const parseUsage = (v: unknown): JevUsage => {
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  if (!isRecord(v)) return { input_tokens: null, output_tokens: null };
  return { input_tokens: num(v['input_tokens']), output_tokens: num(v['output_tokens']) };
};

/** Reads the body under the same abort signal as the headers, so one deadline covers the whole exchange. */
const readCapped = async (res: Response, cap: number, signal: AbortSignal): Promise<{ text: string; bytes: number } | null> => {
  const body = res.body;
  if (!body) {
    const text = await res.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    return bytes > cap ? null : { text, bytes };
  }
  const reader = body.getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error('aborted during body read');
      if (done) break;
      bytes += value.byteLength;
      if (bytes > cap) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes };
};

/** One POST, one deadline covering headers and body, zero retries. The key never leaves this function except as the header. */
export const callJev = async <S, Q>(request: JevRequest<S, Q>, deps: JevCallDeps): Promise<JevOutcome> => {
  const body = JSON.stringify(request);
  const requestBytes = Buffer.byteLength(body, 'utf8');
  const started = performance.now();
  const elapsed = (): number => Math.round(performance.now() - started);
  if (requestBytes > MAX_REQUEST_BYTES) return { ok: false, code: 'request_too_large', status: null, durationMs: 0, requestBytes };
  if (deps.signal?.aborted) return { ok: false, code: 'aborted', status: null, durationMs: 0, requestBytes };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deps.deadlineMs);
  const onAbort = (): void => controller.abort();
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(JEV_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body,
      redirect: 'error',
      signal: controller.signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, code: statusToCode(res.status), status: res.status, durationMs: elapsed(), requestBytes };
    }
    const read = await readCapped(res, MAX_RESPONSE_BYTES, controller.signal);
    if (read === null) return { ok: false, code: 'response_too_large', status: 200, durationMs: elapsed(), requestBytes };
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text);
    } catch {
      return { ok: false, code: 'response_invalid', status: 200, durationMs: elapsed(), requestBytes };
    }
    if (!isRecord(parsed) || !isRecord(parsed['answers'])) {
      return { ok: false, code: 'response_invalid', status: 200, durationMs: elapsed(), requestBytes };
    }
    return {
      ok: true,
      response: {
        model: typeof parsed['model'] === 'string' ? parsed['model'] : null,
        usage: parseUsage(parsed['usage']),
        answers: parsed['answers'],
        bytes: read.bytes,
      },
      status: 200,
      durationMs: elapsed(),
      requestBytes,
    };
  } catch {
    if (controller.signal.aborted) return { ok: false, code: timedOut ? 'timeout' : 'aborted', status: null, durationMs: elapsed(), requestBytes };
    return { ok: false, code: 'network', status: null, durationMs: elapsed(), requestBytes };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onAbort);
  }
};

/** Strict schema check: exact key set, finite probabilities in [0,1] summing to 1, choice equals argmax. No coercion or renormalization. */
export const validateChoice = <K extends string>(value: unknown, keys: readonly K[]): ChoiceAnswer<K> | null => {
  if (!isRecord(value) || value['type'] !== 'choice') return null;
  const choice = value['choice'];
  if (typeof choice !== 'string' || !keys.includes(choice as K)) return null;
  const probs = value['probabilities'];
  if (!isRecord(probs)) return null;
  const probKeys = Object.keys(probs);
  if (probKeys.length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(probs, k))) return null;
  let sum = 0;
  let max = Number.NEGATIVE_INFINITY;
  for (const k of keys) {
    const p = probs[k];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) return null;
    sum += p;
    if (p > max) max = p;
  }
  if (Math.abs(sum - 1) > PROB_SUM_TOLERANCE) return null;
  const chosen = probs[choice] as number;
  if (chosen < max - ARGMAX_TOLERANCE) return null;
  const confidence = value['confidence'];
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { type: 'choice', choice: choice as K, probabilities: probs as Record<K, number>, confidence };
};

export const topChoices = <K extends string>(answer: ChoiceAnswer<K>): K[] => {
  const max = Math.max(...Object.values<number>(answer.probabilities));
  return (Object.keys(answer.probabilities) as K[]).filter((k) => answer.probabilities[k] >= max - ARGMAX_TOLERANCE);
};

export type { HttpCode };
