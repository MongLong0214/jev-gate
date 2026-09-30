import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Separate from Claude logs, independent of the plugin installation/cache directory. */
export const codexTraceDir = (env: Readonly<Record<string, string | undefined>>): string => {
  const configured = env['JEV_CODEX_TRACE_DIR'] ?? env['JEV_GATE_TRACE_DIR'];
  if (configured !== undefined) {
    if (!configured || !isAbsolute(configured)) throw new Error('JEV_CODEX_TRACE_DIR / JEV_GATE_TRACE_DIR must be an absolute directory');
    return configured;
  }
  const state = env['XDG_STATE_HOME'];
  return join(state && isAbsolute(state) ? state : join(homedir(), '.local', 'state'), 'jev-gate', 'codex', 'traces');
};
