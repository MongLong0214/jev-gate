import { describe, expect, it } from 'vitest';
import { offerPairs, selectPair, applyEffort, type RouteCandidate } from '../../mods/router/hooks/selection.ts';
import { routingContext } from '../../mods/router/hooks/context.ts';
import { normalizeCatalog, isAstra } from '../../src/codex/catalog.js';
import { claudeCandidates } from '../../mods/router/hooks/candidates.ts';
import { choice } from './fake-engine.ts';
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
