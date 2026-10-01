import type { EngineInterface, On, Register } from 'claude-code';

import type { OutputConfig } from './config.ts';

let sequence = 0;
import { resolveOutputConfig } from './config.ts';
import { foldVitest, isVitestCommand, MAX_BYTES, MIN_SAVING, utf8Bytes, withNote } from './filter.ts';
import { createRecorder } from './recording.ts';


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
 * Off by default, and off registers no hook at all. On, one `tool.call` hook on Bash: the command runs once, as the
 * host runs it, and only a passing `vitest run` log the host persisted whole (1 MiB or less by its own size) is read,
 * from the path the host's result names, and folded. Anything else, and any failure of this module's own step, hands
 * the host's result on as it came; an error or cancellation of the call itself passes up untouched.
 */
export const register: Register = (on, options) => {
  const resolved = resolveOutputConfig(options);
  if (!resolved.ok) {
    const field = resolved.field;
    on('session.start', ($, e, next) => {
      quietly(() => $.ui.log(`jev-output ${JSON.stringify({ event: 'output', disabled: 'invalid_option', field })}`, { to: 'debug' }));
      return next(e);
    });
    return;
  }
  registerOutput(on, resolved.config);
};

/** The hooks for a resolved config; the combined jev-gate module (hooks/register.ts) calls this directly. */
export const registerOutput = (on: On, config: OutputConfig): void => {
  if (!config.enabled) return;

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!isVitestCommand(e.command)) return next(e);
    const recorder = recorderOf($);
    try {
    const runId = `${Date.now()}-${++sequence}`;
    const log = (fields: Record<string, unknown>): void =>
      quietly(() => recorder.log(`jev-output ${JSON.stringify({ event: 'output', run_id: runId, parser: 'vitest', ...fields })}`));
    log({ stage: 'started' });
    const ran = await next(e).catch((error: unknown) => {
      log({ skipped: 'host_error' });
      throw error;
    });
    try {
      if (ran.deny !== undefined || ran.isError === true || ran.text === undefined) {
        log({ skipped: 'not_completed' });
        return ran;
      }
      const r = ran.result;
      // Each of these is a result the host marks as more than one plain finished output, or appends a note to.
      const plain = !r.interrupted && r.isImage !== true && r.backgroundTaskId === undefined && r.returnCodeInterpretation === undefined && r.stderr === '' && (r.structuredContent?.length ?? 0) === 0 && r.staleReadFileStateHint === undefined && r.ghRateLimitHint === undefined;
      if (!plain) {
        log({ skipped: 'not_plain' });
        return ran;
      }
      const { persistedOutputPath: path, persistedOutputSize: size, ...rest } = r;
      if (path === undefined || size === undefined) {
        log({ skipped: 'inline' });
        return ran;
      }
      if (size > MAX_BYTES) {
        log({ skipped: 'too_large' });
        return ran;
      }
      const original = await $.fs.read(path);
      // The host sizes the file it wrote in bytes; a file that no longer has that size is not the one it described.
      if (utf8Bytes(original) !== size) {
        log({ skipped: 'size_mismatch' });
        return ran;
      }
      const folded = foldVitest(original);
      if (!folded.ok) {
        log({ skipped: folded.reason });
        return ran;
      }
      const stdout = withNote(folded.text, path, size);
      if (utf8Bytes(stdout) + MIN_SAVING > utf8Bytes(ran.text)) {
        log({ skipped: 'not_smaller' });
        return ran;
      }
      log({ applied: true, runs: folded.runs });
      // Without the persisted fields the host's mapper sends `stdout` itself instead of a preview of it; the path rides in the note.
      return ran.context === undefined ? { result: { ...rest, stdout } } : { result: { ...rest, stdout }, context: ran.context };
    } catch {
      log({ skipped: 'error' });
      return ran;
    }
    } finally { await recorder.flush(); }
  });
};
