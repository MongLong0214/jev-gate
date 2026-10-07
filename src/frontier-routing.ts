/** Shared opt-in in the ordinary Jev config; host-specific settings remain legacy fallbacks. */
export const frontierConfigPath = (home?: string, configHome?: string, override?: string): string | undefined => {
  const base = configHome || (home ? `${home}/.config` : undefined);
  return override || (base ? `${base}/jev-gate/config.json` : undefined);
};

export const parseFrontierRouting = (text: string): boolean | undefined => {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const value = (raw as Record<string, unknown>)['frontierEnabled'];
    return value === undefined ? undefined : typeof value === 'boolean' ? value : false;
  } catch { return false; }
};
