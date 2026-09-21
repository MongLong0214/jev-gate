import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config.js';
import { MAX_REQUEST_BYTES } from '../src/jev.js';
import {
  buildLeanRequest,
  composeFullPacket,
  composeLeanPacket,
  decideLean,
  HANDOFF_SCOPE_ANSWERS,
  LEAN_OMISSION_CONFIDENCE,
  RELATION_ANSWERS,
  WORK_SHAPE_ANSWERS,
} from '../src/lean.js';
import type { LeanGroup, LeanSource } from '../src/lean-source.js';

const choice = (keys: readonly string[], winner: string, confidence = 0.95): Record<string, unknown> => ({
  type: 'choice',
  choice: winner,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === winner ? 0.9 : 0.1 / (keys.length - 1)])),
  confidence,
});

const group = (id: string, text: string, mandatory = false): LeanGroup => ({
  id,
  origin: mandatory ? 'human' : 'assistant_tool',
  text,
  sourceRefs: [id],
  mandatory,
});

const source = (over: Partial<LeanSource> = {}): LeanSource => ({
  request: '파서를 고쳐줘',
  groups: [group('m1', '예외: `as any` 금지', true), group('g1', '[tool_use Read] {"file_path":"src/a.ts"}\n[tool_result] export const x = 1;'), group('g2', '[tool_use Bash] {"command":"git log"}\n[tool_result] abc123')],
  epoch: 'uncompacted',
  prefixDigest: 'd',
  newerHumanText: false,
  coverage: 'complete',
  unassessed: 0,
  bytesRead: 100,
  durationMs: 1,
  ...over,
});

const answers = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  work_shape: choice(WORK_SHAPE_ANSWERS, 'sustained_task'),
  handoff_scope: choice(HANDOFF_SCOPE_ANSWERS, 'self_contained'),
  relation_g1: choice(RELATION_ANSWERS, 'keep'),
  relation_g2: choice(RELATION_ANSWERS, 'omit'),
  ...over,
});

describe('lean request', () => {
  it('asks work_shape, handoff_scope and one relation per enumerated group, in one batch', () => {
    const packed = buildLeanRequest(source(), DEFAULT_CONFIG);
    if (!packed.ok) throw new Error(packed.reason);
    expect(Object.keys(packed.request.questions).sort()).toEqual(['handoff_scope', 'relation_g1', 'relation_g2', 'work_shape']);
    expect(packed.askedIds).toEqual(['g1', 'g2']);
  });

  it('names the object each question evaluates, because the map key is an output name, not input', () => {
    const packed = buildLeanRequest(source(), DEFAULT_CONFIG);
    if (!packed.ok) throw new Error(packed.reason);
    const q = packed.request.questions['relation_g2'] as { instructions: string; criteria: Record<string, string> };
    expect(q.instructions).toContain('state.groups["g2"]');
    expect(q.criteria['keep']).toContain('state.groups["g2"]');
    const scope = packed.request.questions['handoff_scope'] as { instructions: string };
    expect(scope.instructions).toContain('Ignore state.groups');
  });

  it('carries mandatory source and the request into state, and the request only once', () => {
    const packed = buildLeanRequest(source(), DEFAULT_CONFIG);
    if (!packed.ok) throw new Error(packed.reason);
    expect(packed.request.state.request).toBe('파서를 고쳐줘');
    expect(packed.request.state.mandatory.map((m) => m.text)).toEqual(['예외: `as any` 금지']);
    expect(Object.keys(packed.request.state.groups)).toEqual(['g1', 'g2']);
    expect(JSON.stringify(packed.request).split('파서를 고쳐줘').length - 1).toBe(1);
  });

  it('refuses before any request when the mandatory layer alone exceeds the request bound', () => {
    const huge = 'x'.repeat(MAX_REQUEST_BYTES);
    const packed = buildLeanRequest(source({ groups: [group('m1', huge, true), group('g1', 'small')] }), DEFAULT_CONFIG);
    expect(packed.ok).toBe(false);
    expect(packed.ok === false && packed.reason).toBe('mandatory_overflow');
  });

  it('packs each whole group with its own question and records the ones that did not fit as unassessed', () => {
    const big = 'y'.repeat(60 * 1024);
    const packed = buildLeanRequest(source({ groups: [group('m1', 'rule', true), group('g1', big), group('g2', big), group('g3', big)] }), DEFAULT_CONFIG);
    if (!packed.ok) throw new Error(packed.reason);
    expect(Buffer.byteLength(JSON.stringify(packed.request), 'utf8')).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    // Newest first under the cap, then restored to chronological order for the answer map.
    expect(packed.askedIds.length).toBeLessThan(3);
    expect(packed.unassessed).toBe(3 - packed.askedIds.length);
    // No group was sliced to make it fit.
    for (const id of packed.askedIds) expect(packed.request.state.groups[id]).toBe(big);
  });

  it('reports no room rather than sending a request with no candidate in it', () => {
    const packed = buildLeanRequest(source({ groups: [group('m1', 'z'.repeat(100 * 1024), true), group('g1', 'y'.repeat(60 * 1024))] }), DEFAULT_CONFIG);
    expect(packed.ok === false && packed.reason).toBe('no_room_for_candidates');
  });
});

describe('lean decision', () => {
  it('proposes a handoff only for a sustained, self-contained task with an actual omission', () => {
    const d = decideLean(answers(), ['g1', 'g2']);
    expect(d.action).toBe('handoff');
    expect(d.retainedGroupIds).toEqual(['g1']);
    expect(d.omittedGroupIds).toEqual(['g2']);
  });

  it.each([
    ['short_step work', { work_shape: choice(WORK_SHAPE_ANSWERS, 'short_step') }, 'work_shape_short_step'],
    ['unclear work', { work_shape: choice(WORK_SHAPE_ANSWERS, 'unclear') }, 'work_shape_unusable'],
    ['missing work answer', { work_shape: undefined }, 'work_shape_unusable'],
    ['malformed work answer', { work_shape: { type: 'choice', choice: 'sustained_task' } }, 'work_shape_unusable'],
    ['low-confidence work', { work_shape: choice(WORK_SHAPE_ANSWERS, 'sustained_task', 0.4) }, 'work_shape_unusable'],
    ['missing context', { handoff_scope: choice(HANDOFF_SCOPE_ANSWERS, 'needs_missing_context') }, 'scope_needs_context'],
    ['user forbids delegation', { handoff_scope: choice(HANDOFF_SCOPE_ANSWERS, 'forbidden') }, 'scope_forbidden'],
    ['unclear scope', { handoff_scope: choice(HANDOFF_SCOPE_ANSWERS, 'unclear') }, 'scope_unusable'],
  ])('stays native on %s', (_name, over, reason) => {
    const d = decideLean(answers(over), ['g1', 'g2']);
    expect(d.action).toBe('direct');
    expect(d.reason).toBe(reason);
    // Nothing is dropped on a native fallback.
    expect(d.retainedGroupIds).toEqual(['g1', 'g2']);
  });

  it('keeps a whole group whose relation is invalid, tied, missing, uncertain or under-confident', () => {
    const d = decideLean(
      answers({
        relation_g1: { type: 'choice', choice: 'omit', probabilities: { keep: 0.5, omit: 0.5, uncertain: 0 }, confidence: 0.99 },
        relation_g2: choice(RELATION_ANSWERS, 'omit', LEAN_OMISSION_CONFIDENCE - 0.01),
      }),
      ['g1', 'g2'],
    );
    expect(d.action).toBe('direct');
    expect(d.reason).toBe('no_effect');
    expect(d.retainedGroupIds).toEqual(['g1', 'g2']);
  });

  it('is no_effect, not a handoff, when every group is kept', () => {
    const d = decideLean(answers({ relation_g2: choice(RELATION_ANSWERS, 'keep') }), ['g1', 'g2']);
    expect(d.action).toBe('direct');
    expect(d.reason).toBe('no_effect');
  });

  it('ignores ids the request never asked about', () => {
    const d = decideLean(answers({ relation_g9: choice(RELATION_ANSWERS, 'omit') }), ['g1', 'g2']);
    expect([...d.retainedGroupIds, ...d.omittedGroupIds].sort()).toEqual(['g1', 'g2']);
  });
});

describe('lean packet', () => {
  it('carries the exact request once, every mandatory group and the retained groups in original order', () => {
    const s = source();
    const packet = composeLeanPacket(s, ['g1'], 1);
    expect(packet.split('파서를 고쳐줘').length - 1).toBe(1);
    expect(packet).toContain('예외: `as any` 금지');
    expect(packet).toContain('export const x = 1;');
    expect(packet).not.toContain('git log');
    expect(packet.indexOf('예외')).toBeLessThan(packet.indexOf('export const x'));
  });

  it('attributes the compact summary as a fallible summary without rewriting it', () => {
    const s = source({ groups: [{ id: 'm1', origin: 'compact_summary', text: 'Summary: the user chose option 2.', sourceRefs: ['s1'], mandatory: true }, group('g1', 'x')] });
    const packet = composeLeanPacket(s, [], 1);
    expect(packet).toContain('fallible summary');
    expect(packet).toContain('Summary: the user chose option 2.');
  });

  it('says how much was left out, including source that was never assessed', () => {
    expect(composeLeanPacket(source({ unassessed: 3 }), ['g1'], 1)).toContain('4 earlier interaction groups were not carried');
    expect(composeLeanPacket(source(), ['g1', 'g2'], 0)).not.toContain('were not carried');
  });

  it('is measurably smaller than the all-groups rendering only when something was actually omitted', () => {
    const s = source();
    expect(Buffer.byteLength(composeLeanPacket(s, ['g1'], 1), 'utf8')).toBeLessThan(Buffer.byteLength(composeFullPacket(s), 'utf8'));
    expect(Buffer.byteLength(composeLeanPacket(s, ['g1', 'g2'], 0), 'utf8')).toBe(Buffer.byteLength(composeFullPacket(s), 'utf8'));
  });
});
