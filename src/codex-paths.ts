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

export const codexHome = (env: Readonly<Record<string, string | undefined>>): string => {
  const path = env['CODEX_HOME'] ?? join(env['HOME'] ?? homedir(), '.codex');
  if (!isAbsolute(path)) throw new Error('Codex home must be absolute');
  return path;
};
/** Here so doctor can find the connection owner without loading the connection module and its WebSocket server. */
export const codexConnectionOwnerPath = (env: Readonly<Record<string, string | undefined>>): string => join(codexHome(env), 'jev-gate', 'connection', 'owner.json');
