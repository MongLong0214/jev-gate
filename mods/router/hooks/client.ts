import { looksSecret } from './secret.ts';

/**
 * The one TypeSafe call (#40), runtime-neutral: everything that touches the network or the clock comes in through a
 * Transport, so the same code runs under the host's `$` and under a fake in tests. No retry, no chunking, no
 * summarising: an input that does not fit is skipped whole.
 */
export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-1.13.0';
/** The existing serialized-request cap, questions and JSON escaping included. */
export const MAX_REQUEST_BYTES = 128 * 1024;
/**
 * The provider bounds tokens, not bytes: 64K in total and 32K for state plus the longest question. This is Lean's
 * calibrated estimate and cap (src/lean.ts, 2026-09-21): ASCII at 1.5 characters per token, every other character a
 * whole token, 25,000 on the whole serialized request. It over-counts prose and is not a tokenizer; a request it lets
 * through can still be refused, and that refusal is kept as `rejected_input`, not retried.
 */
export const MAX_REQUEST_TOKENS = 25_000;
/** The host has already buffered the body as text; this only refuses to parse an unreasonable one. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Unresolved requests this module may hold. Past it a task stays native rather than queueing behind others. */
export const MAX_IN_FLIGHT = 8;

export const estimateTokens = (text: string): number => {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 1.5) + wide;
};

export interface HttpReply {
  status: number;
  text: string;
}

export interface Transport {
  fetch: (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<HttpReply>;
  /** Resolves after `ms`; rejects when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface Usage {
  input_tokens: number | null;
  output_tokens: number | null;
}

export type ClientReason =
  | 'credential_refused'
  | 'input_secret'
  | 'input_too_large'
  | 'aborted'
  | 'saturated'
  | 'timeout'
  | 'network'
  | 'rejected_input'
  | 'unauthorized'
  | 'payment_required'
  | 'rate_limited'
  | 'overloaded'
  | 'http_other'
  | 'response_too_large'
  | 'malformed'
  | 'model_mismatch';

export type Assessment =
  | { ok: true; answers: unknown; usage: Usage | null; requestBytes: number }
  /** `sent` is whether a request may have reached the provider: its input is then unknown, never zero. */
  | { ok: false; reason: ClientReason; usage: Usage | null; requestBytes: number | null; sent: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

/** Usage is read on its own, so an unusable answer or a late reply still reports what it cost. */
export const parseUsage = (body: unknown): Usage | null => {
  if (!isRecord(body) || !isRecord(body['usage'])) return null;
  const u = body['usage'];
  const usage = { input_tokens: count(u['input_tokens']), output_tokens: count(u['output_tokens']) };
  return usage.input_tokens === null && usage.output_tokens === null ? null : usage;
};

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).length;

/** Every string value a request would carry, however deep. */
const stringsIn = (v: unknown, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (isRecord(v)) for (const x of Object.values(v)) stringsIn(x, out);
  return out;
};

const reasonForStatus = (status: number): ClientReason => {
  if (status === 400 || status === 413 || status === 422) return 'rejected_input';
  if (status === 401) return 'unauthorized';
  if (status === 402) return 'payment_required';
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  return 'http_other';
};

const parseBody = (text: string): unknown => {
  if (byteLength(text) > MAX_RESPONSE_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

export interface JevClient {
  /** `onLate` sees this request's usage if its reply arrives after the wait ended, alongside the client-wide one. */
  assess: (transport: Transport, apiKey: string, state: unknown, questions: unknown, signal?: AbortSignal, onLate?: (usage: Usage | null) => void) => Promise<Assessment>;
  /** Unresolved requests right now. */
  inFlight: () => number;
}

export interface ClientOptions {
  timeoutMs: number;
  /** A reply that arrived after its wait ended: observed for its usage, never applied. */
  onLate?: (usage: Usage | null) => void;
}

export const createClient = (opts: ClientOptions): JevClient => {
  let inFlight = 0;
  // 401 and 402 do not improve by asking again: every later task in this activation stays native without a call.
  let refused = false;

  const interpret = (reply: HttpReply, requestBytes: number): Assessment => {
    const body = parseBody(reply.text);
    const usage = parseUsage(body);
    if (reply.status !== 200) {
      const reason = reasonForStatus(reply.status);
      if (reason === 'unauthorized' || reason === 'payment_required') refused = true;
      return { ok: false, reason, usage, requestBytes, sent: true };
    }
    if (byteLength(reply.text) > MAX_RESPONSE_BYTES) return { ok: false, reason: 'response_too_large', usage: null, requestBytes, sent: true };
    if (!isRecord(body) || !isRecord(body['answers'])) return { ok: false, reason: 'malformed', usage, requestBytes, sent: true };
    if (body['model'] !== JEV_MODEL) return { ok: false, reason: 'model_mismatch', usage, requestBytes, sent: true };
    return { ok: true, answers: body['answers'], usage, requestBytes };
  };

  const assess: JevClient['assess'] = async (transport, apiKey, state, questions, signal, onLate) => {
    if (refused) return { ok: false, reason: 'credential_refused', usage: null, requestBytes: null, sent: false };
    // Masking would send a changed task; dropping the string would drop a constraint. Either way: no request.
    if (stringsIn(state).concat(stringsIn(questions)).some(looksSecret)) {
      return { ok: false, reason: 'input_secret', usage: null, requestBytes: null, sent: false };
    }
    const body = JSON.stringify({ model: JEV_MODEL, state, questions });
    const requestBytes = byteLength(body);
    if (requestBytes > MAX_REQUEST_BYTES || estimateTokens(body) > MAX_REQUEST_TOKENS) {
      return { ok: false, reason: 'input_too_large', usage: null, requestBytes, sent: false };
    }
    if (signal?.aborted) return { ok: false, reason: 'aborted', usage: null, requestBytes, sent: false };
    if (inFlight >= MAX_IN_FLIGHT) return { ok: false, reason: 'saturated', usage: null, requestBytes, sent: false };

    inFlight += 1;
    const request = (async () => {
      try {
        return await transport.fetch(JEV_ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body,
        });
      } finally {
        inFlight -= 1;
      }
    })();

    // The host's HTTP takes no signal, so this ends the WAIT, not the request: the provider may still run and bill it.
    const wait = new AbortController();
    const onAbort = (): void => wait.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    type Race = { k: 'reply'; reply: HttpReply } | { k: 'network' } | { k: 'timeout' } | { k: 'aborted' };
    let race: Race;
    try {
      race = await Promise.race<Race>([
        request.then(
          (reply) => ({ k: 'reply', reply }),
          () => ({ k: 'network' }),
        ),
        transport.sleep(opts.timeoutMs, wait.signal).then(
          () => ({ k: 'timeout' }),
          () => ({ k: 'aborted' }),
        ),
      ]);
    } finally {
      wait.abort();
      signal?.removeEventListener('abort', onAbort);
    }

    if (race.k === 'reply') return interpret(race.reply, requestBytes);
    if (race.k === 'network') return { ok: false, reason: 'network', usage: null, requestBytes, sent: true };
    request.then(
      (reply) => {
        if (reply.status === 401 || reply.status === 402) refused = true;
        const usage = parseUsage(parseBody(reply.text));
        for (const report of [opts.onLate, onLate]) {
          try {
            report?.(usage);
          } catch {
            // Observation only.
          }
        }
      },
      () => undefined,
    );
    return { ok: false, reason: race.k, usage: null, requestBytes, sent: true };
  };

  return { assess, inFlight: () => inFlight };
};
