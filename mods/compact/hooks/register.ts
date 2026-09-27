import type { Register } from 'claude-code';

import { resolveCompactConfig } from './config.ts';
import { assemble, buildDigest } from './digest.ts';

/** Bookkeeping never stands between the host and its own event. */
const quietly = (f: () => void): void => {
  try {
    f();
  } catch {
    // The event goes on unchanged.
  }
};

/**
 * Off by default, and off registers no hook at all. `shadow` builds the digest, logs its size and lets the engine
 * compact as usual (logging how long that took and what its summarizer used); `active` answers the compaction with
 * the digest and the kept tail, so no summarizer request runs. `/compact` stays the engine's unless `compactManual`.
 */
export const register: Register = (on, options) => {
  const resolved = resolveCompactConfig(options);
  if (!resolved.ok) {
    const field = resolved.field;
    on('session.start', ($, e, next) => {
      quietly(() => $.ui.log(`jev-compact ${JSON.stringify({ event: 'compact', disabled: 'invalid_option', field })}`, { to: 'debug' }));
      return next(e);
    });
    return;
  }
  const config = resolved.config;
  if (!config.enabled) return;

  on('session.compact', async ($, e, next) => {
    const log = (fields: Record<string, unknown>): void =>
      quietly(() => $.ui.log(`jev-compact ${JSON.stringify({ event: 'compact', mode: config.mode, trigger: e.trigger, subagent: e.agentId !== undefined, ...fields })}`, { to: 'debug' }));
    const handled = e.trigger === 'auto' || (e.trigger === 'manual' && config.manual);
    if (!handled || (e.agentId !== undefined && !config.subagents) || (e.trigger === 'manual' && e.instructions)) return next(e);

    const t0 = Date.now();
    let outcome: ReturnType<typeof buildDigest> | null = null;
    try {
      outcome = buildDigest(e.messages, { budgetChars: config.budgetChars });
    } catch {
      outcome = null;
    }
    const built = outcome?.ok
      ? { head: outcome.result.headMessages, tail: outcome.result.tailMessages, digestChars: outcome.result.digestChars, tailChars: outcome.result.tailChars, buildMs: Date.now() - t0 }
      : { fallback: outcome ? outcome.reason : 'error' };

    if (config.mode === 'active' && outcome?.ok) {
      log({ applied: true, messages: e.messages.length, ...built });
      return { messages: assemble(e.messages, outcome.result) };
    }
    const t1 = Date.now();
    const result = await next(e);
    quietly(() => {
      const core = result.skip === undefined ? { coreMs: Date.now() - t1, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter, usage: result.usage } : { coreSkip: true };
      log({ applied: false, messages: e.messages.length, ...built, ...core });
    });
    return result;
  });
};
