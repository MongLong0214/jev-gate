import { spawn } from 'node:child_process';
import type { Env } from './config.js';
import { MODEL_FACTS, factsOf, sameIdentity, splitModelId, type SymbolicEffort } from './claude-models.js';
import type { DoctorCheck } from './doctor.js';

export interface HostModel { id: string; alias?: string; efforts: string[] | null }
export interface ModelInventory { models: HostModel[]; complete: boolean; error: 'unavailable' | 'timeout' | 'invalid_response' | null }
export const missingInventory = (): ModelInventory => ({ models: [], complete: false, error: 'unavailable' });
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Claude's SDK initialize response is a CLI capability inventory, not a paid model request. */
export const parseClaudeInventory = (value: unknown): ModelInventory => {
  if (!Array.isArray(value) || value.length > 256) return { models: [], complete: false, error: 'invalid_response' };
  const models: HostModel[] = []; const ids = new Set<string>(); const conflicts = new Set<string>(); let invalid = false;
  for (const row of value) {
    if (!record(row) || typeof row['value'] !== 'string' || !/^[A-Za-z0-9._:\/@\[\]-]{1,160}$/.test(row['value'])) { invalid = true; continue; }
    if (row['resolvedModel'] !== undefined && typeof row['resolvedModel'] !== 'string' || row['supportsEffort'] !== undefined && typeof row['supportsEffort'] !== 'boolean') { invalid = true; continue; }
    const id = typeof row['resolvedModel'] === 'string' ? row['resolvedModel'] : row['value'];
    if (!/^[A-Za-z0-9._:\/@\[\]-]{1,160}$/.test(id)) { invalid = true; continue; }
    const raw = row['supportedEffortLevels'];
    if (raw !== undefined && (!Array.isArray(raw) || raw.some(e => typeof e !== 'string' || !/^[a-z]{1,24}$/.test(e)) || new Set(raw).size !== raw.length || row['supportsEffort'] === false && raw.length > 0)) { invalid = true; continue; }
    const efforts = row['supportsEffort'] === false ? [] : Array.isArray(raw) && raw.every(e => typeof e === 'string' && /^[a-z]{1,24}$/.test(e)) ? raw as string[] : null;
    const key = row['value'];
    if (ids.has(key)) { invalid = true; conflicts.add(id); for (const previous of models.filter(m => m.alias === key)) conflicts.add(previous.id); } ids.add(key);
    const prior = models.find(m => m.id === id || sameIdentity(m.id, id));
    if (prior && JSON.stringify(prior.efforts?.slice().sort() ?? null) !== JSON.stringify(efforts?.slice().sort() ?? null)) { invalid = true; conflicts.add(id); conflicts.add(prior.id); }
    models.push({ id, alias: row['value'], efforts });
  }
  const safe = models.filter(m => !conflicts.has(m.id) && ![...conflicts].some(id => sameIdentity(id, m.id)));
  return { models: safe, complete: !invalid && safe.length > 0, error: !invalid && safe.length ? null : 'invalid_response' };
};
export const claudeModelInventory = (env: Env, cwd: string): Promise<ModelInventory> => new Promise(resolve => {
  const child = spawn('claude', ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  let done = false, size = 0, buffered = '';
  const finish = (value: ModelInventory): void => { if (done) return; done = true; clearTimeout(timer); child.stdin.destroy(); child.kill(); resolve(value); };
  const timer = setTimeout(() => finish({ models: [], complete: false, error: 'timeout' }), 4000);
  child.on('error', () => finish(missingInventory())); child.stdin.on('error', () => finish(missingInventory()));
  child.on('close', () => finish(missingInventory()));
  child.stdout.on('data', chunk => {
    size += chunk.length; if (size > 512 * 1024) { finish({ models: [], complete: false, error: 'invalid_response' }); return; }
    buffered += chunk.toString(); let end: number;
    while ((end = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
      try { const row: unknown = JSON.parse(line); if (!record(row) || row['type'] !== 'control_response' || !record(row['response']) || row['response']['request_id'] !== 'jev-doctor-models') continue;
        const response = row['response']; finish(response['subtype'] === 'success' && record(response['response']) ? parseClaudeInventory(response['response']['models']) : missingInventory());
      } catch { finish({ models: [], complete: false, error: 'invalid_response' }); }
    }
  });
  child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'jev-doctor-models', request: { subtype: 'initialize' } }) + '\n');
});
export interface ModelCompatibility { model: string; resolved: string | null; requestedEfforts: string[]; hostEfforts: string[] | null; unsupportedEfforts: string[]; state: 'compatible' | 'incompatible' | 'unverified' | 'excluded'; reason: string }
export const claudeCompatibility = (inventory: ModelInventory, version: string | null, configured: readonly { model: string; effort?: SymbolicEffort | null }[], allowFable: boolean): ModelCompatibility[] => {
  const requested = new Map<string, Set<string>>();
  for (const f of MODEL_FACTS.filter(f => !f.legacy)) requested.set(f.ids[0]!, new Set(f.unconditionalEffort));
  for (const row of configured) { const set = requested.get(row.model) ?? new Set<string>(); if (row.effort) set.add(row.effort); requested.set(row.model, set); }
  const hostVersion = version && /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const supportedHost = (minimum: number | undefined): boolean | null => !minimum ? null : !hostVersion ? null : Number(hostVersion[1]) > 2 || Number(hostVersion[1]) === 2 && (Number(hostVersion[2]) > 1 || Number(hostVersion[2]) === 1 && Number(hostVersion[3]) >= minimum);
  return [...requested].map(([model, effortSet]) => {
    const alias = ['haiku', 'sonnet', 'opus', 'fable'].includes(model) ? model : null;
    const facts = factsOf(model) ?? (alias ? MODEL_FACTS.find(f => f.family === alias && !f.legacy) : null);
    const minimum = facts?.minimumHostRelease;
    const found = inventory.models.find(m => m.id === model || sameIdentity(model, m.id) || alias !== null && m.alias === alias);
    const baseOnly = !found && facts && splitModelId(model).suffix ? inventory.models.find(m => factsOf(m.id) === facts && splitModelId(m.id).suffix === '') : undefined;
    const efforts = [...effortSet]; const unsupported = found?.efforts ? efforts.filter(e => !found.efforts!.includes(e)) : [];
    let state: ModelCompatibility['state'] = 'unverified', reason = 'CLI inventory unavailable or incomplete';
    if (facts?.family === 'fable' && !allowFable && !configured.some(c => c.model === model)) { state = 'excluded'; reason = 'automatic Fable selection is off'; }
    else if (facts?.legacy) { state = 'incompatible'; reason = 'retired model is not a new automatic routing target'; }
    else if (supportedHost(minimum) === false) { state = 'incompatible'; reason = `requires Claude Code 2.1.${minimum} or newer; run claude update`; }
    else if (inventory.error !== null) { reason = 'CLI inventory is unavailable or invalid; conflicting capabilities remain unverified'; }
    else if (baseOnly) { reason = 'CLI advertises the base model but not this context variant; variant support remains unverified'; }
    else if (!found && inventory.complete) { state = 'incompatible'; reason = 'model is absent from this CLI capability inventory (account access is separately unverified)'; }
    else if (found && alias && facts && !sameIdentity(facts.ids[0]!, found.id)) { state = 'incompatible'; reason = `alias resolves to ${found.id}; expected the current ${facts.ids[0]}`; }
    else if (unsupported.length) { state = 'incompatible'; reason = `CLI does not advertise effort: ${unsupported.join(', ')}`; }
    else if (found && found.efforts !== null && inventory.error === null) { state = 'compatible'; reason = 'CLI advertises this model and all offered efforts; provider/account execution remains unverified'; }
    return { model, resolved: found?.id ?? null, requestedEfforts: efforts, hostEfforts: found?.efforts ?? null, unsupportedEfforts: unsupported, state, reason };
  });
};
export const compatibilityChecks = (rows: readonly ModelCompatibility[]): DoctorCheck[] => rows.map((row, i) => ({
  id: `models.${i + 1}`, group: 'models', level: row.state === 'incompatible' ? 'fail' : row.state === 'unverified' ? 'warn' : row.state === 'excluded' ? 'info' : 'ok',
  message: `${row.model}${row.resolved && row.resolved !== row.model ? ` → ${row.resolved}` : ''}: ${row.state}; route efforts=${row.requestedEfforts.join(',') || 'inherit'}; CLI efforts=${row.hostEfforts?.join(',') ?? 'unknown'}; ${row.reason}`,
  action: row.state === 'incompatible' ? 'Update the native CLI or correct the unavailable model/effort mapping. Do not replace it with a retired model.' : row.state === 'unverified' ? 'Check the native /model list and restrictions; rerun doctor in the same CLI environment.' : null,
}));
