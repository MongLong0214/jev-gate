export interface OutputConfig {
  enabled: boolean;
}

export type OutputConfigResult = { ok: true; config: OutputConfig } | { ok: false; field: string };

type Options = Readonly<Record<string, unknown>>;

/** A wrong type turns the module off rather than guessing; the diagnostic names the field only. */
export const resolveOutputConfig = (options: Options | undefined): OutputConfigResult => {
  const o = options ?? {};
  const enabled = o['enabled'] === undefined ? false : o['enabled'];
  if (typeof enabled !== 'boolean') return { ok: false, field: 'enabled' };
  return { ok: true, config: { enabled } };
};
