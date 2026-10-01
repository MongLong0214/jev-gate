import { validKey } from './config.ts';

/** Pure data helpers: the Function Hooks host forbids passing $ across an imported function. */
export const installedKeyPath = (home: string | undefined, config: string | undefined): string | undefined => {
  const base = config ?? (home ? `${home}/.config` : undefined);
  return base && (base.startsWith('/') || /^[A-Za-z]:[\\/]/.test(base)) ? `${base}/jev-gate/auth/credentials.json` : undefined;
};
export const parseInstalledKey = (text: string): string | undefined => {
  try {
    const raw: unknown = JSON.parse(text);
    const key = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)['apiKey'] : undefined;
    return typeof key === 'string' && validKey(key) ? key : undefined;
  } catch { return undefined; }
};
