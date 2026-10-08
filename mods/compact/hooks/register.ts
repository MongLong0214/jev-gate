import type { EngineInterface, On, Register, SessionMessage } from 'claude-code';

import type { CompactConfig } from './config.ts';
import { resolveCompactConfig } from './config.ts';
import { assemble, buildDigest } from './digest.ts';
import { createRecorder } from './recording.ts';
import { createCompactSelector } from './selection.ts';
import { installedKeyPath, parseInstalledKey } from '../../router/hooks/key.ts';

let sequence = 0;


// The native validator follows $ only within this file; the shared recorder receives plain callbacks.
const recorderOf = ($: EngineInterface) => createRecorder({
  paths: async () => {
    const [home, state, config, trace, session] = await Promise.all([
      $.env.get('HOME'), $.env.get('XDG_STATE_HOME'), $.env.get('XDG_CONFIG_HOME'), $.env.get('JEV_GATE_TRACE_DIR'), $.session.id(),
    ]);
    return { home, state, config, trace, session };
  },
  stat: path => $.fs.stat(path), exists: path => $.fs.exists(path), read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text), debug: line => $.ui.log(line, { to: 'debug' }),
  wait: (ms, signal) => $.clock.sleep(ms, { signal }),
});

/** Bookkeeping never stands between the host and its own event. */
const quietly = (f: () => void): void => {
  try {
    f();
  } catch {
    // The event goes on unchanged.
  }
};

/**
 * On by default; off registers no hook at all. `shadow` builds the digest, logs its size and lets the engine
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
  registerCompact(on, resolved.config);
};

/** The hooks for a resolved config; the combined jev-gate module (hooks/register.ts) calls this directly. */
export const registerCompact = (on: On, config: CompactConfig, observer?: { contextChanged?: (agentId?: string) => void }): void => {
  if (!config.enabled && !observer) return;
  const select = createCompactSelector(config.jevTimeoutMs ?? 1000);

  on('session.compact', async ($, e, next) => {
    const forward = async (input: typeof e) => {
      const result = await next(input);
      if (result.skip === undefined) observer?.contextChanged?.(e.agentId);
      return result;
    };
    if (!config.enabled) return forward(e);
    const recorder = recorderOf($);
    try {
    const runId = `${Date.now()}-${++sequence}`;
    const log = (fields: Record<string, unknown>): void =>
      quietly(() => recorder.log(`jev-compact ${JSON.stringify({ event: 'compact', run_id: runId, mode: config.mode, trigger: e.trigger, subagent: e.agentId !== undefined, ...fields })}`));
    const handled = e.trigger === 'auto' || (e.trigger === 'manual' && config.manual);
    const deferred = !handled ? 'trigger' : e.agentId !== undefined && !config.subagents ? 'subagent' : e.trigger === 'manual' && e.instructions ? 'instructions' : null;
    if (deferred) {
      log({ deferred });
      return forward(e);
    }

    log({ stage: 'started', messages: e.messages.length });

    const t0 = Date.now();
    // Its own failure, building or assembling, leaves the compaction to the engine; the engine's is never retried.
    let outcome: ReturnType<typeof buildDigest> | null = null;
    let answer: SessionMessage[] | null = null;
    try {
      outcome = buildDigest(e.messages, { budgetChars: config.budgetChars });
      if (outcome.ok && config.jevEnabled !== false) {
        try {
          let key = await $.env.get('TYPESAFE_API_KEY');
          if (!key) {
            const path = installedKeyPath(await $.env.get('HOME'), await $.env.get('XDG_CONFIG_HOME'));
            if (path && await $.fs.exists(path)) key = parseInstalledKey(await $.fs.read(path));
          }
          const selection = await select(e.messages, outcome.result, key,
            { fetch: (url, init) => $.http.fetch(url, init), sleep: (ms, signal) => $.clock.sleep(ms, { signal }) }, next.signal);
          log({ stage: 'jev', jev_sent: selection.sent, jev_ms: selection.durationMs, usage: selection.usage, candidates: selection.candidates, available: selection.available, dependencies: selection.priorities.length, selection: selection.reason });
          if (next.signal?.aborted) return forward(e);
          if (selection.priorities.length) {
            const enhanced = buildDigest(e.messages, { budgetChars: config.budgetChars, priorityResults: selection.priorities });
            if (enhanced.ok) outcome = enhanced;
          }
        } catch {
          // Optional judgment/key access must never invalidate the already-built local digest.
          log({ stage: 'jev', selection: 'error', jev_sent: null });
        }
      }
      if (next.signal?.aborted) return forward(e);
      if (config.mode === 'active' && outcome.ok) answer = assemble(e.messages, outcome.result);
    } catch {
      outcome = null;
    }
    const built = outcome?.ok
      ? { head: outcome.result.headMessages, tail: outcome.result.tailMessages, digestChars: outcome.result.digestChars, tailChars: outcome.result.tailChars, buildMs: Date.now() - t0 }
      : { fallback: outcome ? outcome.reason : 'error' };

    if (answer) {
      log({ applied: true, messages: e.messages.length, ...built });
      observer?.contextChanged?.(e.agentId);
      return { messages: answer };
    }
    const t1 = Date.now();
    // The engine can refuse too (a lone exchange it cannot summarize), or be cancelled; the line is still written, the
    // rejection passes up, and the engine is not asked again.
    const result = await forward(e).catch((err: unknown) => {
      log({ applied: false, messages: e.messages.length, ...built, coreMs: Date.now() - t1, coreError: true });
      throw err;
    });
    quietly(() => {
      const core = result.skip === undefined ? { coreMs: Date.now() - t1, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter, usage: result.usage } : { coreSkip: true };
      log({ applied: false, messages: e.messages.length, ...built, ...core });
    });
    return result;
    } finally { await recorder.flush(); }
  });
};
