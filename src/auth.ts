/** Strict `claude auth status` parser shared by doctor and the benchmark preflight (#14 §5). */

export interface CommandResult {
  status: number | null;
  signal: string | null;
  stdout: string;
  error: string | null;
}

export interface AuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  subscriptionType: string | null;
}

export type AuthParse = { ok: true; status: AuthStatus } | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Requires normal termination (exit 0, no signal, no spawn error) and a JSON object; anything else is unverified. */
export const parseAuthStatus = (r: CommandResult): AuthParse => {
  if (r.error) return { ok: false, reason: `auth status command failed to run: ${r.error}` };
  if (r.signal) return { ok: false, reason: `auth status command was terminated by ${r.signal}` };
  if (r.status !== 0) return { ok: false, reason: `auth status command exited ${String(r.status)}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { ok: false, reason: 'auth status output is not JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, reason: 'auth status output is not a JSON object' };
  if (typeof parsed['loggedIn'] !== 'boolean') return { ok: false, reason: 'auth status has no boolean loggedIn' };
  const str = (k: string): string | null => (typeof parsed[k] === 'string' ? (parsed[k] as string) : null);
  return { ok: true, status: { loggedIn: parsed['loggedIn'], authMethod: str('authMethod'), apiProvider: str('apiProvider'), subscriptionType: str('subscriptionType') } };
};

/** The supported MVP condition: official Claude.ai subscription login served first-party. */
export const isSubscriptionOAuth = (s: AuthStatus): boolean => s.loggedIn && s.authMethod === 'claude.ai' && s.apiProvider === 'firstParty';

export const AUTH_CONFLICT_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'] as const;

/**
 * A concrete CLAUDE_CODE_SUBAGENT_MODEL value overrides owned-role models; the documented `inherit` value is treated as unset
 * from v2.1.196 and is therefore harmless. FORCE=1 makes any value (or the main model) override everything.
 */
export const subagentModelOverride = (env: Record<string, string | undefined>): { concrete: boolean; force: boolean; value: string | null } => {
  const raw = env['CLAUDE_CODE_SUBAGENT_MODEL'];
  const value = raw && raw.trim().length > 0 ? raw.trim() : null;
  const force = env['CLAUDE_CODE_SUBAGENT_MODEL_FORCE'] === '1';
  return { concrete: value !== null && value !== 'inherit', force, value };
};
