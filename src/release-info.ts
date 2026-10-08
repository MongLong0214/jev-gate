import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RELEASE_SOURCE = 'https://api.github.com/repos/MongLong0214/jev-gate/releases/latest';
export const RELEASE_PAGE = 'https://github.com/MongLong0214/jev-gate/releases/latest';
export interface ReleaseInfo {
  latest: string | null;
  checkedAt: string | null;
  source: string;
  error: 'offline' | 'rate_limited' | 'invalid_response' | null;
}
export const unknownRelease = (): ReleaseInfo => ({ latest: null, checkedAt: null, source: RELEASE_PAGE, error: null });
const parts = (value: unknown): number[] | null => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const values = value.split('.').map(Number);
  return values.every(Number.isSafeInteger) ? values : null;
};
export const compareVersions = (a: string | null, b: string | null): number | null => {
  const x = parts(a), y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
};
export const packageVersion = (root: string, host?: 'claude' | 'codex'): string | null => {
  for (const kind of host ? [host === 'claude' ? '.claude-plugin' : '.codex-plugin'] : ['.codex-plugin', '.claude-plugin']) {
    try { const value: unknown = JSON.parse(readFileSync(join(root, kind, 'plugin.json'), 'utf8')); const version = value && typeof value === 'object' && 'version' in value ? value.version : null; if (parts(version)) return version as string; }
    catch { /* Missing or invalid metadata is unknown. */ }
  }
  return null;
};
/** Fixed public endpoint, no credentials or local metadata. Body and headers share one deadline. */
export const checkRelease = async (request: typeof fetch = fetch, now: () => number = Date.now): Promise<ReleaseInfo> => {
  const info = { ...unknownRelease(), checkedAt: new Date(now()).toISOString() };
  try {
    const reply = await request(RELEASE_SOURCE, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'jev-gate-version-check' }, redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!reply.ok) { await reply.body?.cancel(); return { ...info, error: reply.status === 403 || reply.status === 429 ? 'rate_limited' : 'offline' }; }
    const reader = reply.body?.getReader(); if (!reader) return { ...info, error: 'invalid_response' };
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 64 * 1024) { await reader.cancel(); return { ...info, error: 'invalid_response' }; } chunks.push(chunk.value); } }
    finally { reader.releaseLock(); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const latest = typeof value?.['tag_name'] === 'string' ? value['tag_name'].replace(/^v/, '') : null;
    if (!parts(latest) || value['draft'] !== false || value['prerelease'] !== false || value['html_url'] !== `https://github.com/MongLong0214/jev-gate/releases/tag/v${latest}`) return { ...info, error: 'invalid_response' };
    return { ...info, latest, error: null };
  } catch { return { ...info, error: 'offline' }; }
};
/** A dashboard shares one in-flight check; failures never become a claim of being current. */
export const releaseChecker = (request: typeof fetch = fetch, now: () => number = Date.now) => {
  let result = unknownRelease(), expires = 0, pending: Promise<ReleaseInfo> | null = null;
  return { current: () => result, refresh: (): Promise<ReleaseInfo> => {
    if (pending) return pending;
    if (now() < expires) return Promise.resolve(result);
    pending = checkRelease(request, now).then(value => { result = value; expires = now() + (value.error ? 30_000 : 300_000); return value; }).finally(() => { pending = null; });
    return pending;
  } };
};
