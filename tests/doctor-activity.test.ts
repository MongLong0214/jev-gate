import { describe, expect, it } from 'vitest';

import { activityChecks, type ActivityCheck, type ActivityInput } from '../src/doctor-activity.js';

/** #279: every activity check against a fixture trace that breaks it and one that does not. Fake records only. */
type Rec = Record<string, unknown>;
const NOW = Date.parse('2026-10-20T03:00:00.000Z');
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
const rec = (phase: string, body: Rec = {}, minutes = 10): Rec => ({ phase, session_id: 's1', written_at: ago(minutes), ...body });
const router = (event: string, body: Rec = {}, minutes = 10): Rec => rec('mod_router', { event, ...body }, minutes);
const times = (n: number, make: (i: number) => Rec): Rec[] => Array.from({ length: n }, (_, i) => make(i));
const run = (claude: Rec[], over: Partial<ActivityInput> = {}): ActivityCheck[] => activityChecks({
  traces: { claude: { records: claude, unreadable: 0 } }, now: NOW, installed: '0.8.31', recording: true, keyPresent: true, codexOwner: null, liveness: null, ...over,
});
const check = (checks: ActivityCheck[], name: string): ActivityCheck => {
  const found = checks.find(c => c.message.startsWith(`${name}:`));
  expect(found, `${name} in ${checks.map(c => c.message).join('\n')}`).toBeDefined();
  return found!;
};
const level = (claude: Rec[], name: string, over: Partial<ActivityInput> = {}): string => check(run(claude, over), name).level;

describe('activity: untrackable (#279)', () => {
  it('warns 추적 불가 when there is no trace at all, and judges nothing else', () => {
    const checks = run([]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('추적 불가') });
    expect(checks[0]!.action).toBeTruthy();
  });

  it('warns 추적 불가 when recording is off or every record is older than 24 h', () => {
    expect(run([rec('guard')], { recording: false })[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('local recording is off') });
    expect(run([rec('guard', {}, 25 * 60)])[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('no trace records in the last 24 h') });
  });
});

describe('activity: hook_version', () => {
  it('warns about a session that recorded an older hook in the last 2 h', () => {
    const c = check(run([router('root', { hook_version: '0.8.29', session_id: 'stale-session' }, 30)]), 'hook_version');
    expect(c).toMatchObject({ level: 'warn', message: expect.stringContaining('stale-se v0.8.29') });
    expect(c.action).toMatch(/Restart/);
  });

  it('is ok on the installed hook, and ignores sessions quiet for 2 h', () => {
    expect(level([router('root', { hook_version: '0.8.31' }, 30)], 'hook_version')).toBe('ok');
    expect(level([router('root', { hook_version: '0.8.29' }, 3 * 60)], 'hook_version')).toBe('info');
  });
});

describe('activity: gate_a', () => {
  const call = (shape = 'direct', code: string | null = null): Rec => rec('admission_result', { attempted: true, decision: { shape }, http: { status: code ? null : 200, code, duration_ms: 230 } });
  it('warns at 50+ calls with nothing orchestrated', () => {
    const c = check(run(times(50, () => call())), 'gate_a');
    expect(c).toMatchObject({ level: 'warn', message: expect.stringContaining('50 Jev calls, 0 orchestrated') });
    expect(c.message).toMatch(/p50 230 ms \/ p90 230 ms/);
  });

  it('is ok once a call orchestrated', () => {
    expect(level([...times(49, () => call()), call('orchestrated')], 'gate_a')).toBe('ok');
  });

  it('fails above a 10% error rate over 20 calls', () => {
    const c = check(run([...times(17, () => call()), ...times(3, () => call('direct', 'timeout'))]), 'gate_a');
    expect(c).toMatchObject({ level: 'fail', message: expect.stringContaining('errors 3 (15.0%: timeout 3)') });
  });

  it('warns when the liveness ring shows a full window that never called Jev', () => {
    const liveness = { version: 1 as const, recent: Array.from({ length: 50 }, () => ({ at: ago(1), attempted: false, reason: 'depth_below_floor' })) };
    expect(check(run([rec('guard')], { liveness }), 'gate_a')).toMatchObject({ level: 'warn', message: expect.stringContaining('liveness 0/50'), action: expect.stringMatching(/never calls Jev/) });
  });
});

describe('activity: gate_b', () => {
  const route = (tier: string): Rec => rec('pre_result', { called_tier: 'standard', decision: { tier } });
  it('warns at 5 decisions that changed no tier', () => expect(level(times(5, () => route('standard')), 'gate_b')).toBe('warn'));
  it('is ok when a decision changed the tier', () => expect(level([...times(4, () => route('standard')), route('fast')], 'gate_b')).toBe('ok'));
});

describe('activity: plan', () => {
  it('warns about a ready plan never interpreted', () => expect(level([rec('plan', { outcome: 'ready' })], 'plan')).toBe('warn'));
  it('is ok with an interpretation', () => expect(level([rec('plan', { outcome: 'ready' }), rec('interpretation_result')], 'plan')).toBe('ok'));
});

describe('activity: worker', () => {
  const worker = (verdict: string, checks: Rec | null, reason: string | null = null): Rec => rec('post', { subagent_type: 'jev-gate:worker', verdict, verdict_reason: reason, reported_checks: checks });
  it('warns about an incomplete result and an accept with no checks, and counts native calls apart', () => {
    const c = check(run([worker('accept', { pass: 0, fail: 0, not_run: 0 }), worker('incomplete', { pass: 2, fail: 0, not_run: 0 }, 'no passing run'), rec('post', { subagent_type: 'general-purpose' })]), 'worker');
    expect(c.level).toBe('warn');
    expect(c.message).toMatch(/2 Gate worker\/planner results -- accept 1, incomplete 1; 1 accepted with no checks run; "no passing run"; 1 native Agent calls \(예약 외 호출/);
  });

  it('is ok when every result was accepted with checks', () => expect(level([worker('accept', { pass: 2, fail: 0, not_run: 0 })], 'worker')).toBe('ok'));
});

describe('activity: guard', () => {
  it('warns on a denial and names the tool', () => {
    expect(check(run([rec('guard', { tool_name: 'Edit', allow: false, stopped: true })]), 'guard')).toMatchObject({ level: 'warn', message: expect.stringContaining('1 denials (Edit 1), 1 budget-exhausted stops') });
  });
  it('is ok with no denials', () => expect(level(times(15, () => rec('guard', { tool_name: 'Bash', allow: true, stopped: false })), 'guard')).toBe('ok'));
});

describe('activity: background', () => {
  it('warns on a failed background worker', () => expect(level([rec('background_terminal', { status: 'failed' })], 'background')).toBe('warn'));
  it('is ok when every worker completed', () => expect(level([rec('background_terminal', { status: 'completed' })], 'background')).toBe('ok'));
});

describe('activity: router_applied', () => {
  it('fails when another family answered', () => {
    expect(check(run([router('root_result', { requested: 'claude-opus-5-5', observed: 'claude-sonnet-5-5' })]), 'router_applied')).toMatchObject({ level: 'fail', message: expect.stringContaining('opus->sonnet 1') });
  });
  it('is ok when the requested family answered', () => expect(level([router('child_result', { agent_id: 'a1', requested: 'claude-haiku-5-5', observed: 'claude-haiku-5-5' })], 'router_applied')).toBe('ok'));
});

describe('activity: router_released', () => {
  const turn = (...after: Rec[]): Rec[] => [
    router('root', { scope: 'root', turn: 't1', patch: { model: 'claude-haiku-5-5' } }, 10),
    router('prepared', { scope: 'root', turn: 't1', index: 0, routed: true }, 10),
    ...after,
  ];
  const released = router('prepared', { scope: 'root', turn: 't1', index: 1, routed: false }, 8);
  it('fails when a patched turn goes unrouted mid-turn without a reason, even if the turn ends later', () => {
    expect(level(turn(released, router('turn_end', { scope: 'root', turn: 't1' }, 7)), 'router_released')).toBe('fail');
  });
  it('is ok when a root_stop or context_reset precedes it, or after a turn_end', () => {
    expect(level(turn(router('root_stop', { turn: 't1', index: 1 }, 8), released), 'router_released')).toBe('ok');
    expect(level(turn(router('context_reset', { scope: 'root', turn: 't1', index: 1 }, 8), released), 'router_released')).toBe('ok');
    expect(level(turn(router('turn_end', { scope: 'root', turn: 't1' }, 9), released), 'router_released')).toBe('ok');
  });
  it('ignores a child step and an unpatched turn', () => {
    expect(level([router('root', { scope: 'root', turn: 't2', patch: {} }), router('prepared', { scope: 'root', turn: 't2', index: 1, routed: false })], 'router_released')).toBe('info');
    expect(level(turn(router('prepared', { scope: 'child', agent_id: 'a1', turn: 't1', index: 1, routed: false }, 8)), 'router_released')).toBe('ok');
  });
});

describe('activity: router_cost', () => {
  const result = (observed: string, usage: Rec, minutes: number): Rec => router('root_result', { requested: observed, observed, usage }, minutes);
  it('fails when the Opus rewrite on return outweighs a short switch at both TTLs', () => {
    const c = check(run([
      result('claude-opus-5-5', { input: 2, output: 100, cache_read: 90_000, cache_creation: 1000 }, 30),
      result('claude-haiku-5-5', { input: 2, output: 100, cache_read: 0, cache_creation: 90_000 }, 29),
      result('claude-opus-5-5', { input: 2, output: 100, cache_read: 0, cache_creation: 90_000 }, 28),
    ]), 'router_cost');
    expect(c.level).toBe('fail');
    expect(c.message).toMatch(/1 non-Opus root requests over 1 switches; net -\$0\.\d\d at 5m \/ -\$0\.\d\d at 1h/);
  });

  it('is ok when a long switch saves more than its rewrite', () => {
    const c = check(run([
      result('claude-opus-5-5', { input: 2, output: 100, cache_read: 50_000, cache_creation: 1000 }, 60),
      result('claude-haiku-5-5', { input: 2, output: 2000, cache_read: 0, cache_creation: 50_000 }, 59),
      ...times(10, i => result('claude-haiku-5-5', { input: 2, output: 2000, cache_read: 50_000, cache_creation: 1000 }, 58 - i)),
    ]), 'router_cost');
    expect(c.level).toBe('ok');
    expect(c.message).toMatch(/11 non-Opus root requests over 1 switches; net \+\$\d+\.\d\d at 5m \/ \+\$\d+\.\d\d at 1h/);
  });

  it('charges no rewrite when the return comes after the cache would have expired anyway', () => {
    const rows = (gap: number): Rec[] => [
      result('claude-opus-5-5', { input: 2, output: 100, cache_read: 90_000, cache_creation: 1000 }, 200),
      result('claude-haiku-5-5', { input: 2, output: 100, cache_read: 0, cache_creation: 90_000 }, 199),
      result('claude-opus-5-5', { input: 2, output: 100, cache_read: 0, cache_creation: 90_000 }, 199 - gap),
    ];
    expect(check(run(rows(120)), 'router_cost').message).toMatch(/net \+\$0\.\d\d at 5m \/ \+\$0\.\d\d at 1h/);
    expect(check(run(rows(10)), 'router_cost').message).toMatch(/net \+\$0\.\d\d at 5m \/ -\$0\.\d\d at 1h/);
  });

  it('is ok with no switch at all', () => expect(check(run([result('claude-opus-5-5', { input: 2, output: 1, cache_read: 1, cache_creation: 1 }, 5)]), 'router_cost').message).toMatch(/no root model switch/));
});

describe('activity: spawn_coverage', () => {
  it('warns about a root Agent call outside routing and an unregistered child with its steps', () => {
    const c = check(run([
      rec('post', { caller: { agent_id: null }, subagent_type: 'general-purpose', tool_use_id: 'u1' }),
      router('child_route', { agent_id: 'fork', sent: false, skipped: 'child_unregistered' }),
      router('child_route', { agent_id: 'fork', sent: false, skipped: 'native_child' }),
    ]), 'spawn_coverage');
    expect(c).toMatchObject({ level: 'warn', message: expect.stringContaining('1 root Agent calls with neither a Router spawn record nor a Gate-owned type (general-purpose 1); 1 unregistered children ran 2 unrouted steps') });
  });

  it('is ok when every root Agent call was routed or Gate-owned', () => {
    expect(level([
      rec('post', { caller: { agent_id: null }, subagent_type: 'general-purpose', tool_use_id: 'u1' }), router('spawn', { tool_use_id: 'u1' }),
      rec('post', { caller: { agent_id: null }, subagent_type: 'jev-gate:worker', tool_use_id: 'u2' }),
    ], 'spawn_coverage')).toBe('ok');
  });
});

describe('activity: child_effect', () => {
  const step = (effort: string): Rec => router('child_route', { agent_id: 'a1', sent: true, from: { effort: 'high' }, patch: { effort } });
  it('warns at 50 sent steps that changed under 5%', () => expect(level([...times(48, () => step('high')), ...times(2, () => step('low'))], 'child_effect')).toBe('warn'));
  it('is ok when steps changed the effort', () => expect(level([...times(45, () => step('high')), ...times(5, () => step('low'))], 'child_effect')).toBe('ok'));
});

describe('activity: compact', () => {
  const pre = (body: Rec = {}, minutes = 30): Rec => rec('mod_compact', { stage: 'pre', mode: 'active', selection: 'selected', ...body }, minutes);
  it('fails on a pre with no post', () => expect(check(run([pre()]), 'compact')).toMatchObject({ level: 'fail', message: expect.stringContaining('1 pre without post (sessions s1)') }));
  it('does not judge a compaction still in flight', () => expect(level([pre({}, 1)], 'compact')).toBe('ok'));
  it('is ok for a full pre / restore / post', () => expect(level([pre(), rec('mod_compact', { stage: 'restore' }, 29), rec('mod_compact', { stage: 'post' }, 29)], 'compact')).toBe('ok'));
  it('warns when Jev was recorded disabled with a key present, or answered invalid', () => {
    expect(level([pre({ selection: 'disabled' }), rec('mod_compact', { stage: 'restore' }, 29), rec('mod_compact', { stage: 'post' }, 29)], 'compact')).toBe('warn');
    expect(level([pre(), rec('mod_compact', { stage: 'jev', selection: 'invalid_answers' }, 30), rec('mod_compact', { stage: 'restore' }, 29), rec('mod_compact', { stage: 'post' }, 29)], 'compact')).toBe('warn');
  });
});

describe('activity: codex_connection', () => {
  const session = (id: string, minutes = 10): Rec[] => [rec('codex_event', { host: 'codex', event: 'SessionStart', session_id: id }, minutes), rec('codex_event', { host: 'codex', event: 'UserPromptSubmit', session_id: id }, minutes)];
  const prompt = session('c1');
  const codex = (records: Rec[], over: Partial<ActivityInput> = {}): ActivityCheck => check(activityChecks({
    traces: { codex: { records, unreadable: 0 } }, now: NOW, installed: '0.8.31', recording: true, keyPresent: true, codexOwner: null, liveness: null, ...over,
  }), 'codex_connection');
  it('fails when the owner points at a missing root', () => {
    expect(codex([...prompt, rec('codex_router_result', { host: 'codex' })], { codexOwner: { root: '/gone/0.8.29', rootExists: false, pidAlive: true, since: 0 } })).toMatchObject({ level: 'fail', message: expect.stringContaining('owner root /gone/0.8.29 missing') });
  });
  it('fails when Codex sessions ran with no router record', () => {
    expect(codex([...prompt], { codexOwner: { root: '/plugin/0.8.31', rootExists: true, pidAlive: true, since: 0 } })).toMatchObject({ level: 'fail', message: expect.stringContaining('1 Codex sessions started and prompted since, 1 with no codex_router record') });
  });
  it('does not hold sessions prompted before the current connection against it', () => {
    const live = { root: '/plugin/0.8.31', rootExists: true, pidAlive: true, since: NOW - 5 * 60_000 };
    expect(codex([...prompt], { codexOwner: live })).toMatchObject({ level: 'ok', message: expect.stringContaining('0 Codex sessions started and prompted since') });
    expect(codex([...prompt, ...session('c2', 1)], { codexOwner: live }).level).toBe('fail');
  });
  it('is ok with a live owner and routed sessions', () => {
    expect(codex([...prompt, rec('codex_router_result', { host: 'codex', session_id: 'c1' })], { codexOwner: { root: '/plugin/0.8.31', rootExists: true, pidAlive: true, since: 0 } }).level).toBe('ok');
  });
});

describe('activity: failures and evidence', () => {
  it('warns on failure records by category', () => {
    expect(check(run([rec('failure', { failure_category: 'preflight_conflict' })]), 'failures')).toMatchObject({ level: 'warn', message: 'failures: 1 failure records (preflight_conflict 1)' });
  });
  it('is ok with none, and counts Evidence calls per host as info', () => {
    const checks = activityChecks({ traces: { claude: { records: [rec('guard')], unreadable: 0 }, codex: { records: [rec('evidence_result', { host: 'codex' })], unreadable: 2 } }, now: NOW, installed: '0.8.31', recording: true, keyPresent: true, codexOwner: null, liveness: null });
    expect(check(checks, 'failures').level).toBe('ok');
    expect(check(checks, 'evidence')).toEqual({ level: 'info', message: 'evidence: Claude 0 calls, Codex 1 calls; 2 unreadable trace files', action: null });
  });
});
