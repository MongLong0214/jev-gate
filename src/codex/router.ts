import { randomUUID } from 'node:crypto';
import { offerPairs, selectPair, keepModelPair, pairReceipt, type PairPatch, type RouteCandidate } from '../../mods/router/hooks/selection.ts';
import { routingContext, type RoutingCache } from '../../mods/router/hooks/context.ts';
import { looksSecret } from '../../mods/router/hooks/secret.ts';
import { MAX_REQUEST_TOKENS, estimateTokens } from '../../mods/router/hooks/client.ts';
import { callJev } from '../jev.js';
import { routeCost } from '../route-cost.js';
import type { ModelCache } from '../cost.js';
import type { Env } from '../config.js';
import type { TraceWriter } from '../trace.js';
import type { CodexPolicyConfig } from './config.js';
import { codexTargetAllowed, generalCodexModel, normalizeCatalog, codexModelRole } from './catalog.js';

export interface CodexModel {
  model: string; displayName?: string; description?: string; isDefault?: boolean; hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
  inputModalities?: string[];
  capabilities?: unknown;
  [key: string]: unknown;
}
const supported = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const codexCandidates = (catalog: readonly CodexModel[], allowAstra: boolean, baseline?: string): RouteCandidate[] =>
  normalizeCatalog(catalog, true).models.filter(m => m.model === baseline || generalCodexModel(m) && codexTargetAllowed(m.model, allowAstra)).map(m => {
    const role = codexModelRole(m);
    return {
      id: m.model, description: ((m.description ?? m.displayName ?? 'Account-listed coding model; performance and price rank unknown.') +
        (role ? ` Product role ${role.description}` : '')).slice(0, 1200),
      ...(role ? { rank: role.rank } : {}),
      efforts: supported.filter(e => m.supportedReasoningEfforts.some(v => v.reasoningEffort === e)),
      omitEffort: true,
    };
  });

/** Actual candidate IDs and their own effort contracts; one bounded POST, independent of optional recording. */
export const routeCodex = async (args: {
  model: string; effort: string | null; task: string; previousReply?: string; recentRequests?: readonly string[]; session: string; prompt: string;
  modelPinned?: boolean; effortPinned?: boolean; catalog: CodexModel[]; catalogComplete?: boolean; catalogExcluded?: Record<string, number>; config: CodexPolicyConfig; env: Env; trace?: TraceWriter; signal?: AbortSignal; fetchImpl?: typeof fetch;
  cache?: RoutingCache; modelCache?: ModelCache; epoch?: string;
  child?: { agentId: string; step: number; context: unknown };
}): Promise<PairPatch> => {
  const { config, env, signal } = args;
  const write = (event: Parameters<TraceWriter['write']>[0], facts: Record<string, unknown>): void => { try { args.trace?.write(event, facts); } catch { /* Optional diagnostics cannot change a request. */ } };
  const facts = { host: 'codex', mode: config.gate.mode, component: 'router', session_id: args.session, prompt_id: args.prompt };
  const skip = (reason: string): PairPatch => { write('codex_router_skipped', { ...facts, known_not_sent: true, attempted: false, reason }); return {}; };
  if (env['JEV_CODEX_ENABLED'] === '0') return skip('disabled');
  if (!config.router.enabled) return skip('router_disabled');
  if (!env['TYPESAFE_API_KEY']) return skip('key_missing');
  if (signal?.aborted) return skip('aborted');
  if (looksSecret(args.task)) return skip('input_secret');
  const candidates = codexCandidates(args.catalog, config.router.allowAstra, args.model);
  const modelPin = args.modelPinned === true; const effortPin = args.effortPinned === true;
  const offer = offerPairs({ baseline: { model: args.model, effort: args.effort }, candidates,
    ...(args.child ? { scope: 'child' as const } : {}), model: config.router.model && !modelPin, effort: config.router.effort && !effortPin,
    upgrade: config.router.minUpgradeConfidence, downgrade: config.router.minDowngradeConfidence });
  if (!offer) return skip('no_alternative');
  const request = { model: config.gate.jevModel, state: args.child ? { task: { text: args.task, source: 'child_contract', truncated: false }, execution: { scope: 'child', step_index: args.child.step, context: args.child.context, cache: args.cache ?? { source: 'unknown' } } } : routingContext(args.task, args.previousReply, args.recentRequests, args.cache), questions: offer.questions };
  if (estimateTokens(JSON.stringify(request)) > MAX_REQUEST_TOKENS) return skip('input_too_large');
  const requestId = randomUUID();
  const diagnostic = { ...facts, request_id: requestId, baseline_model: args.model, baseline_effort: args.effort,
    scope: args.child ? 'child' : 'root', ...(args.child ? { agent_id: args.child.agentId, index: args.child.step } : {}), excluded: { ...args.catalogExcluded,
      astra_disabled_by_config: args.catalog.filter(m => m.model !== args.model && !codexTargetAllowed(m.model, config.router.allowAstra)).length,
      ineligible: args.catalog.filter(m => m.model !== args.model && !generalCodexModel(m)).length },
    discovered_count: args.catalog.length, eligible_count: candidates.length, offered_count: offer.candidates.length, catalog_complete: args.catalogComplete ?? true,
    model_asked: offer.modelAsked, effort_asked: offer.effortQuestions.size > 0, allow_astra: config.router.allowAstra, model_pin: modelPin, effort_pin: effortPin,
    model_enabled: config.router.model, effort_enabled: config.router.effort,
    model_not_asked: offer.modelAsked ? null : modelPin ? 'model_pinned' : !config.router.model ? 'routing_off' : 'no_alternative',
    effort_not_asked: offer.effortQuestions.size ? null : effortPin ? 'effort_pinned' : !config.router.effort ? 'routing_off' : 'no_alternative' };
  write('codex_router_intent', { ...diagnostic, asked: Object.keys(offer.questions), attempted: true });
  const out = await callJev(request, { apiKey: env['TYPESAFE_API_KEY'], deadlineMs: config.router.timeoutMs, ...(signal ? { signal } : {}), ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) });
  const decision = out.ok && out.response.model === config.gate.jevModel && !signal?.aborted ? selectPair(offer, out.response.answers) : { patch: {} as PairPatch, reasons: { model: 'not_asked', effort: 'not_asked' }, diagnostics: null };
  const cost = decision.patch.model ? routeCost('codex', args.model, decision.patch.model, args.modelCache, args.epoch ?? '', Date.now()) : null;
  const baseRank = offer.baselineCandidate?.rank, targetRank = offer.candidates.find(c => c.id === decision.patch.model)?.rank;
  const hold = cost?.hold && baseRank !== undefined && targetRank !== undefined && targetRank < baseRank;
  if (hold && out.ok) { decision.patch = keepModelPair(offer, out.response.answers).patch; decision.reasons.model = 'cost_hold'; }
  write('codex_router_result', { ...diagnostic, attempted: true, duration_ms: out.durationMs, ok: out.ok,
    reason: out.ok ? signal?.aborted ? 'aborted' : out.response.model !== config.gate.jevModel ? 'model_mismatch' : null : out.code,
    http: { duration_ms: out.durationMs, code: out.ok ? 'ok' : out.code }, jev: out.ok ? { model: out.response.model, usage: out.response.usage } : null,
    selected_model: decision.patch.model ?? args.model, selected_effort: decision.patch.effort ?? (decision.patch.effortEdit?.kind === 'omit' ? null : args.effort), effort_edit: decision.patch.effortEdit ?? { kind: 'keep' },
    cost, reasons: decision.reasons, selection: decision.diagnostics, answers: out.ok ? pairReceipt(offer, out.response.answers) : {}, ...(out.ok ? { usage: out.response.usage, returned_model: out.response.model } : {}), applied: false });
  return decision.patch;
};
