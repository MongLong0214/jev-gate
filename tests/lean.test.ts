import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../src/config.js';
import { MAX_REQUEST_BYTES } from '../src/jev.js';
import {
  buildLeanRequest,
  estimateTokens,
  MAX_REQUEST_TOKENS,
  composeDispatchPrompt,
  composeFullPacket,
  composeLeanPacket,
  COORDINATOR_FRAME,
  decideLean,
  HANDOFF_SCOPE_QUESTION,
  HANDOFF_SCOPE_ANSWERS,
  LEAN_OMISSION_CONFIDENCE,
  RELATION_ANSWERS,
  WORK_SHAPE_ANSWERS,
  type LeanRequestState,
} from '../src/lean.js';
import { readLeanSource, type LeanGroup, type LeanSource } from '../src/lean-source.js';
import { conversation, type Conversation } from './transcript-fixture.js';

const scopeTmp = mkdtempSync(join(tmpdir(), 'jev-lean-scope-'));
afterAll(() => rmSync(scopeTmp, { recursive: true, force: true }));
const SCOPE_SID = '7a2e9c41-0b3d-4f58-8e16-5c9d2b7f3a04';

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
  requestRecorded: false,
  coverage: 'complete',
  unassessed: 0,
  excluded: { secret: 0, window: 0, unattributed: 0 },
  hostContext: 0,
  abandoned: 0,
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
    const big = 'y'.repeat(20 * 1024);
    const packed = buildLeanRequest(source({ groups: [group('m1', 'rule', true), group('g1', big), group('g2', big), group('g3', big)] }), DEFAULT_CONFIG);
    if (!packed.ok) throw new Error(packed.reason);
    expect(Buffer.byteLength(JSON.stringify(packed.request), 'utf8')).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    // Newest first under the cap, then restored to chronological order for the answer map.
    expect(packed.askedIds.length).toBeLessThan(3);
    expect(packed.unasked).toBe(3 - packed.askedIds.length);
    // No group was sliced to make it fit.
    for (const id of packed.askedIds) expect(packed.request.state.groups[id]).toBe(big);
  });

  it('bounds the request by estimated tokens, not only by bytes', () => {
    // Observed live 2026-09-21: 123 KB of ASCII was accepted and 121 KB of Korean was refused with
    // max_tokens_exceeded. The same byte budget is three times the tokens, so bytes alone cannot bound this.
    // Each Hangul character costs a whole token, so this is far over the token cap and far under the byte cap.
    const korean = '이 함수는 반올림 버그가 있어서 값이 틀리게 나온다. 예외 조건을 반드시 유지해야 한다. '.repeat(250);
    const packed = buildLeanRequest(source({ groups: [group('m1', 'rule', true), group('g1', korean), group('g2', korean), group('g3', korean)] }), DEFAULT_CONFIG);
    if (!packed.ok) throw new Error(packed.reason);
    const body = JSON.stringify(packed.request);
    expect(estimateTokens(body)).toBeLessThanOrEqual(MAX_REQUEST_TOKENS);
    // The byte cap alone would have admitted all three; the token cap is what stops it.
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(MAX_REQUEST_BYTES);
    expect(packed.askedIds.length).toBeLessThan(3);
    expect(packed.unasked).toBe(3 - packed.askedIds.length);
  });

  it('over-counts rather than under-counts, so the estimate never lets an oversized request through', () => {
    /**
     * Calibrated twice against the live API. The first version charged ASCII at four characters per token, which is
     * prose; real transcript content billed 1.7 bytes per token and still 400'd. ASCII is now 1.5 chars per token.
     * Verified on the real 940 KB transcript afterwards: estimate 20,875, provider billed 15,560, request accepted.
     */
    expect(estimateTokens('abcdef')).toBe(4);
    expect(estimateTokens('한글')).toBe(2);
    expect(estimateTokens('')).toBe(0);
    // Every estimate is at least as large as a 4-chars-per-token reading of the same text.
    const sample = 'const x = compute(a, b); // note\n'.repeat(50);
    expect(estimateTokens(sample)).toBeGreaterThan(Math.ceil(sample.length / 4));
  });

  it('reports no room rather than sending a request with no candidate in it', () => {
    // The mandatory layer fits on its own; no candidate can be added beside it without crossing the cap.
    const packed = buildLeanRequest(source({ groups: [group('m1', 'z'.repeat(30 * 1024), true), group('g1', 'y'.repeat(20 * 1024))] }), DEFAULT_CONFIG);
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
    const packet = composeLeanPacket(s, ['g1'], { omitted: 1, unasked: 0 });
    expect(packet.split('파서를 고쳐줘').length - 1).toBe(1);
    expect(packet).toContain('예외: `as any` 금지');
    expect(packet).toContain('export const x = 1;');
    expect(packet).not.toContain('git log');
    expect(packet.indexOf('예외')).toBeLessThan(packet.indexOf('export const x'));
  });

  it('attributes the compact summary as a fallible summary without rewriting it', () => {
    const s = source({ groups: [{ id: 'm1', origin: 'compact_summary', text: 'Summary: the user chose option 2.', sourceRefs: ['s1'], mandatory: true }, group('g1', 'x')] });
    const packet = composeLeanPacket(s, [], { omitted: 1, unasked: 0 });
    expect(packet).toContain('fallible summary');
    expect(packet).toContain('Summary: the user chose option 2.');
  });

  it('says how much was left out, keeping a judgment apart from each local cap', () => {
    const s = source({ unassessed: 3, excluded: { secret: 1, window: 2, unattributed: 0 } });
    const packet = composeLeanPacket(s, ['g1'], { omitted: 1, unasked: 2 });
    expect(packet).toContain('6 earlier interaction groups were not carried');
    expect(packet).toContain('1 left out as unrelated to this request');
    expect(packet).toContain('2 never assessed: older than the enumeration window');
    expect(packet).toContain('1 never assessed: withheld as possibly credential-bearing');
    expect(packet).toContain('2 never assessed: did not fit the selection request');
    expect(composeLeanPacket(source(), ['g1', 'g2'], { omitted: 0, unasked: 0 })).not.toContain('were not carried');
  });

  it('never calls a group dropped by a local cap unrelated (L7)', () => {
    const packet = composeLeanPacket(source({ unassessed: 1, excluded: { secret: 0, window: 1, unattributed: 0 } }), ['g1', 'g2'], { omitted: 0, unasked: 0 });
    expect(packet).toContain('1 earlier interaction group was not carried');
    expect(packet).not.toContain('unrelated');
  });

  it('is measurably smaller than the all-groups rendering only when something was actually omitted', () => {
    const s = source();
    expect(Buffer.byteLength(composeLeanPacket(s, ['g1'], { omitted: 1, unasked: 0 }), 'utf8')).toBeLessThan(Buffer.byteLength(composeFullPacket(s), 'utf8'));
    expect(Buffer.byteLength(composeLeanPacket(s, ['g1', 'g2'], { omitted: 0, unasked: 0 }), 'utf8')).toBe(Buffer.byteLength(composeFullPacket(s), 'utf8'));
  });
});

/** Shaped like a key and matched by the screen; not a credential. */
const FAKE_KEY = `sk-${'testonlynotakey'.repeat(2)}`;

describe('lean outbound privacy boundary (L1)', () => {
  it('stays native when a credential appears only in the current request', () => {
    const packed = buildLeanRequest(source({ request: `이 키로 호출해줘 ${FAKE_KEY}` }), DEFAULT_CONFIG);
    expect(packed).toEqual({ ok: false, reason: 'mandatory_unsafe' });
  });

  it('stays native when a credential appears in required context', () => {
    const packed = buildLeanRequest(source({ groups: [group('m1', `earlier: use ${FAKE_KEY}`, true), group('g1', 'x')] }), DEFAULT_CONFIG);
    expect(packed).toEqual({ ok: false, reason: 'mandatory_unsafe' });
  });

  it('never exports an optional group that screens as a credential, and counts it as never asked', () => {
    const packed = buildLeanRequest(source({ groups: [group('m1', 'rule', true), group('g1', `[tool_result] ${FAKE_KEY}`), group('g2', 'plain')] }), DEFAULT_CONFIG);
    if (!packed.ok) throw new Error(packed.reason);
    expect(packed.askedIds).toEqual(['g2']);
    expect(packed.unasked).toBe(1);
    expect(JSON.stringify(packed.request)).not.toContain(FAKE_KEY);
  });
});

describe('lean dispatch composition (L7)', () => {
  it("keeps the calling agent's text as the exact prefix and frames it below the user's words", () => {
    const coordinator = 'Implement the parser fix. [jev-lean-0123456789abcdef]';
    const composed = composeDispatchPrompt(coordinator, 'PACKET');
    expect(composed.startsWith(coordinator)).toBe(true);
    expect(composed.indexOf(COORDINATOR_FRAME)).toBeGreaterThan(coordinator.length - 1);
    expect(composed.indexOf(COORDINATOR_FRAME)).toBeLessThan(composed.indexOf('PACKET'));
    expect(COORDINATOR_FRAME).toContain("the user's words govern");
  });
});

describe('scoped instructions (handoff_scope criteria)', () => {
  it('asks whether an earlier restriction still covers this request, instead of treating every retained ban as global', () => {
    const forbidden = HANDOFF_SCOPE_QUESTION.criteria.forbidden;
    expect(forbidden).toContain('still covers this request');
    expect(forbidden).toContain('different, earlier task does not cover this request');
    expect(forbidden).toContain('not a user restriction');
    // Unknown scope stays conservative: it is not self_contained.
    expect(HANDOFF_SCOPE_QUESTION.criteria.unclear).toContain('whether it still covers this request cannot be told');
  });

  it('carries an earlier scoped instruction as required human context, so the scope can be judged at all', () => {
    const s = source({
      request: '이제 파서 버그를 고쳐줘',
      groups: [group('m1', '이 읽기는 네가 직접 해라', true), group('g1', '[tool_use Read] {"file_path":"src/p.ts"}\n[tool_result] ...')],
    });
    const packed = buildLeanRequest(s, DEFAULT_CONFIG);
    if (!packed.ok) throw new Error(packed.reason);
    expect(JSON.stringify(packed.request.state)).toContain('이 읽기는 네가 직접 해라');
  });

  // Four kinds of restriction, read from a host-shaped transcript by the real source adapter. What these establish is
  // where each one reaches Jev and with what attribution -- the input a scope judgement needs -- not how Jev judges it.
  const BAN = '서브에이전트나 다른 워커에게 넘기지 마라';
  const scoped = (build: (c: Conversation) => void, request: string): LeanRequestState => {
    const c = conversation(SCOPE_SID);
    build(c);
    const r = readLeanSource(c.write(mkdtempSync(join(scopeTmp, 'c-'))), { request, promptId: 'now', sessionId: SCOPE_SID, phase: 'prompt' });
    if (!r.ok) throw new Error(`${r.reason}: ${r.detail}`);
    const packed = buildLeanRequest(r.source, DEFAULT_CONFIG);
    if (!packed.ok) throw new Error(packed.reason);
    return packed.request.state;
  };
  const reading = (c: Conversation): void => {
    c.call('Bash', { command: 'cat reference/note-01.md' }, '# note-01\nsym0001 sym0002');
    c.say('준비됨');
  };

  it('a prohibition on the current task is in the request itself', () => {
    const state = scoped((c) => {
      c.human('reference/ 를 읽어라', 'p1');
      reading(c);
    }, `검증 모듈을 고쳐줘. ${BAN}`);
    expect(state.request).toContain(BAN);
    expect(JSON.stringify(state.mandatory)).not.toContain(BAN);
  });

  it('a session-wide prohibition in an earlier message reaches Jev as the user\'s own words, before the request', () => {
    const state = scoped((c) => {
      c.human(`이 세션이 끝날 때까지 어떤 작업도 ${BAN}`, 'p1');
      reading(c);
    }, '검증 모듈을 고쳐줘');
    expect(state.mandatory.map((m) => [m.origin, m.text])).toEqual([['human', `이 세션이 끝날 때까지 어떤 작업도 ${BAN}`]]);
    expect(state.request).not.toContain(BAN);
  });

  it('a completed earlier task\'s local restriction is carried with the words that scope it, not widened or dropped', () => {
    // The depth fixtures' priming shape: the restriction names "이 읽기" -- this reading -- which then finished.
    const prime = `reference/ 를 읽어라. 이 읽기는 네가 직접 해라. ${BAN}`;
    const state = scoped((c) => {
      c.human(prime, 'p1');
      reading(c);
    }, '검증 모듈을 고쳐줘');
    expect(state.mandatory.map((m) => [m.origin, m.text])).toEqual([['human', prime]]);
    expect(state.request).toBe('검증 모듈을 고쳐줘');
  });

  it('quoted tool content is never the user\'s restriction: optional, or labelled with its tool origin when referenced', () => {
    const build = (c: Conversation): void => {
      c.human('설정 문서를 읽어봐', 'p1');
      c.call('Read', { file_path: 'docs/guide.md' }, `규칙: ${BAN}`);
      // Something left to select once the quoted read is itself required.
      c.call('Bash', { command: 'git log -1' }, 'abc123');
    };
    const unreferenced = scoped(build, '검증 모듈을 고쳐줘');
    expect(JSON.stringify(unreferenced.mandatory)).not.toContain(BAN);
    expect(Object.values(unreferenced.groups).join('\n')).toContain(BAN);
    // The scope question reads only request and mandatory, so an optional group cannot supply a ban.
    expect(HANDOFF_SCOPE_QUESTION.instructions).toContain('Ignore state.groups entirely');

    const referenced = scoped(build, 'docs/guide.md 대로 검증 모듈을 고쳐줘');
    const quoted = referenced.mandatory.filter((m) => m.text.includes(BAN));
    expect(quoted.map((m) => m.origin)).toEqual(['assistant_tool']);
  });

  it.each([
    // lean-3's answers on the depth fixtures: forbidden, below the action floor.
    ['forbidden at 0.54', 'forbidden', 0.54],
    ['forbidden at 0.67', 'forbidden', 0.67],
    ['self_contained below the floor', 'self_contained', 0.79],
  ])('stays native without calling it a ban on %s', (_name, winner, confidence) => {
    const d = decideLean(answers({ handoff_scope: choice(HANDOFF_SCOPE_ANSWERS, winner, confidence) }), ['g1', 'g2']);
    expect(d.action).toBe('direct');
    expect(d.reason).toBe('scope_unusable');
    expect(d.retainedGroupIds).toEqual(['g1', 'g2']);
  });
});
