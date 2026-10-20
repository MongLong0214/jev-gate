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
    expect(run([rec('admission_result')], { recording: false })[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('local recording is off') });
    expect(run([rec('admission_result', {}, 25 * 60)])[0]).toMatchObject({ level: 'warn', message: expect.stringContaining('no trace records in the last 24 h') });
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
    expect(check(run([rec('admission_result')], { liveness }), 'gate_a')).toMatchObject({ level: 'warn', message: expect.stringContaining('liveness 0/50'), action: expect.stringMatching(/never calls Jev/) });
  });
});

describe('activity: gate_b', () => {
  const route = (tier: string): Rec => rec('pre_result', { role: 'worker', called_tier: 'standard', decision: { tier } });
  it('warns at 5 worker decisions that changed no called tier', () => {
    expect(check(run(times(5, () => route('standard'))), 'gate_b')).toMatchObject({ level: 'warn', message: 'gate_b: 5 routing decisions, 0 changed the called tier; reasons none 5' });
  });
  it('counts a worker decision that changed the called tier', () => {
    expect(check(run([...times(4, () => route('standard')), route('fast')]), 'gate_b')).toMatchObject({ level: 'ok', message: 'gate_b: 5 routing decisions, 1 changed the called tier; reasons none 5' });
  });
  it('does not count an absent baseline as a tier change', () => {
    expect(check(run([rec('pre_result', { role: 'worker', decision: { tier: 'deep' } })]), 'gate_b').message).toContain('0 changed the called tier');
  });
});

describe('activity: worker', () => {
  const worker = (verdict: string, checks: Rec | null, reason: string | null = null): Rec => rec('post', { subagent_type: 'jev-gate:worker', verdict, verdict_reason: reason, reported_checks: checks });
  it('warns about an incomplete result and an accept with no checks, and counts native calls apart', () => {
    const c = check(run([worker('accept', { pass: 0, fail: 0, not_run: 0 }), worker('incomplete', { pass: 2, fail: 0, not_run: 0 }, 'no passing run'), rec('post', { subagent_type: 'general-purpose' })]), 'worker');
    expect(c.level).toBe('warn');
    expect(c.message).toMatch(/2 Gate worker results -- accept 1, incomplete 1; 1 accepted with no checks run; "no passing run"; 1 native Agent calls \(예약 외 호출/);
  });

  it('is ok when every result was accepted with checks', () => expect(level([worker('accept', { pass: 2, fail: 0, not_run: 0 })], 'worker')).toBe('ok'));
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
  // A routed request carries its turn's decision (baseline Opus, patched to Haiku) and a routed `prepared` step.
  let index = 0;
  const result = (observed: string, usage: Rec, minutes: number, session = 's1'): Rec[] => {
    const at = { session_id: session, scope: 'root', turn: `t-${session}-${index++}`, index: 0 };
    return [
      ...(observed.includes('opus') ? [] : [router('root', { ...at, from: { model: 'claude-opus-5-5' }, patch: { model: 'claude-haiku-5-5' } }, minutes), router('prepared', { ...at, routed: true }, minutes)]),
      router('root_result', { ...at, requested: observed, applied: { model: observed }, observed, usage }, minutes),
    ];
  };
  const losing = (): Rec[] => [
    ...result('claude-opus-5-5', { input: 2, output: 100, cache_read: 90_000, cache_creation: 1000 }, 30),
    ...result('claude-haiku-5-5', { input: 2, output: 100, cache_read: 0, cache_creation: 90_000 }, 29),
    ...result('claude-opus-5-5', { input: 2, output: 100, cache_read: 0, cache_creation: 90_000 }, 28),
  ];
  it('fails when the Opus rewrite on return outweighs a short switch at both TTLs', () => {
    const c = check(run(losing()), 'router_cost');
    expect(c.level).toBe('fail');
    expect(c.message).toMatch(/1 routed root requests off their turn's baseline model over 1 switches; net -\$0\.\d\d at 5m \/ -\$0\.\d\d at 1h/);
  });

  it.each(['input', 'cache_read', 'cache_creation', 'output'])('ACT-USAGE-01 keeps a losing return with missing %s unknown', (counter) => {
    const rows = losing(), returning = rows.at(-1)!;
    delete (returning['usage'] as Rec)[counter];
    const c = check(run(rows), 'router_cost');
    expect(c).toMatchObject({ level: 'warn', message: expect.stringContaining('unknown/untracked') });
    expect(c.message).toContain('1 root requests with incomplete usage; 1 sessions excluded');
    expect(c.message).not.toContain('net ');
  });

  it('ACT-USAGE-01 computes explicit zero counters', () => {
    const c = check(run(result('claude-haiku-5-5', { input: 0, cache_read: 0, cache_creation: 0, output: 2000 }, 5)), 'router_cost');
    expect(c.level).toBe('ok');
    expect(c.message).toMatch(/net \+\$0\.04 at 5m \/ \+\$0\.04 at 1h/);
    expect(c.message).not.toContain('unknown');
    const zero = check(run(result('claude-haiku-5-5', { input: 0, cache_read: 0, cache_creation: 0, output: 0 }, 5)), 'router_cost');
    expect(zero.level).toBe('ok');
    expect(zero.message).toContain('net +$0.00 at 5m / +$0.00 at 1h');
  });

  it.each(['input', 'cache_read', 'cache_creation', 'output'])('ACT-USAGE-01 distinguishes mixed zero and missing %s', (counter) => {
    const usage: Rec = { input: 0, cache_read: 0, cache_creation: 0, output: 2000 };
    delete usage[counter];
    const c = check(run(result('claude-haiku-5-5', usage, 5)), 'router_cost');
    expect(c).toMatchObject({ level: 'warn', message: expect.stringContaining('unknown/untracked') });
    expect(c.message).not.toContain('net ');
  });

  it('ACT-USAGE-01 excludes partial accounting even with numeric counters', () => {
    const rows = losing();
    rows.at(-1)!['accounting'] = { coverage: 'partial' };
    const c = check(run(rows), 'router_cost');
    expect(c).toMatchObject({ level: 'warn', message: expect.stringContaining('unknown/untracked') });
    expect(c.message).not.toContain('net ');
  });

  it('ACT-USAGE-01 prevents a positive verdict with partial accounting', () => {
    const positive = result('claude-haiku-5-5', { input: 0, cache_read: 0, cache_creation: 0, output: 2000 }, 5);
    positive.at(-1)!['accounting'] = { coverage: 'partial' };
    expect(check(run(positive), 'router_cost').level).toBe('warn');
  });

  it('gives native requests in another session no savings, so they cannot hide a loss', () => {
    const native = (minutes: number): Rec => router('root_result', { session_id: 's2', turn: 'n', index: minutes, requested: 'claude-haiku-5-5', observed: 'claude-haiku-5-5', usage: { input: 2, output: 2000, cache_read: 50_000, cache_creation: 1000 } }, minutes);
    const rows = losing(), alone = check(run(rows), 'router_cost');
    const c = check(run([...rows, router('root_result', { session_id: 's2', turn: 'n', index: 99, requested: 'claude-opus-5-5', observed: 'claude-opus-5-5', usage: { input: 2, output: 100, cache_read: 50_000, cache_creation: 1000 } }, 60), ...times(50, i => native(59 - i))]), 'router_cost');
    expect(c.level).toBe('fail');
    expect(c.message).toMatch(/^router_cost: 1 routed root requests off their turn's baseline model over 1 switches; net -\$0\.\d\d at 5m/);
    expect(c.message.match(/; net .*?write prices/)?.[0]).toBe(alone.message.match(/; net .*?write prices/)?.[0]);
  });

  it('credits only the recorded model patch applied to the matching request and response', () => {
    const rows = result('claude-haiku-5-5', { input: 2, output: 2000, cache_read: 50_000, cache_creation: 1000 }, 5);
    const variants = [
      rows.filter(r => r['event'] !== 'root'),
      rows.map(r => r['event'] === 'prepared' ? { ...r, routed: false } : r),
      rows.map(r => r['event'] === 'prepared' ? { ...r, index: 1 } : r),
      rows.map(r => r['event'] === 'prepared' ? { ...r, session_id: 's2' } : r),
      rows.map(r => r['event'] === 'root' ? { ...r, patch: { effort: 'low' } } : r),
      rows.map(r => r['event'] === 'root_result' ? { ...r, applied: { model: 'claude-opus-5-5' } } : r),
      rows.map(r => r['event'] === 'root_result' ? { ...r, requested: 'claude-opus-5-5' } : r),
      rows.map(r => r['event'] === 'root_result' ? { ...r, observed: 'claude-sonnet-5-5' } : r),
    ];
    for (const records of variants) expect(check(run(records), 'router_cost').message).toMatch(/no routed root model switch/);
  });

  it('is ok when a long switch saves more than its rewrite', () => {
    const c = check(run([
      ...result('claude-opus-5-5', { input: 2, output: 100, cache_read: 50_000, cache_creation: 1000 }, 60),
      ...result('claude-haiku-5-5', { input: 2, output: 2000, cache_read: 0, cache_creation: 50_000 }, 59),
      ...Array.from({ length: 10 }, (_, i) => result('claude-haiku-5-5', { input: 2, output: 2000, cache_read: 50_000, cache_creation: 1000 }, 58 - i)).flat(),
    ]), 'router_cost');
    expect(c.level).toBe('ok');
    expect(c.message).toMatch(/11 routed root requests off their turn's baseline model over 1 switches; net \+\$\d+\.\d\d at 5m \/ \+\$\d+\.\d\d at 1h/);
  });

  it('charges no rewrite when the return comes after the cache would have expired anyway', () => {
    const rows = (gap: number): Rec[] => [
      ...result('claude-opus-5-5', { input: 2, output: 100, cache_read: 90_000, cache_creation: 1000 }, 200),
      ...result('claude-haiku-5-5', { input: 2, output: 100, cache_read: 0, cache_creation: 90_000 }, 199),
      ...result('claude-opus-5-5', { input: 2, output: 100, cache_read: 0, cache_creation: 90_000 }, 199 - gap),
    ];
    expect(check(run(rows(120)), 'router_cost').message).toMatch(/net \+\$0\.\d\d at 5m \/ \+\$0\.\d\d at 1h/);
    expect(check(run(rows(10)), 'router_cost').message).toMatch(/net \+\$0\.\d\d at 5m \/ -\$0\.\d\d at 1h/);
  });

  it('is ok with no switch at all', () => expect(check(run(result('claude-opus-5-5', { input: 2, output: 1, cache_read: 1, cache_creation: 1 }, 5)), 'router_cost').message).toMatch(/no routed root model switch/));
  it('does not credit a native non-Opus session as a Router switch', () => {
    expect(check(run([router('root_result', { requested: 'claude-haiku-5-5', observed: 'claude-haiku-5-5', usage: { input: 2, output: 2000, cache_read: 50_000, cache_creation: 1000 } })]), 'router_cost').message).toMatch(/no routed root model switch/);
  });
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
  it('does not report Compact for a Codex-only diagnosis', () => {
    const checks = run([], { traces: { codex: { records: [rec('codex_event', { host: 'codex', event: 'UserPromptSubmit' })], unreadable: 0 } } });
    expect(checks.some(c => c.message.startsWith('compact:'))).toBe(false);
  });

  const pre = (body: Rec = {}, minutes = 30): Rec => rec('mod_compact', { stage: 'pre', mode: 'active', selection: 'selected', ...body }, minutes);
  it('fails on a pre with no post', () => expect(check(run([pre()]), 'compact')).toMatchObject({ level: 'fail', message: expect.stringContaining('1 pre without post (sessions s1)') }));
  it('does not judge a compaction still in flight', () => expect(level([pre({}, 1)], 'compact')).toBe('ok'));
  it('is ok for a full pre / restore / post', () => expect(level([pre(), rec('mod_compact', { stage: 'restore' }, 29), rec('mod_compact', { stage: 'post' }, 29)], 'compact')).toBe('ok'));
  it('does not let a recent session restore hide an older missing restore', () => {
    const other = (stage: string, minutes: number): Rec => rec('mod_compact', { stage, session_id: 's2', ...(stage === 'pre' ? { mode: 'active', selection: 'selected' } : {}) }, minutes);
    const c = check(run([pre(), rec('mod_compact', { stage: 'post' }, 29), other('pre', 2), other('restore', 1), other('post', 1)]), 'compact');
    expect(c).toMatchObject({ level: 'warn', message: expect.stringContaining('2 pre / 1 restore / 2 post; 1 without restore (sessions s1)') });
    expect(level([pre({ mode: 'shadow' }), rec('mod_compact', { stage: 'post' }, 29), other('pre', 2), other('restore', 1), other('post', 1)], 'compact')).toBe('ok');
  });
  it('matches restores with interleaved sessions', () => {
    const c = check(run([
      pre(), pre({ session_id: 's2' }, 29),
      rec('mod_compact', { stage: 'restore', session_id: 's2' }, 28),
      rec('mod_compact', { stage: 'post' }, 27), rec('mod_compact', { stage: 'post', session_id: 's2' }, 26),
    ]), 'compact');
    expect(c).toMatchObject({ level: 'warn', message: expect.stringContaining('2 pre / 1 restore / 2 post; 1 without restore (sessions s1)') });
  });
  it('keeps successive compactions within one session separate', () => {
    const c = check(run([pre(), rec('mod_compact', { stage: 'post' }, 29), pre({}, 2), rec('mod_compact', { stage: 'restore' }, 1), rec('mod_compact', { stage: 'post' }, 1)]), 'compact');
    expect(c).toMatchObject({ level: 'warn', message: expect.stringContaining('1 without restore (sessions s1)') });
  });
  it('settles a young compaction when its post arrives, and still excludes shadow restores', () => {
    expect(check(run([pre({}, 2), rec('mod_compact', { stage: 'post', restored_chars: null }, 1)]), 'compact')).toMatchObject({ level: 'warn', message: expect.stringContaining('1 without restore (sessions s1)') });
    expect(level([pre({ mode: 'shadow' }, 2), rec('mod_compact', { stage: 'post' }, 1)], 'compact')).toBe('ok');
    expect(level([pre({}, 2), pre({ deferred: 'function_path' }, 1), rec('mod_compact', { stage: 'restore' }, 1), rec('mod_compact', { stage: 'post' }, 1)], 'compact')).toBe('ok');
  });
  it('warns when Jev was recorded disabled with a key present, or answered invalid', () => {
    expect(level([pre({ selection: 'disabled' }), rec('mod_compact', { stage: 'restore' }, 29), rec('mod_compact', { stage: 'post' }, 29)], 'compact')).toBe('warn');
    expect(level([pre(), rec('mod_compact', { stage: 'jev', selection: 'invalid_answers' }, 30), rec('mod_compact', { stage: 'restore' }, 29), rec('mod_compact', { stage: 'post' }, 29)], 'compact')).toBe('warn');
  });
  it.each(['no_current_task', 'no_prior_assistant', 'no_key', 'no_candidates', 'disabled'])('shows the recorded Compact selection reason %s', selection => {
    const c = check(run([pre({ selection }), rec('mod_compact', { stage: 'restore' }, 29), rec('mod_compact', { stage: 'post' }, 29)]), 'compact');
    expect(c.message).toContain(`selections ${selection} 1`);
    expect(c.level).toBe(selection === 'disabled' ? 'warn' : 'ok');
  });
  it('shows no_current_task on a deferred pre without inventing a missing restore', () => {
    expect(check(run([pre({ deferred: 'nothing_to_restore', selection: 'no_current_task' })]), 'compact')).toMatchObject({ level: 'info', message: expect.stringContaining('selections no_current_task 1') });
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
    expect(codex([...prompt], { codexOwner: { root: '/plugin/0.8.31', rootExists: true, pidAlive: true, since: 0 } })).toMatchObject({ level: 'fail', message: expect.stringContaining('1 Codex sessions prompted in the last 24 h, 1 with no codex_router record') });
  });
  it('fails a session started before the current connection and still prompting without routing, and says to restart it', () => {
    const live = { root: '/plugin/0.8.31', rootExists: true, pidAlive: true, since: NOW - 20 * 60_000 };
    const early = [rec('codex_event', { host: 'codex', event: 'SessionStart', session_id: 'c3' }, 30), rec('codex_event', { host: 'codex', event: 'UserPromptSubmit', session_id: 'c3' }, 1)];
    const c = codex(early, { codexOwner: live });
    expect(c).toMatchObject({ level: 'fail', message: expect.stringContaining('1 Codex sessions prompted in the last 24 h, 1 with no codex_router record (1 started before the connection was written)') });
    expect(c.action).toMatch(/restart them/);
  });
  it('counts a recently prompted session whose start fell outside the 24 h window', () => {
    const live = { root: '/plugin/0.8.31', rootExists: true, pidAlive: true, since: NOW - 20 * 60_000 };
    expect(codex([rec('codex_event', { host: 'codex', event: 'SessionStart', session_id: 'c4' }, 30 * 60), rec('codex_event', { host: 'codex', event: 'UserPromptSubmit', session_id: 'c4' }, 1)], { codexOwner: live }).level).toBe('fail');
  });
  it('counts a prompted session with no recorded start without claiming it predates the connection', () => {
    const c = codex([rec('codex_event', { host: 'codex', event: 'UserPromptSubmit', session_id: 'c5' }, 1)], { codexOwner: { root: '/plugin/0.8.31', rootExists: true, pidAlive: true, since: NOW - 20 * 60_000 } });
    expect(c.level).toBe('fail');
    expect(c.message).not.toContain('started before');
    expect(c.action).toMatch(/fresh Codex session/);
  });
  it('is ok with a live owner and routed sessions', () => {
    expect(codex([...prompt, rec('codex_router_result', { host: 'codex', session_id: 'c1' })], { codexOwner: { root: '/plugin/0.8.31', rootExists: true, pidAlive: true, since: 0 } }).level).toBe('ok');
  });
});

describe('activity: failures', () => {
  it('warns on failure records by category', () => {
    expect(check(run([rec('failure', { failure_category: 'preflight_conflict' })]), 'failures')).toMatchObject({ level: 'warn', message: 'failures: 1 failure records (preflight_conflict 1)' });
  });
  it('is ok without failure records', () => {
    expect(level([rec('admission_result')], 'failures')).toBe('ok');
  });
});

describe('Gate cleanup reason fixtures', () => {
  it.each(['admission_needs_context', 'admission_context_unclear', 'admission_context_low_confidence', 'route_not_fast'])('displays %s', reason => {
    const gateB = reason === 'route_not_fast';
    const c = check(run([rec(gateB ? 'pre_result' : 'admission_result', { role: 'worker', decision: { shape: 'direct', tier: 'standard', reason } })]), gateB ? 'gate_b' : 'gate_a');
    expect(c.message).toContain(reason + ' 1');
  });
  it.each(['worker_check_duplicate', 'worker_check_failed', 'worker_check_not_run', 'worker_checks_missing', 'worker_checks_unverified', 'worker_no_result', 'worker_failed', 'worker_cancelled'])('displays worker reason %s', reason => {
    const c = check(run([rec('post', { subagent_type: 'jev-gate:worker', verdict: 'incomplete', verdict_reason: reason })]), 'worker');
    expect(c.message).toContain(reason);
  });
  it('counts native cancellation separately from failure', () => {
    const c = check(run([rec('background_terminal', { status: 'cancelled', verdict_reason: 'worker_cancelled' })]), 'background');
    expect(c.level).toBe('ok'); expect(c.message).toContain('cancelled 1'); expect(c.message).toContain('worker_cancelled');
  });
});
