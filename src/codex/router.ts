import { buildQuestions, buildState, validateAnswers, orderedMove, moveGate, TIER_ORDER, EFFORT_LEVEL_TARGETS, TIER_LEVELS, type ModelTier } from '../../mods/router/hooks/policy.ts';
import { callJev } from '../jev.js';
import type { Env } from '../config.js';
import type { TraceWriter } from '../trace.js';
import type { CodexPolicyConfig } from './config.js';
import { randomUUID } from 'node:crypto';

export interface CodexModel { model: string; description?: string; isDefault?: boolean; hidden?: boolean; defaultReasoningEffort?: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }> }
// Host-specific effort vocabulary. The account catalog, not this order, decides which values may be sent.
const EFFORT_LEVELS = {
  none: 'An immediate response or mechanical transformation requiring no reasoning.',
  minimal: 'A trivial, bounded decision requiring only a minimal reasoning step.',
  low: TIER_LEVELS.fast,
  medium: TIER_LEVELS.standard,
  high: TIER_LEVELS.deep,
  xhigh: TIER_LEVELS.frontier,
  max: 'Exceptional reasoning requiring sustained comparison of many competing hypotheses or a difficult proof with several interacting constraints.',
  ultra: 'Exhaustive reasoning for an exceptionally difficult problem requiring extended proof search, adversarial counterexamples and independent verification of interacting conclusions.',
} as const;
const effortOrder = Object.keys(EFFORT_LEVELS) as Array<keyof typeof EFFORT_LEVELS>;
/** Same ordered probability policy; model identity and valid efforts come from this Codex account's live catalog. */
export const routeCodex = async (args: {
  model: string; effort: string | null; task: string; previousReply?: string; session: string; prompt: string;
  catalog: CodexModel[]; config: CodexPolicyConfig; env: Env; trace?: TraceWriter; signal?: AbortSignal; fetchImpl?: typeof fetch;
}): Promise<{ model?: string; effort?: string }> => {
  const { config, env, signal, catalog } = args;
  const skip = (reason: string): {} => {
    args.trace?.write('codex_router_skipped', { host: 'codex', mode: config.gate.mode, session_id: args.session, prompt_id: args.prompt,
      known_not_sent: true, attempted: false, reason });
    return {};
  };
  if (env['JEV_CODEX_ENABLED'] === '0') return skip('disabled');
  if (!config.router.enabled) return skip('router_disabled');
  if (!env['TYPESAFE_API_KEY']) return skip('key_missing');
  if (signal?.aborted) return skip('aborted');
  const base = catalog.find(m => m.model === args.model);
  if (!base) return skip('model_catalog_missing');
  const allowed = base.supportedReasoningEfforts.map(e => e.reasoningEffort);
  const from = args.effort ?? base.defaultReasoningEffort ?? null;
  const effortEnabled = config.router.effort && from !== null && effortOrder.some(e => e === from) && allowed.includes(from);
  const efforts = effortEnabled ? effortOrder.filter(e => allowed.includes(e)) : null;
  const mutableEfforts = efforts && efforts.length > 1 ? efforts : null;
  const models = config.gate.models;
  const ids = Object.values(models);
  const tiers: ModelTier[] | null = config.router.model && new Set(ids).size > 1 && ids.includes(args.model) && ids.every(id => catalog.some(m => m.model === id)) ? [...TIER_ORDER] : null;
  const dims = { tiers, efforts: mutableEfforts ? EFFORT_LEVEL_TARGETS : null };
  const questions = buildQuestions(dims);
  if (!questions) return skip('nothing_to_change');
  if (mutableEfforts && questions.effort) questions.effort = { ...questions.effort, criteria: mutableEfforts.map(e => EFFORT_LEVELS[e]) };
  const requestId = randomUUID();
  const facts = { host: 'codex', mode: config.gate.mode, component: 'router', session_id: args.session, prompt_id: args.prompt, request_id: requestId };
  const intent = args.trace?.write('codex_router_intent', { ...facts, asked: Object.keys(questions), attempted: true });
  if (intent && !intent.ok && intent.error !== 'recording_disabled') return {};
  const out = await callJev({ model: config.gate.jevModel, state: buildState({ scope: 'root', text: args.task, ...(args.previousReply ? { previousReply: args.previousReply } : {}) }), questions }, {
    apiKey: env['TYPESAFE_API_KEY'], deadlineMs: config.router.timeoutMs, ...(signal ? { signal } : {}), ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
  });
  let patch: { model?: string; effort?: string } = {};
  const safeAnswers: Record<string, unknown> = {};
  const reasons: Record<string, string> = {};
  if (out.ok && out.response.model === config.gate.jevModel && !signal?.aborted) {
    const answers = validateAnswers(out.response.answers, questions);
    for (const [key, answer] of Object.entries(answers)) {
      // Persist the exact offered labels: Codex effort levels can vary with the native model catalog.
      const labels = key === 'tier' ? tiers : key === 'effort' ? mutableEfforts : null;
      if (answer) safeAnswers[key] = 'levels' in answer ? { type: 'score', probabilities: Object.fromEntries((answer.levels as readonly number[]).map((v, i) => [labels?.[i] ?? String(i), v])) } : answer;
    }
    const opts = { scope: 'root' as const, tiers: models, minUpgradeConfidence: config.router.minUpgradeConfidence, minDowngradeConfidence: config.router.minDowngradeConfidence };
    const choose = (key: 'tier' | 'effort', order: readonly string[], current: number, labels: readonly string[] = order): number | null => {
      const a = answers[key];
      if (!a || current < 0) { reasons[key] = 'answer_invalid'; return null; }
      const probabilities: Record<string, number> = {};
      a.levels.forEach((p, i) => { const label = labels[i]; if (label) probabilities[label] = (probabilities[label] ?? 0) + p; });
      const move = orderedMove({ probabilities }, order, current, opts);
      if (!move) { reasons[key] = 'same_or_uncertain'; return null; }
      const held = moveGate(move.direction, answers, opts);
      reasons[key] = held ?? 'selected';
      return held ? null : move.index;
    };
    if (tiers) {
      const labels = tiers.map(t => models[t]); const order = [...new Set(labels)];
      const ix = choose('tier', order, order.indexOf(args.model), labels);
      if (ix !== null) patch.model = order[ix]!;
    }
    if (mutableEfforts && from) {
      const ix = choose('effort', mutableEfforts, mutableEfforts.findIndex(e => e === from));
      if (ix !== null) patch.effort = mutableEfforts[ix]!;
    }
    const effective = catalog.find(m => m.model === (patch.model ?? args.model));
    if (patch.model && from && !effective?.supportedReasoningEfforts.some(e => e.reasoningEffort === (patch.effort ?? from))) {
      delete patch.model;
      reasons['tier'] = 'pair_invalid';
    }
  }
  args.trace?.write('codex_router_result', { ...facts, attempted: true, duration_ms: out.durationMs, ok: out.ok, reason: out.ok ? signal?.aborted ? 'aborted' : out.response.model !== config.gate.jevModel ? 'model_mismatch' : null : out.code,
    http: { duration_ms: out.durationMs, code: out.ok ? 'ok' : out.code }, jev: out.ok ? { model: out.response.model, usage: out.response.usage } : null,
    answers: safeAnswers,
    selected_model: patch.model ?? args.model, selected_effort: patch.effort ?? from, reasons,
    ...(out.ok ? { usage: out.response.usage, returned_model: out.response.model } : {}), applied: false });
  return patch;
};
