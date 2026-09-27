import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig, type Env } from './config.js';

/**
 * #48 P2: idle cost. `hooks.json` and `lean.json` point every event at this file instead of `dist/hook.js` directly.
 * hook.ts's own static import graph pulls in admission, allocation, coordinator, jev, job, plan, trace, lean,
 * lean-source, depth, interpretation, brief, auth, liveness and host-window before it ever reads a byte of stdin --
 * paid on every single invocation, including the common case of a fresh install or `JEV_GATE_MODE=off`, where none
 * of that work does anything. This file imports only the lightweight config loader -- no admission, routing or
 * network logic lives in `config.ts`, so it is not one of the modules this exists to avoid -- decides with the same
 * resolution `loadConfig` always used whether the gate is definitely off, and only then dynamically imports
 * `./hook.js` and calls its exported `main`, so the whole graph above loads exactly when it might be needed.
 *
 * "Definitely off" is the only fast path, and it is conservative on purpose: a config file this cannot read or parse,
 * or any mode other than the literal 'off', falls through to `hook.js` so the tested error handling there is what
 * runs it, not a second copy of it here. A wrong "not off" costs one extra dynamic import; a wrong "off" would
 * silently disable the gate, which is why only the unambiguous case takes the shortcut.
 */
export const isDefinitelyOff = (env: Env): boolean => {
  const loaded = loadConfig(env);
  return loaded.ok && loaded.config.mode === 'off';
};

/**
 * The host still wrote a hook request to stdin before this process could know it would be a no-op. Draining it
 * (never buffering it -- each chunk is dropped as it arrives) is what `runHook`'s own `readAll` already does before
 * its own `JEV_GATE_MODE === 'off'` check, so this matches that, not a new behavior, and keeps a large write from
 * blocking or EPIPEing the host for a request nobody is going to read.
 */
const drainStdin = async (stdin: AsyncIterable<Uint8Array | string>): Promise<void> => {
  for await (const _chunk of stdin) {
    // Discarded on purpose.
  }
};

export const run = async (): Promise<void> => {
  if (isDefinitelyOff(process.env)) {
    await drainStdin(process.stdin);
    // Matches runHook's own skip('mode_off')/preserve('mode_off'): no stdout, this stderr line, exit 0.
    process.stderr.write('jev-gate: mode_off\n');
    process.exitCode = 0;
    return;
  }
  const { main } = await import('./hook.js');
  await main();
};

const isMainModule = (): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMainModule()) void run();
