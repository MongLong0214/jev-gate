import { describe, expect, it } from 'vitest';
import { offerPairs, selectPair, applyEffort, type RouteCandidate } from '../../mods/router/hooks/selection.ts';
import { routingContext } from '../../mods/router/hooks/context.ts';
import { normalizeCatalog, isAstra } from '../../src/codex/catalog.js';
import { codexCandidates } from '../../src/codex/router.js';
import { claudeCandidates } from '../../mods/router/hooks/candidates.ts';
import { claudeAgentToolModel, factsOf, sameModel, MODEL_FACTS } from '../../src/claude-models.ts';
import { choice } from './fake-engine.ts';
import type { PairOffer } from '../../src/router-selection.ts';
const claudeOffer = (baseline = 'claude-opus-5-5', effort: string | null = 'high', mutable = true) => offerPairs({ baseline: { model: baseline, effort }, candidates: claudeCandidates({ baseline, aliases: {}, allowFable: false }), model: true, effort: mutable, upgrade: .8, downgrade: .6 })!;
const exactAnswers = (o: PairOffer, selected = 'claude-sonnet-5-5', probability = .7, risk = 'ordinary', control = 1) => Object.fromEntries(Object.entries(o.questions).map(([name, q]) => [name, q.type === 'choice' ? { type: 'choice', choice: name === 'model' ? selected : name === 'control' ? 'task_clear' : risk, confidence: name === 'model' ? probability : name === 'control' ? control : 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, name === 'model' ? k === selected ? probability : k === '__keep__' ? 1 - probability : 0 : k === (name === 'control' ? 'task_clear' : risk) ? name === 'control' ? control : 1 : k === 'unclear' && name === 'control' ? 1 - control : 0])) } : { type: 'score', probabilities: Object.fromEntries(q.criteria.map((s, i) => [i, s.startsWith('Strong reasoning') ? 1 : 0])) }]));
describe('Claude and Codex routing role parity', () => {
  const native = [
    { model: 'gpt-6.1-sol', description: 'Latest workhorse model for coding and everyday work.' },
    { model: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.' },
    { model: 'fixture-balanced', description: 'Balanced model for straightforward work.' },
    { model: 'gpt-6-astra', description: 'Frontier intelligence for the most demanding work.' },
  ].map(m => ({ ...m, supportedReasoningEfforts: ['low', 'medium', 'high', 'max'].map(reasoningEffort => ({ reasoningEffort })) }));
  it.each([.59, .6, .7, .8, 1])('uses the same downward floor in both adapters: %s', probability => {
    const claude = claudeOffer();
    const codex = offerPairs({ baseline: { model: 'gpt-6.1-sol', effort: 'high' }, candidates: codexCandidates(native, false), model: true, effort: true, upgrade: .8, downgrade: .6 })!;
    for (const [o, target] of [[claude, 'claude-sonnet-5-5'], [codex, 'gpt-6-luna']] as const) {
      const result = selectPair(o, exactAnswers(o, target, probability));
      expect(result.patch.model).toBe(probability >= .6 ? target : undefined);
      expect(result.diagnostics).toMatchObject({ direction: 'downgrade', threshold: .6 });
    }
  });
  it.each(['ordinary', 'consequential', 'unclear'])('applies the same risk rule to Luna and a balanced candidate: %s', risk => {
    const o = offerPairs({ baseline: { model: 'gpt-6.1-sol', effort: 'high' }, candidates: codexCandidates(native, false), model: true, effort: true, upgrade: .8, downgrade: .6 })!;
    for (const target of ['gpt-6-luna', 'fixture-balanced']) {
      const result = selectPair(o, exactAnswers(o, target, .99, risk));
      expect(result.patch.model).toBe(risk === 'ordinary' ? target : undefined);
      expect(result.reasons.model).toBe(risk === 'ordinary' ? 'selected' : 'risk_blocks_downgrade');
    }
    expect(o.candidates.some(c => c.id === 'gpt-6-astra')).toBe(false);
  });
  it.each([.79, .8])('uses .8 to return from Luna to the workhorse: %s', probability => {
    const o = offerPairs({ baseline: { model: 'gpt-6-luna', effort: 'high' }, candidates: codexCandidates(native, false), model: true, effort: true, upgrade: .8, downgrade: .6 })!;
    expect(selectPair(o, exactAnswers(o, 'gpt-6.1-sol', probability)).patch.model).toBe(probability >= .8 ? 'gpt-6.1-sol' : undefined);
  });
  it('keeps unknown model roles unknown and does not infer rank from a name', () => {
    expect(codexCandidates([{ ...native[0]!, description: 'General coding model' }], false)[0]).not.toHaveProperty('rank');
    expect(codexCandidates(native, true).find(c => c.id === 'gpt-6-astra')?.rank).toBe(3);
  });
  it('preserves both explicitly pinned dimensions in both adapters even when an alternative is supported', () => {
    const offers = [claudeOffer(), offerPairs({ baseline: { model: 'gpt-6.1-sol', effort: 'high' }, candidates: codexCandidates(native, false), model: true, effort: true, upgrade: .8, downgrade: .6 })!];
    for (const [index, o] of offers.entries()) {
      const target = index === 0 ? 'claude-sonnet-5-5' : 'gpt-6-luna';
      const data: Record<string, unknown> = exactAnswers(o, target, .99); const q = o.questions.control!;
      expect(selectPair(o, data).patch).toMatchObject({ model: target });
      if (q.type !== 'choice') throw Error('control absent');
      data.control = choice(Object.keys(q.criteria), ['explicit_lock', 1]);
      expect(selectPair(o, data).patch).toEqual({});
    }
  });
  it.each([
    ['missing', 'control_invalid'],
    ['invalid', 'control_invalid'],
    ['low_confidence', 'control_low_confidence'],
    ['needs_context', 'context_missing'],
    ['unclear', 'control_unclear'],
    ['explicit_lock', 'control_lock'],
  ])('reports the actual reason for preserving both adapters: %s', (state, reason) => {
    const offers = [claudeOffer(), offerPairs({ baseline: { model: 'gpt-6.1-sol', effort: 'high' }, candidates: codexCandidates(native, false), model: true, effort: true, upgrade: .8, downgrade: .6 })!];
    for (const [index, o] of offers.entries()) {
      const data: Record<string, unknown> = exactAnswers(o, index === 0 ? 'claude-sonnet-5-5' : 'gpt-6-luna', .99);
      const q = o.questions.control!;
      if (q.type !== 'choice') throw Error('control absent');
      if (state === 'missing') delete data.control;
      else if (state === 'invalid') data.control = { type: 'choice', choice: 'task_clear', probabilities: { task_clear: 2 } };
      else if (state === 'low_confidence') data.control = { type: 'choice', choice: 'task_clear', probabilities: { task_clear: .52, model_lock: .01, effort_lock: 0, explicit_lock: 0, needs_context: .33, unclear: .14 }, confidence: .41 };
      else data.control = choice(Object.keys(q.criteria), [state, 1]);
      expect(selectPair(o, data)).toMatchObject({ patch: {}, reasons: { model: reason, effort: reason } });
    }
  });
});
describe('documented Claude role thresholds and target effort resolution', () => {
  it.each([[.7, true], [.59, false]] as const)('uses the existing .6 downward floor, not .8: %s', (probability, selected) => {
    const o = claudeOffer(); const result = selectPair(o, exactAnswers(o, 'claude-sonnet-5-5', probability));
    expect(result.patch.model).toBe(selected ? 'claude-sonnet-5-5' : undefined); expect(result.diagnostics).toMatchObject({ direction: 'downgrade', threshold: .6, probability });
  });
  it('requires .8 for a known upgrade, same-role version switch and unknown rank', () => {
    for (const [baseline, target] of [['claude-sonnet-5-5', 'claude-opus-5-5'], ['claude-sonnet-5-5', 'claude-sonnet-5']]) {
      const o = claudeOffer(baseline!); expect(selectPair(o, exactAnswers(o, target!, .7)).patch.model).toBeUndefined();
    }
    const o = claudeOffer(); o.candidates = o.candidates.map(({ rank: _rank, ...candidate }) => candidate); delete o.baselineCandidate;
    const result = selectPair(o, exactAnswers(o)); expect(result.patch.model).toBeUndefined(); expect(result.diagnostics).toMatchObject({ direction: 'unknown', threshold: .8 });
  });
  it.each(['consequential', 'unclear'])('retains the downgrade risk guard: %s', risk => {
    const o = claudeOffer(); expect(selectPair(o, exactAnswers(o, 'claude-sonnet-5-5', .95, risk)).reasons.model).toBe('risk_blocks_downgrade');
    expect(selectPair(o, exactAnswers(o, 'claude-sonnet-5-5', .95, 'ordinary', .59)).patch.model).toBeUndefined();
  });
  it('keeps Sonnet versions separate and never adds their choice probabilities', () => {
    const o = claudeOffer(); const a = exactAnswers(o); const q = o.questions.model!;
    if (q.type !== 'choice') throw Error('model question absent');
    a.model = { type: 'choice', choice: 'claude-sonnet-5-5', confidence: .46, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === 'claude-sonnet-5-5' ? .46 : k === 'claude-sonnet-5' ? .44 : k === '__keep__' ? .1 : 0])) };
    expect(selectPair(o, a).patch.model).toBeUndefined();
  });
  it('uses a target-model .8 quantile for max not on its scale, while a real max pin excludes it', () => {
    const o = claudeOffer('claude-opus-5-5', 'max'); const a = exactAnswers(o, 'claude-sonnet-5-5', .95); const name = o.effortQuestions.get('claude-sonnet-5-5')!.name;
    a[name] = { type: 'score', probabilities: { 0: 0, 1: .45, 2: .55 } };
    expect(selectPair(o, a)).toMatchObject({ patch: { model: 'claude-sonnet-5-5', effort: 'high' }, diagnostics: { effort_policy: 'target_quantile' } });
    const pinned = claudeOffer('claude-opus-5-5', 'max', false); expect(pinned).toBeNull();
    delete a[name]; const invalid = selectPair(o, a); expect(invalid.patch).toEqual({}); expect(invalid.reasons.effort).toBe('target_effort_unresolved'); expect(invalid.diagnostics.pair_valid).toBe(false);
  });
});
const candidates: RouteCandidate[] = [
  { id: 'fixture-A', description: 'coding model A', efforts: ['low', 'high'], omitEffort: false },
  { id: 'fixture-B', description: 'coding model B', efforts: ['high', 'max'], omitEffort: false },
];
const offer = (model = true, effort = true, cs = candidates) => offerPairs({ baseline: { model: 'fixture-A', effort: 'high' }, candidates: cs, model, effort, upgrade: .8, downgrade: .6 })!;
const answers = (o = offer(), model = 'fixture-B', effort = 'max', control = 'task_clear') => Object.fromEntries(Object.entries(o.questions).map(([k, q]) => [k, q.type === 'choice' ? choice(Object.keys(q.criteria), [k === 'control' ? control : k === 'model' ? model : 'ordinary', .99]) :
  { type: 'score', probabilities: Object.fromEntries(q.criteria.map((_, i) => [i, o.effortQuestions.get(k === 'effort_0' ? 'fixture-A' : 'fixture-B')?.values[i] === effort ? .99 : .01])) }]));
describe('candidate-local pair selection', () => {
  it.each([
    ['__keep__', 'high', {}], ['__keep__', 'low', { effort: 'low' }], ['fixture-B', 'high', { model: 'fixture-B' }], ['fixture-B', 'max', { model: 'fixture-B', effort: 'max' }],
  ])('represents root keep, effort-only, model-only and both (%s/%s)', (model, effort, expected) => {
    const o = offer(); const selected = selectPair(o, answers(o, String(model), String(effort))).patch;
    const { effortEdit: _edit, ...wire } = selected;
    expect(wire).toEqual(expected);
  });
  it('offers a single alternative outside all role mappings and uses only that candidate effort answer', () => {
    const o = offer(); expect(o.questions.model).toMatchObject({ type: 'choice', criteria: { 'fixture-B': expect.any(String) } });
    const a = answers(o); a.effort_0 = { type: 'score', probabilities: { 0: 1, 1: 0 } };
    expect(selectPair(o, a).patch).toMatchObject({ model: 'fixture-B', effort: 'max' });
    a.effort_1 = { type: 'score', probabilities: { 0: .4, 1: .4 } };
    expect(selectPair(o, a).patch).toEqual({ model: 'fixture-B' }); // B supports the preserved high.
  });
  it('handles independent control locks and rejects an unvalidated B effort', () => {
    let o = offer(); expect(selectPair(o, answers(o, 'fixture-B', 'low', 'model_lock')).patch).toMatchObject({ effort: 'low' });
    expect(selectPair(o, answers(o, 'fixture-B', 'max', 'effort_lock')).patch).toEqual({ model: 'fixture-B' });
    o = offer(true, false, [candidates[0]!, { ...candidates[1]!, efforts: ['max'] }]); expect(o).toBeNull();
  });
  it('distinguishes literal none, omission and preservation without removing other reasoning fields', () => {
    expect(applyEffort({ effort: 'high', summary: 'auto', budget: 42 }, { kind: 'omit' })).toEqual({ summary: 'auto', budget: 42 });
    expect(applyEffort({ effort: 'high', summary: 'auto' }, { kind: 'set', value: 'none' })).toEqual({ effort: 'none', summary: 'auto' });
    expect(applyEffort({ effort: 'high' }, { kind: 'keep' })).toEqual({ effort: 'high' });
    const o = offer(true, true, [candidates[0]!, { id: 'fixture-B', description: 'effortless model', efforts: [], omitEffort: true }]);
    expect(selectPair(o, answers(o)).patch).toEqual({ model: 'fixture-B', effortEdit: { kind: 'omit' } });
  });
  it('does not use array order or cumulative nominal mass to lower model confidence', () => {
    const o = offer(); const a = answers(o); a.model = choice(Object.keys((o.questions.model as { criteria: object }).criteria), ['fixture-B', .7]);
    expect(selectPair(o, a).patch).not.toHaveProperty('model');
    expect(offerPairs({ baseline: { model: 'fixture-A', effort: 'high' }, candidates: [candidates[0]!], model: true, effort: false, upgrade: .8, downgrade: .6 })).toBeNull();
  });
});
describe('bounded context and truthful discovery', () => {
  it.each([undefined, NaN, Infinity, -1, 136_000, 200_000])('keeps smaller-window roots out when context cannot fit: %s', contextTokens => {
    const cs = claudeCandidates({ baseline: 'claude-opus-5-5', aliases: {}, allowFable: false, ...(contextTokens !== undefined ? { inputUpperBound: contextTokens, requestCompatible: true } : {}) });
    expect(cs.some(c => c.id.includes('haiku-4-5'))).toBe(false);
  });
  it('excludes legacy Haiku even with a fitting bound and offers current Haiku with its published role', () => {
    const cs = claudeCandidates({ baseline: 'claude-opus-5-5', aliases: {}, allowFable: false, inputUpperBound: 22_000, requestCompatible: true });
    expect(cs.some(c => c.id.includes('haiku-4-5'))).toBe(false);
    expect(cs.find(c => c.id === 'claude-haiku-5-5')).toMatchObject({ efforts: ['low', 'medium', 'high'], description: expect.stringContaining('latency-sensitive') });
    expect(cs.find(c => c.id === 'claude-sonnet-5-5')?.description).toContain('combination of speed and intelligence');
  });
  it('offers account-allowed Haiku 5.5 to a 1M root without a smaller-window bound, using its own effort contract', () => {
    const args = { baseline: 'claude-opus-5-5', aliases: {}, allowFable: false, hostBase: '2.1.293', available: ['claude-opus-5-5', 'claude-haiku-5-5'] };
    const cs = claudeCandidates(args);
    expect(cs.map(c => c.id)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    expect(cs[1]).toMatchObject({ rank: 0, efforts: ['low', 'medium', 'high'], omitEffort: false });
    const o = offerPairs({ baseline: { model: args.baseline, effort: 'xhigh' }, candidates: cs, model: true, effort: true, upgrade: .8, downgrade: .6 })!;
    const a = exactAnswers(o, 'claude-haiku-5-5', .7);
    const q = o.effortQuestions.get('claude-haiku-5-5')!;
    a[q.name] = { type: 'score', probabilities: { 0: 0, 1: 1, 2: 0 } };
    expect(selectPair(o, a)).toMatchObject({ patch: { model: 'claude-haiku-5-5', effort: 'medium' }, diagnostics: { direction: 'downgrade', threshold: .6, pair_valid: true } });
    expect(claudeCandidates({ ...args, available: ['claude-opus-5-5'] }).some(c => c.id === 'claude-haiku-5-5')).toBe(false);
    const excluded: Record<string, number> = {};
    expect(claudeCandidates({ ...args, hostBase: '2.1.292', excluded }).some(c => c.id === 'claude-haiku-5-5')).toBe(false);
    expect(excluded.host_unverified).toBe(1);
  });
  it('recognizes documented Haiku 5.5 IDs and the native family without guessing dates or variants', () => {
    expect(factsOf('claude-haiku-5-5')).toMatchObject({ contextTokens: 1_000_000, maxOutputTokens: 128_000, unconditionalEffort: ['low', 'medium', 'high'], conditionalEffort: ['xhigh', 'max'] });
    expect(sameModel('haiku', 'claude-haiku-5-5')).toBe(true);
    expect(sameModel('claude-haiku-5-5', 'anthropic.claude-haiku-5-5')).toBe(true);
    expect(sameModel('claude-haiku-4-5', 'claude-haiku-5-5')).toBe(false);
    for (const id of ['claude-haiku-5-5-20261007', 'claude-haiku-5-5[1m]', 'claude-haiku-5-5-preview']) expect(factsOf(id)).toBeNull();
  });
  it('encodes every documented ID and variant for the Agent enum without interpreting unknown IDs', () => {
    for (const fact of MODEL_FACTS) for (const id of fact.ids) for (const suffix of ['', ...fact.suffixes]) expect(claudeAgentToolModel(id + suffix)).toBe(fact.family);
    for (const family of ['opus', 'sonnet', 'haiku', 'fable']) expect(claudeAgentToolModel(family)).toBe(family);
    expect(claudeAgentToolModel('custom-provider-model')).toBeNull(); expect(claudeAgentToolModel('claude-opus-5-5[unknown]')).toBeNull();
  });
  it('screens whole prior text before truncating and never truncates the current task', () => {
    const s = routingContext('x'.repeat(8000), 'a'.repeat(2100), ['prior']); expect(s.task.text).toHaveLength(8000); expect(s.task.previous_reply).toHaveLength(2000); expect(s.task.previous_reply_truncated).toBe(true);
    expect(routingContext('task', 'Authorization: Bearer sk-live-secret1234567890' + 'a'.repeat(3000)).task).not.toHaveProperty('previous_reply');
  });
  it('keeps six versions and metadata, excluding only malformed/conflicting candidates', () => {
    const models = Array.from({ length: 6 }, (_, i) => ({ model: `fixture-${i}`, description: `Model ${i}`, inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'max', description: 'highest' }] }));
    const normalized = normalizeCatalog([...models, models[0], { model: 'bad', supportedReasoningEfforts: null }], false);
    expect(normalized.models).toHaveLength(6); expect(normalized.complete).toBe(false); expect(normalized.models[5]).toEqual(models[5]);
    const conflict = normalizeCatalog([...models, { ...models[0], supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], true);
    expect(conflict.models).toHaveLength(5); expect(conflict.excluded.duplicate_conflict).toBe(1);
  });
  it('filters restricted families exactly and preserves a manually selected root', () => {
    expect(isAstra('gpt-6.1-astra')).toBe(true); expect(isAstra('fake-gpt-6-astra-copy')).toBe(false);
    const cs = claudeCandidates({ baseline: 'claude-fable-5-1', aliases: {}, allowFable: false });
    expect(cs.map(c => c.id)).toContain('claude-fable-5-1'); expect(cs.map(c => c.id)).not.toContain('claude-fable-5');
    expect(cs.map(c => c.id)).toContain('claude-opus-5-5');
    expect(claudeCandidates({ baseline: 'claude-opus-5-5', aliases: {}, allowFable: false }).some(c => c.id.startsWith('claude-fable'))).toBe(false);
  });
});

describe('ordered effort probability mass', () => {
  it('uses cumulative downgrade/upgrade mass without requiring a nominal majority', () => {
    const cs=[{id:'fixture-A',description:'coding model',efforts:['low','medium','high','max'],omitEffort:false}];
    let o=offerPairs({baseline:{model:'fixture-A',effort:'high'},candidates:cs,model:false,effort:true,upgrade:.8,downgrade:.6})!;
    let a=answers(o,'__keep__','high'); a.effort_0={type:'score',probabilities:{0:.35,1:.3,2:.35,3:0}};
    expect(selectPair(o,a).patch).toEqual({effort:'medium',effortEdit:{kind:'set',value:'medium'}});
    o=offerPairs({baseline:{model:'fixture-A',effort:'low'},candidates:cs,model:false,effort:true,upgrade:.8,downgrade:.6})!;
    a=answers(o,'__keep__','low'); a.effort_0={type:'score',probabilities:{0:.15,1:.4,2:.35,3:.1}};
    expect(selectPair(o,a).patch).toEqual({effort:'medium',effortEdit:{kind:'set',value:'medium'}});
  });
  it('does not manufacture an answer for a single effort or an unknown current-model capability',()=>{
    expect(offerPairs({baseline:{model:'fixture-A',effort:'high'},candidates:[{...candidates[0]!,efforts:['high']}],model:true,effort:true,upgrade:.8,downgrade:.6})).toBeNull();
    const cs=claudeCandidates({baseline:'unknown-provider',aliases:{},allowFable:false}); expect(cs).toEqual([]);
  });
});
