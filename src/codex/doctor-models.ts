import { spawn } from 'node:child_process';
import type { Env } from '../config.js';
import { missingInventory, type ModelInventory, type ModelCompatibility } from '../doctor-models.js';
import { OWNED_AGENT_PROFILES } from '../agents.js';
import { CodexRpc } from './rpc.js';
import { normalizeCatalog, generalCodexModel, codexTargetAllowed } from './catalog.js';
import { codexCandidates, type CodexModel } from './router.js';
import { loadCodexPolicy } from './config.js';

export interface CodexInventory extends ModelInventory { catalog: CodexModel[] }
/** Only initialize/model-list RPCs; no thread, turn, login, provider write or permission grant. */
export const codexModelInventory = async (env: Env, cwd: string): Promise<CodexInventory> => {
  const child = spawn('codex', ['app-server', '--stdio'], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  const rpc = new CodexRpc(child.stdout, child.stdin);
  child.on('error', () => rpc.close()); child.stdin.on('error', () => rpc.close());
  let size = 0; child.stdout.on('data', chunk => { size += chunk.length; if (size > 512 * 1024) { rpc.close(); child.kill(); } });
  const raw: unknown[] = [], cursors = new Set<string>(); let complete = false;
  const deadline = Date.now() + 4000, timer = setTimeout(() => { rpc.close(); child.kill(); }, 4000);
  try {
    await rpc.request('initialize', { clientInfo: { name: 'jev-gate-doctor', version: '1' }, capabilities: { experimentalApi: true } }, Math.max(1, deadline - Date.now()));
    rpc.send({ method: 'initialized' });
    let cursor: string | null = null;
    for (let page = 0; page < 20 && Date.now() < deadline; page++) {
      const result = await rpc.request('model/list', { includeHidden: true, ...(cursor ? { cursor } : {}) }, Math.max(1, deadline - Date.now()));
      if (!Array.isArray(result['data'])) break;
      raw.push(...result['data']);
      const next = result['nextCursor']; if (next === null || next === undefined || next === '') { complete = true; break; }
      if (typeof next !== 'string' || cursors.has(next)) break; cursors.add(next); cursor = next;
    }
  } catch { /* Completed pages remain usable; absent targets in an incomplete list stay unknown. */ }
  finally { clearTimeout(timer); rpc.close(); child.stdin.destroy(); child.kill(); }
  const parsed = normalizeCatalog(raw, complete);
  const valid = parsed.complete && Object.keys(parsed.excluded).length === 0 && parsed.models.length > 0;
  return { catalog: parsed.models, models: parsed.models.map(m => ({ id: m.model, efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort) })), complete: valid,
    error: valid ? null : raw.length ? 'invalid_response' : missingInventory().error };
};
export const codexCompatibility = (inventory: CodexInventory, env: Env): ModelCompatibility[] => {
  const policy = loadCodexPolicy(env, inventory.catalog);
  const candidates = codexCandidates(inventory.catalog, policy.router.allowAstra);
  const targets = new Map(candidates.map(c => [c.id, c.efforts.filter(e => !['ultra', 'ultracode', 'auto', 'ultrafast'].includes(e))]));
  for (const model of Object.values(policy.gate.models)) if (model !== 'native-session-model' && !targets.has(model)) targets.set(model, []);
  if (policy.gate.mode !== 'lean') for (const profile of OWNED_AGENT_PROFILES) { const model = policy.gate.models[profile.tier]; if (profile.effort && model !== 'native-session-model') { const efforts = targets.get(model) ?? []; if (!efforts.includes(profile.effort)) targets.set(model, [...efforts, profile.effort]); } }
  return [...targets].map(([model, efforts]) => {
    const found = inventory.catalog.find(m => m.model === model);
    const unsupported = found ? efforts.filter(e => !found.supportedReasoningEfforts.some(v => v.reasoningEffort === e)) : [];
    const state: ModelCompatibility['state'] = !found ? inventory.complete ? 'incompatible' : 'unverified' : !generalCodexModel(found) || !codexTargetAllowed(model, policy.router.allowAstra) ? 'excluded' : unsupported.length ? 'incompatible' : 'compatible';
    return { model, resolved: found?.model ?? null, requestedEfforts: [...efforts], hostEfforts: found?.supportedReasoningEfforts.map(e => e.reasoningEffort) ?? null, unsupportedEfforts: unsupported, state,
      reason: state === 'compatible' ? 'native model/list advertises all routing efforts; provider/account execution remains unverified' : state === 'excluded' ? 'hidden, specialist, retired or frontier opt-in policy excludes this automatic target' : state === 'incompatible' ? unsupported.length ? `configured owned profile effort not advertised: ${unsupported.join(', ')} (runtime preserves or inherits a valid native effort)` : 'configured target absent from complete native model/list' : 'catalog unavailable or incomplete; absent target is unverified' };
  });
};
