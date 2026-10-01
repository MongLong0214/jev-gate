import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { validateConfig, type Env } from '../config.js';
import type { ConfigV5, Tier } from '../types.js';
import type { CodexModel } from './router.js';

export interface CodexPolicyConfig {
  gate: ConfigV5;
  router: { enabled: boolean; model: boolean; effort: boolean; minUpgradeConfidence: number; minDowngradeConfidence: number; timeoutMs: number };
  compact: { enabled: boolean; manual: boolean; budgetChars: number };
}
export const catalogTierModels = (baseline: string, catalog: readonly CodexModel[]): Record<Tier, string> => {
  // Use this account's model descriptions, never invented IDs or hidden specialist/review models.
  const general = catalog.filter(m => !m.hidden && !/cybersecurity|automatic.*review|specialist/i.test(m.description ?? ''));
  const pick = (pattern: RegExp, fallback: string): string => general.find(m => pattern.test(m.description ?? ''))?.model ?? fallback;
  const deep = general.some(m => m.model === baseline && /workhorse|coding.*reasoning|reasoning.*coding/i.test(m.description ?? ''))
    ? baseline : pick(/latest.*workhorse|most.*capable.*coding|advanced.*reasoning/i, baseline);
  const standard = general.find(m => m.isDefault)?.model ?? pick(/balanced|everyday|workhorse/i, deep);
  return { fast: pick(/fast|efficient|affordable|easier|lightweight/i, standard), standard, deep,
    frontier: pick(/frontier|most demanding|most intelligent/i, deep) };
};
export const loadCodexPolicy = (env: Env, catalog: readonly CodexModel[] = []): CodexPolicyConfig => {
  let raw: Record<string, unknown> = {};
  const path = env['JEV_CODEX_CONFIG'] ?? join(env['XDG_CONFIG_HOME'] ?? join(env['HOME'] || homedir(), '.config'), 'jev-gate', 'codex.json');
  try { raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; }
  catch (e) { if (env['JEV_CODEX_CONFIG'] || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('invalid Codex policy config'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !['gate', 'router', 'compact'].includes(k))) throw new Error('invalid Codex policy config');
  const gateRaw = raw['gate'] ?? {};
  if (!gateRaw || typeof gateRaw !== 'object' || Array.isArray(gateRaw)) throw new Error('invalid Codex gate config');
  // Session creation supplies the actual native model. Before that, this placeholder is never dispatched.
  // Never run Claude aliases in Codex or guess what models the current account can execute.
  const baseline = env['JEV_CODEX_MODEL'] ?? 'native-session-model';
  const models = catalogTierModels(baseline, catalog);
  const checked = validateConfig({ version: 5, mode: 'auto', ...gateRaw, ...(env['JEV_GATE_MODE'] ? { mode: env['JEV_GATE_MODE'] } : {}), models: { ...models, ...(gateRaw as Record<string, unknown>)['models'] as object } });
  if (!checked.ok) throw new Error('invalid Codex gate config');
  const section = (key: string, defaults: Record<string, unknown>): Record<string, unknown> => {
    const v = raw[key] ?? {};
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !(k in defaults))) throw new Error(`invalid Codex ${key} config`);
    const out = { ...defaults, ...v };
    for (const k of Object.keys(defaults)) if (typeof out[k] !== typeof defaults[k]) throw new Error(`invalid Codex ${key} config`);
    return out;
  };
  const router = section('router', { enabled: true, model: true, effort: true, minUpgradeConfidence: 0.8, minDowngradeConfidence: 0.6, timeoutMs: 800 }) as unknown as CodexPolicyConfig['router'];
  const compact = section('compact', { enabled: true, manual: true, budgetChars: 40000 }) as unknown as CodexPolicyConfig['compact'];
  if (![router.minUpgradeConfidence, router.minDowngradeConfidence].every(n => Number.isFinite(n) && n > .5 && n <= 1) || !Number.isInteger(router.timeoutMs) || router.timeoutMs < 50 || router.timeoutMs > 3500 || !Number.isInteger(compact.budgetChars) || compact.budgetChars < 8000 || compact.budgetChars > 400000) throw new Error('invalid Codex policy bounds');
  return { gate: checked.config, router, compact };
};
