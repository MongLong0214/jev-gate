import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';

export const CODEX_SANDBOX_META = 'codex/sandbox-state-meta';
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Advertised MCP capability asks Codex to supply its captured sandbox cwd, independently of tool arguments. */
export const codexCallerWorkspace = (meta: unknown): { session: string; cwd: string } | null => {
  const m = object(meta);
  const session = m?.['threadId'];
  const uri = object(m?.[CODEX_SANDBOX_META])?.['sandboxCwd'];
  if (typeof session !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(session) || typeof uri !== 'string' || uri.length > 16 * 1024) return null;
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:' || url.hostname || url.search || url.hash) return null;
    const cwd = fileURLToPath(url);
    return isAbsolute(cwd) && !cwd.includes('\0') ? { session, cwd } : null;
  } catch { return null; }
};
