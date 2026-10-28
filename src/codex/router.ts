import { randomUUID } from 'node:crypto';
import { offerRoute, selectPair, keepModelPair, pairReceipt, type PairPatch, type RouteCandidate } from '../../mods/router/hooks/selection.ts';
import { routingContext, type RoutingCache } from '../../mods/router/hooks/context.ts';
import { looksSecret } from '../../mods/router/hooks/secret.ts';
import { MAX_REQUEST_TOKENS, estimateTokens } from '../../mods/router/hooks/client.ts';
import { callJev } from '../jev.js';
import { costHold } from '../route-cost.js';
import { codexRouteCost, type CodexBilling } from './route-cost.js';
import type { ModelCache } from '../cost.js';
import type { Env } from '../config.js';
import type { TraceWriter } from '../trace.js';
import type { CodexPolicyConfig } from './config.js';
import { codexSuccessor, codexTargetAllowed, generalCodexModel, normalizeCatalog, codexModelRole } from './catalog.js';

export interface CodexModel {
  model: string; displayName?: string; description?: string; isDefault?: boolean; hidden?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
  inputModalities?: string[];
  capabilities?: unknown;
  [key: string]: unknown;
}
const supported = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const codexCandidates = (catalog: readonly CodexModel[], allowAstra: boolean, baseline?: string): RouteCandidate[] => {
  const models = normalizeCatalog(catalog, true).models;
  // When Terra is available, let Luna serve quick work and Terra serve ordinary coding.
  // Without Terra, Luna retains its documented standard role.
  const terraAvailable = models.some(m => m.model === 'gpt-6.1-terra' && generalCodexModel(m) && !codexSuccessor(m.model, models));
  return models.filter(m => m.model === baseline || generalCodexModel(m) && codexTargetAllowed(m.model, allowAstra) && !codexSuccessor(m.model, models)).map(m => {
    const role = codexModelRole(m);
    const lunaFast = terraAvailable && m.model === 'gpt-6-luna';
    return {
      id: m.model, description: ((m.description ?? m.displayName ?? 'Account-listed coding model; performance and price rank unknown.') +
        (role ? ` Product role ${lunaFast ? 'fast: quick, checkable work; Terra serves ordinary coding when available.' : role.description}` : '')).slice(0, 1200),
      ...(role ? { rank: lunaFast ? 0 : role.rank } : {}),
      efforts: supported.filter(e => m.supportedReasoningEfforts.some(v => v.reasoningEffort === e)),
      omitEffort: true,
    };
  });
};

/** Actual candidate IDs and their own effort contracts; one bounded POST, independent of optional recording. */
export const routeCodex = async (args: {
  model: string; effort: string | null; task: string; previousReply?: string; recentRequests?: readonly string[]; session: string; prompt: string;
  modelPinned?: boolean; effortPinned?: boolean; catalog: CodexModel[]; catalogComplete?: boolean; catalogExcluded?: Record<string, number>; config: CodexPolicyConfig; env: Env; trace?: TraceWriter; signal?: AbortSignal; fetchImpl?: typeof fetch;
  cache?: RoutingCache; modelCache?: ModelCache; epoch?: string;
  billing?: CodexBilling; serviceTier?: unknown; cachePolicy?: unknown;
  child?: { agentId: string; step: number; context: unknown };
  continuation?: { step: number; context: unknown };
}): Promise<PairPatch> => {
  const { config, env, signal } = args;
  const write = (event: Parameters<TraceWriter['write']>[0], facts: Record<string, unknown>): void => { try { args.trace?.write(event, facts); } catch { /* Optional diagnostics cannot change a request. */ } };
  const facts = { host: 'codex', mode: config.gate.mode, component: 'router', session_id: args.session, prompt_id: args.prompt };
  const skip = (reason: string, patch: PairPatch = {}): PairPatch => { write('codex_router_skipped', { ...facts, known_not_sent: true, attempted: false, reason, ...(patch.model ? { superseded_baseline: { from: args.model, to: patch.model } } : {}) }); return patch; };
  if (env['JEV_CODEX_ENABLED'] === '0') return skip('disabled');
  if (!config.router.enabled) return skip('router_disabled');
  const modelPin = args.modelPinned === true; const effortPin = args.effortPinned === true;
  // A caller that fixed both keeps both: nothing is asked and no successor replaces the model.
  if (modelPin && effortPin) return skip('pinned');
  // A superseded baseline runs on its newest successor when that is a routable target for the same effort; this needs no Jev answer.
  const successor = config.router.model && !modelPin ? codexSuccessor(args.model, args.catalog) : null;
  const moved = successor && codexCandidates(args.catalog, config.router.allowAstra).some(c => c.id === successor && (args.effort === null ? c.omitEffort : c.efforts.includes(args.effort))) ? successor : null;
  const native: PairPatch = moved ? { model: moved } : {};
  const model = moved ?? args.model;
  if (!env['TYPESAFE_API_KEY']) return skip('key_missing', native);
  if (signal?.aborted) return skip('aborted');
  if (looksSecret(args.task)) return skip('input_secret', native);
  const candidates = codexCandidates(args.catalog, config.router.allowAstra, model);
  const offer = offerRoute({ baseline: { model, effort: args.effort }, candidates, prefer: Object.values(config.gate.models),
    ...(args.child ? { scope: 'child' as const } : args.continuation ? { scope: 'continuation' as const } : {}), model: config.router.model && !modelPin, effort: config.router.effort && !effortPin,
    upgrade: config.router.minUpgradeConfidence, downgrade: config.router.minDowngradeConfidence });
  if (!offer) return skip('no_alternative', native);
  // Codex replays the input for every tool round. Minimizing reasoning in isolation can increase total usage
  // through extra discovery, failed edits and repeated checks. Keep this objective in this adapter only.
  for (const [id, effort] of offer.effortQuestions) {
    const question = offer.questions[effort.name];
    if (question?.type !== 'score') continue;
    const candidate = normalizeCatalog(args.catalog, true).models.find(m => m.model === id);
    // The shared rubric names capability, while this conditional score must describe effort ON this model.
    // https://learn.chatgpt.com/docs/agent-configuration/subagents (2026-10-22) starts explicit Luna agents at high.
    if (id === 'gpt-6-luna') question.criteria = question.criteria.map((text, i) => effort.values[i] === 'medium'
      ? 'Ordinary reasoning for a bounded local change whose relevant context and execution path are already clear, without coordinating discovery, implementation and verification.'
      : effort.values[i] === 'high'
        ? 'Strong reasoning for a coherent coding plan that coordinates discovery, related implementation and verification or edge cases, even when requirements are clear; avoid fragmented tool rounds and repeated context.'
        : text);
    question.instructions = question.instructions
      .replace('Choose the lowest supported reasoning effort sufficient for this model to', 'Choose the supported reasoning effort that minimizes total tokens while enabling this model to') +
      ` This conditional effort answer is for the actual account candidate ${id}, not an abstract capability tier or a different model.${candidate?.defaultReasoningEffort ? ` Its account-listed default effort is ${candidate.defaultReasoningEffort}; this is a reference, not a floor or pin.` : ''}` +
      (id === 'gpt-6-luna' ? ' Official Codex agent guidance starts explicit GPT-6 Luna settings at high, then adjusts for the task. For implementation that needs coordinating discovery, code and tests, judge whether sufficient planning can avoid fragmented tool rounds; a routine capability label alone does not establish that low or medium effort is efficient. Mechanical lookup or a direct answer can still use lower effort.' : '') +
      ' Optimize successful completion of the full contract, including repeated input on every tool round, reasoning, tool calls and corrections. Lower effort can consume MORE total tokens when it causes repeated discovery, fragmented implementation or retries. Use enough reasoning to plan coherent edits and checks; do not lower effort merely because the model is cheaper. Native nonzero tool exit status is failure evidence, while completion alone is not success; distinguish a recovered failure from an unresolved one using the available progress. Do not assume a higher effort saves tokens without a concrete need. Missing outcome evidence stays unknown; preserve every required check and native permission.';
  }
  const state = args.child ? { task: { text: args.task, source: 'child_contract', truncated: false }, execution: { scope: 'child', step_index: args.child.step, context: args.child.context, cache: args.cache ?? { source: 'unknown' } } } : routingContext(args.task, args.previousReply, args.recentRequests, args.cache);
  const request = { model: config.gate.jevModel, state: args.continuation ? { ...state, execution: { ...state.execution, scope: 'root', step_index: args.continuation.step, context: args.continuation.context } } : state, questions: offer.questions };
  if (estimateTokens(JSON.stringify(request)) > MAX_REQUEST_TOKENS) return skip('input_too_large', native);
  const requestId = randomUUID();
  const diagnostic = { ...facts, request_id: requestId, baseline_model: args.model, baseline_effort: args.effort, ...(moved ? { superseded_baseline: { from: args.model, to: moved } } : {}),
    scope: args.child ? 'child' : 'root', ...(args.child ? { agent_id: args.child.agentId, index: args.child.step } : args.continuation ? { index: args.continuation.step } : {}), excluded: { ...args.catalogExcluded,
      astra_disabled_by_config: args.catalog.filter(m => m.model !== args.model && !codexTargetAllowed(m.model, config.router.allowAstra)).length,
      ineligible: args.catalog.filter(m => m.model !== args.model && !generalCodexModel(m)).length, superseded: args.catalog.filter(m => m.model !== model && codexSuccessor(m.model, args.catalog)).length },
    discovered_count: args.catalog.length, eligible_count: candidates.length, offered_count: offer.candidates.length, catalog_complete: args.catalogComplete ?? true,
    model_asked: offer.modelAsked, effort_asked: offer.effortQuestions.size > 0, allow_astra: config.router.allowAstra, model_pin: modelPin, effort_pin: effortPin,
    model_enabled: config.router.model, effort_enabled: config.router.effort,
    model_not_asked: offer.modelAsked ? null : modelPin ? 'model_pinned' : !config.router.model ? 'routing_off' : 'no_alternative',
    effort_not_asked: offer.effortQuestions.size ? null : effortPin ? 'effort_pinned' : !config.router.effort ? 'routing_off' : 'no_alternative' };
  write('codex_router_intent', { ...diagnostic, asked: Object.keys(offer.questions), attempted: true });
  const out = await callJev(request, { apiKey: env['TYPESAFE_API_KEY'], deadlineMs: config.router.timeoutMs, ...(signal ? { signal } : {}), ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}) });
  const decision = out.ok && out.response.model === config.gate.jevModel && !signal?.aborted ? selectPair(offer, out.response.answers) : { patch: {} as PairPatch, reasons: { model: 'not_asked', effort: 'not_asked' }, diagnostics: null };
  if (moved && !decision.patch.model) { decision.patch = { ...decision.patch, model: moved }; decision.reasons.model = 'superseded_baseline'; }
  // A thread not yet observed still has a conversation the next turn may return to.
  const cost = decision.patch.model && decision.patch.model !== moved ? codexRouteCost(model, decision.patch.model, args.billing ?? 'unknown', args.serviceTier, args.modelCache, args.epoch ?? '', Date.now(), args.child ? 1 : estimateTokens(args.task), args.cachePolicy) : null;
  const { hold, reason: costReason } = costHold(cost, offer.baselineCandidate?.rank, offer.candidates.find(c => c.id === decision.patch.model)?.rank);
  if (hold && out.ok) { decision.patch = { ...keepModelPair(offer, out.response.answers).patch, ...native }; decision.reasons.model = costReason; }
  write('codex_router_result', { ...diagnostic, attempted: true, duration_ms: out.durationMs, ok: out.ok,
    reason: out.ok ? signal?.aborted ? 'aborted' : out.response.model !== config.gate.jevModel ? 'model_mismatch' : null : out.code,
    http: { duration_ms: out.durationMs, code: out.ok ? 'ok' : out.code }, jev: out.ok ? { model: out.response.model, usage: out.response.usage } : null,
    selected_model: decision.patch.model ?? args.model, selected_effort: decision.patch.effort ?? (decision.patch.effortEdit?.kind === 'omit' ? null : args.effort), effort_edit: decision.patch.effortEdit ?? { kind: 'keep' },
    cost, cost_reason: costReason, reasons: decision.reasons, selection: decision.diagnostics, answers: out.ok ? pairReceipt(offer, out.response.answers) : {}, ...(out.ok ? { usage: out.response.usage, returned_model: out.response.model } : {}), applied: false });
  return decision.patch;
};
