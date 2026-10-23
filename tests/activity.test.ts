import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHECKS_MS, checksMemo, loadActivity, type ActivitySnapshot } from '../src/activity.js';
import { startDashboard, readVersions } from '../src/dashboard.js';
import { DASHBOARD_PAGE } from '../src/dashboard-page.js';
import { TraceDirectoryReader } from '../src/explain.js';
import { activityChecks } from '../src/doctor-activity.js';
import { memo } from '../src/memo.js';
import { liveFrames } from './live-frames.js';

// The records the last snapshot handed to the operations build.
const built = vi.hoisted(() => ({ records: [] as Array<Record<string, unknown>> }));
vi.mock('../src/operations.js', async (original) => {
  const actual = await original<typeof import('../src/operations.js')>();
  return { ...actual, buildOperations: (...args: Parameters<typeof actual.buildOperations>) => { built.records = args[0]; return actual.buildOperations(...args); } };
});

const dirs: string[] = [];
const make = (): string => {
  const dir = join(tmpdir(), `jev-activity-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const write = (dir: string, name: string, body: unknown): void => {
  writeFileSync(join(dir, name), JSON.stringify(body));
};

it('counts a Codex Compact judgment once, including failed consumption, rather than counting reused submissions', () => {
  const trace = make(), written_at = new Date().toISOString();
  for (const [i, row] of [
    { stage: 'selection_intent', selection_id: 'one', attempted: true },
    { stage: 'selection_result', selection_id: 'one', attempted: true, reason: 'assessed' },
    { stage: 'submitted', selection_ids: ['one'], applied: true },
    { stage: 'submitted', selection_ids: ['one'], applied: true },
    { stage: 'selection_result', selection_id: 'two', attempted: true, reason: 'timeout' },
  ].entries()) write(trace, `${i}.json`, { phase: 'codex_compact', host: 'codex', session_id: 'c', prompt_id: 'p', ...row, written_at });
  const result = loadActivity({ traceDir: trace, env: { HOME: make() } });
  expect(result.jevCalls).toBe(2);
  expect(result.operations.requests).toBe(1); // Only the recorded intent establishes a known dispatch identity.
});

it('omits retired feature records from the live board and operation counters', () => {
  const trace = make();
  for (const phase of ['interpretation_intent', 'interpretation_result', 'evidence_result', 'guard_result']) write(trace, phase + '.json', { phase, session_id: 's', request_id: 'retired', attempted: true, written_at: new Date().toISOString() });
  const result = loadActivity({ traceDir: trace, env: { HOME: make() } });
  expect(result.live.steps).toEqual([]);
  expect(result.operations.feed).toEqual([]);
  expect(result.operations.requests).toBe(0);
});

it.each(['claude', 'codex'])('B2: screens credential-shaped tokens in legacy %s failure dashboard data', host => {
  const trace = make();
  const synthetic = 'ghp_B2SYNTHETICDASHBOARDSENTINEL123456789';
  write(trace, 'failure.json', { phase: 'failure', host, session_id: 'legacy-failure', error_first_line: synthetic, verdict_reason: synthetic, written_at: new Date().toISOString() });
  const result = loadActivity({ traceDir: trace, env: { HOME: make() } });
  expect(result.operations.feed).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(synthetic);
});

it('returns doctor facts without its free-form messages, and keeps the latest root model separate from a later child', () => {
  const trace = make(), env = { HOME: make() }, now = new Date('2026-10-20T06:00:00Z');
  const records = [
    { phase: 'admission_result', session_id: 's', written_at: '2026-10-20T05:00:00Z', attempted: true, decision: { shape: 'orchestrated' }, private_text: 'private fixture prose' },
    { phase: 'mod_router', event: 'root', session_id: 's', turn: 't', written_at: '2026-10-20T05:01:00Z', sent: true, duration_ms: 50, from: { model: 'opus', effort: 'high' }, patch: { model: 'sonnet', effort: 'low' }, reasons: { model: 'selected' } },
    { phase: 'mod_router', event: 'child_route', session_id: 's', turn: 't', agent_id: 'child', written_at: '2026-10-20T05:02:00Z', sent: true, duration_ms: 45, from: { model: 'sonnet', effort: 'low' }, patch: { model: 'haiku', effort: 'low' } },
  ];
  records.forEach((r, i) => write(trace, `r${i}.json`, r));
  const result = loadActivity({ traceDir: trace, env, now });
  const expected = activityChecks({ traces: { claude: { records, unreadable: 0 } }, now: now.getTime(), installed: null, recording: true, keyPresent: false, liveness: null, codexOwner: null })
    .filter(c => c.feature && c.metrics).map(({ feature, level, metrics }) => ({ feature, level, metrics }));
  expect(result.activity24h.claude.map(({ current: _current, ...c }) => c)).toEqual(expected);
  const root = result.operations.feed.find(s => s.routing?.scope === 'root')!;
  expect(result.activity24h.claude.find(c => c.feature === 'router')?.current).toMatchObject({ at: '2026-10-20T05:01:00Z', host: 'claude', runId: root.runId, receipt: { choice: 'sonnet · low' } });
  expect(JSON.stringify(result.activity24h)).not.toContain('private fixture prose');
  expect(JSON.stringify(result.activity24h)).not.toContain('message');
});

describe('credit exhaustion', () => {
  const credit = (...rows: Array<[string, string, boolean]>) => {
    const trace = make();
    rows.forEach(([assessment, at, sent], i) => write(trace, `r${i}.json`, { phase: 'mod_router', session_id: 's', event: 'root', turn: `t${i}`, sent, assessment, written_at: at }));
    return loadActivity({ traceDir: trace, env: { HOME: make() } }).credit;
  };
  it('flags a 402 and keeps the flag through refused follow-ups until a request succeeds', () => {
    expect(credit(['payment_required', '2026-10-07T05:00:00.000Z', true]).exhausted).toBe(true);
    expect(credit(['payment_required', '2026-10-07T05:00:00.000Z', true], ['credential_refused', '2026-10-07T05:01:00.000Z', false]).exhausted).toBe(true);
    expect(credit(['payment_required', '2026-10-07T05:00:00.000Z', true], ['ok', '2026-10-07T05:02:00.000Z', true]).exhausted).toBe(false);
    expect(credit(['timeout', '2026-10-07T05:00:00.000Z', true]).exhausted).toBe(false);
  });
  it('shows the alert in the page only when the snapshot says so', () => {
    expect(DASHBOARD_PAGE).toContain('id="credit"');
    expect(DASHBOARD_PAGE).toContain("c.textContent=credit?.exhausted?label('크레딧 소진','Credit exhausted'):''");
  });
});

describe('loadActivity', () => {
  it('closes a native spawn prepared before the response had an agent id without joining another call', () => {
    const trace = make();
    for (const [name, fields] of [
      ['prepared', { event: 'prepared', tool_use_id: 'tool', scope: 'spawn', written_at: '2026-10-07T05:27:20.000Z' }],
      ['other', { event: 'prepared', tool_use_id: 'other', scope: 'spawn', written_at: '2026-10-07T05:27:20.000Z' }],
      ['response', { event: 'spawn_native_result', tool_use_id: 'tool', agent_id: 'agent', requested: 'claude-opus-5-5', observed: 'claude-opus-5-5', confirmation: 'confirmed', written_at: '2026-10-07T05:27:21.000Z' }],
    ] as const) write(trace, name + '.json', { phase: 'mod_router', session_id: 's', ...fields });
    const s = loadActivity({ traceDir: trace, env: { HOME: make() } });
    const prepared = s.operations.runs.flatMap(r => r.steps).filter(t => t.title === 'Router · 요청 전달 준비');
    expect(prepared.map(t => t.state).sort()).toEqual(['done', 'unconfirmed']);
  });
  it('with a reader, equals a fresh read as trace files arrive, change and go', () => {
    const trace = make(), env = { HOME: make() }, now = new Date('2026-10-07T06:00:00.000Z'), reader = new TraceDirectoryReader();
    const record = (i: number, extra: Record<string, unknown> = {}) => {
      write(trace, `r${i}.json`, { phase: i % 2 ? 'mod_router' : 'admission_result', session_id: 's', event: 'root', turn: `t${i}`, sent: true, assessment: 'ok', attempted: true,
        decision: { shape: 'direct' }, written_at: new Date(Date.parse('2026-10-07T05:00:00.000Z') + i * 1000).toISOString(), ...extra });
      reader.invalidate(trace, `r${i}.json`);
    };
    const same = () => {
      const cached = loadActivity({ traceDir: trace, env, now, traceReader: reader, feed: false });
      expect(cached).toEqual(loadActivity({ traceDir: trace, env, now, feed: false }));
      return cached;
    };
    for (let i = 0; i < 4; i++) record(i);
    expect(same().jevCalls).toBe(4);
    record(4);
    expect(same().jevCalls).toBe(5);
    record(3, { assessment: 'payment_required' });
    expect(same().credit.exhausted).toBe(true);
    rmSync(join(trace, 'r0.json')); reader.invalidate(trace, 'r0.json');
    expect(same().jevCalls).toBe(4);
  });
  it('hands a Mod record to the operations build as its row only, and still shows it', () => {
    // As a record too, each Router record kept an empty build of its own: most of a long history's builds.
    const trace = make();
    write(trace, 'router.json', { phase: 'mod_router', session_id: 's', event: 'root', turn: 't', sent: true, assessment: 'ok', written_at: '2026-10-07T05:00:00.000Z' });
    write(trace, 'gate.json', { phase: 'admission_result', session_id: 's', prompt_id: 'p', attempted: true, decision: { shape: 'direct' }, written_at: '2026-10-07T05:00:01.000Z' });
    const s = loadActivity({ traceDir: trace, env: { HOME: make() } });
    expect(built.records.map(r => r['phase'])).toEqual(['admission_result']);
    expect(s.operations.runs.some(run => run.source === 'router')).toBe(true);
    expect(s.jevCalls).toBe(2);
  });
  it('keeps across loads the memo results the last load used, and computes the others again', () => {
    // Caches held every string the history ever had until a cap emptied them all at once.
    const calls: string[] = [];
    const upper = memo((v: string): string | null => { calls.push(v); return v === 'none' ? null : v.toUpperCase(); });
    const load = () => loadActivity({ traceDir: null, env: { HOME: make() } });
    upper('kept'); upper('dropped'); upper('none');
    load(); upper('kept'); upper('none');
    load(); upper('kept'); upper('none'); upper('dropped');
    expect(calls).toEqual(['kept', 'dropped', 'none', 'dropped']);
  });
  it('shows denied dispatches and worktree lifecycle as policy and local events', () => {
    const trace = make();
    write(trace, 'deny.json', { phase: 'dispatch_denied', session_id: 's', reason: 'task_active', written_at: '2026-10-07T05:27:20.000Z' });
    write(trace, 'start.json', { phase: 'worktree_start', session_id: 's', request_id: 'w', written_at: '2026-10-07T05:27:20.000Z' });
    write(trace, 'result.json', { phase: 'worktree_result', session_id: 's', request_id: 'w', ok: true, written_at: '2026-10-07T05:27:21.000Z' });
    const s = loadActivity({ traceDir: trace, env: { HOME: make() } });
    const steps = s.operations.runs.flatMap(r => r.steps);
    expect(steps.find(t => t.title === 'Agent 호출 거절')).toMatchObject({ state: 'skipped', lane: 'policy', summary: '호출 거절 · task_active' });
    expect(steps.find(t => t.title === 'Worktree · 생성 시작')).toMatchObject({ state: 'done', lane: 'local' });
    expect(steps.find(t => t.title === 'Worktree · 생성 결과')).toMatchObject({ state: 'done', lane: 'local' });
  });
  it('says a Gate A call stayed direct, and drops prompt text and keys', () => {
    const trace = make();
    write(trace, 'admission_result-1.json', {
      phase: 'admission_result',
      written_at: '2026-09-29T05:40:48.363Z',
      attempted: true,
      prompt: 'SUPER_SECRET_PROMPT_TEXT',
      prompt_sha256: 'abc',
      http: { status: 200, duration_ms: 329 },
      jev: { model: 'jev-1.14.0', usage: { input_tokens: 832, output_tokens: 105 } },
      decision: { shape: 'direct', reason: 'admission_not_worth' },
      estimate: { turns: 13.9, saving_tokens: -187992 },
    });
    const mod = (name: string, at: string, fields: Record<string, unknown>): void =>
      write(trace, name, { ...fields, host: 'claude', session_id: 's1', phase: 'mod_router', version: 5, invocation_id: name, written_at: at });
    mod('mod_router-1.json', '2026-09-28T03:09:41.216Z', { event: 'router', key: 'sk-live-secret-value', root_effort: true });
    mod('mod_router-2.json', '2026-09-28T03:09:42.000Z', { event: 'root', sent: true, from: { model: 'claude-sonnet-5', effort: 'xhigh' }, patch: { effort: 'low' }, reasons: { model: 'not_asked', effort: 'applied' }, usage: { input: 941, output: 105 }, prompt: 'SUPER_SECRET_PROMPT_TEXT' });
    const snap = loadActivity({ traceDir: trace, env: { JEV_GATE_STATE_DIR: make() }, now: new Date('2026-09-29T06:00:00.000Z') });
    const raw = JSON.stringify(snap);
    expect(raw).not.toContain('SUPER_SECRET_PROMPT_TEXT');
    expect(raw).not.toContain('sk-live');
    expect(raw).not.toContain('prompt_sha256');
    expect(snap.jevCalls).toBe(2);
    expect(snap.direct).toBe(1);
    expect(snap.orchestrated).toBe(0);
    expect(snap.routerChanges).toBe(1);
    const gate = snap.events.find((e) => e.title === '게이트 A');
    expect(gate?.kind).toBe('asked');
    expect(gate?.call).toContain('jev-1.14.0');
    expect(gate?.call).toContain('832');
    expect(gate?.used).toContain('직접 처리');
    expect(gate?.used).toContain('측정된 절감이 아닙니다');
    const router = snap.events.find((e) => e.title === '라우터 · 루트 턴');
    expect(router?.used).toContain('low');
    expect(router?.used).toContain('모델은 묻지 않습니다');
  });

  it('does not follow a symlinked trace directory', () => {
    const real = make();
    const linkParent = make();
    const link = join(linkParent, 'trace');
    write(real, 'admission_result-1.json', { phase: 'admission_result', written_at: '2026-09-29T00:00:00.000Z', attempted: true, decision: { shape: 'orchestrated', reason: null } });
    symlinkSync(real, link);
    const snap = loadActivity({ traceDir: link, env: { JEV_GATE_STATE_DIR: make() } });
    expect(snap.traceFiles).toBe(0);
    expect(snap.jevCalls).toBe(0);
    expect(snap.notes.some((n) => n.includes('심볼릭 링크'))).toBe(true);
    expect(snap.operations.features.find((f) => f.id === 'admission')?.state).toBe('unavailable');
  });

  it('does not label configured but unreadable record sources as waiting', () => {
    const parent = make();
    const missing = join(parent, 'missing');
    const snap = loadActivity({ traceDir: missing, env: { JEV_GATE_STATE_DIR: make() } });
    expect(snap.operations.features.every((f) => f.state === 'unavailable')).toBe(true);
  });

  it('shows an open intent until its result file replaces that stage', () => {
    const trace = make();
    const env = { JEV_GATE_STATE_DIR: make() };
    write(trace, 'admission_intent-1.json', {
      phase: 'admission_intent',
      written_at: '2026-09-29T05:59:59.500Z',
      request_id: 'req-1',
      session_id: 'sess',
      prompt_id: 'p1',
      prompt: 'SUPER_SECRET_PROMPT_TEXT',
    });
    const open = loadActivity({ traceDir: trace, env, now: new Date('2026-09-29T06:00:00.000Z') });
    expect(open.live.mode).toBe('working');
    expect(open.live.headline).toBe('Jev에 묻는 중');
    expect(open.live.stage).toBe('게이트 A');
    expect(open.live.since).toBe('2026-09-29T05:59:59.500Z');
    expect(open.live.steps).toHaveLength(1);
    expect(open.live.steps[0]?.state).toBe('active');
    expect(JSON.stringify(open)).not.toContain('SUPER_SECRET_PROMPT_TEXT');

    write(trace, 'admission_intent-old.json', {
      phase: 'admission_intent',
      written_at: '2026-09-29T05:00:00.000Z',
      request_id: 'req-old',
      session_id: 'sess',
      prompt_id: 'old',
    });
    const stale = loadActivity({ traceDir: trace, env, now: new Date('2026-09-29T06:00:00.000Z') });
    const old = stale.live.earlier.find((row) => row.detail.includes('응답 기록이 없습니다'));
    expect(old).toBeTruthy();

    write(trace, 'admission_result-1.json', {
      phase: 'admission_result',
      written_at: '2026-09-29T06:00:00.200Z',
      request_id: 'req-1',
      session_id: 'sess',
      prompt_id: 'p1',
      attempted: true,
      prompt: 'SUPER_SECRET_PROMPT_TEXT',
      http: { status: 200, duration_ms: 280 },
      jev: { model: 'jev-1.14.0', usage: { input_tokens: 10, output_tokens: 4 } },
      decision: { shape: 'direct', reason: 'admission_not_worth' },
    });
    const shut = loadActivity({ traceDir: trace, env, now: new Date('2026-09-29T06:00:01.000Z') });
    expect(shut.live.mode).toBe('waiting');
    expect(shut.live.steps).toHaveLength(1);
    expect(shut.live.steps[0]?.state).toBe('done');
    expect(shut.live.steps[0]?.line).toContain('직접 처리');
    expect(shut.live.steps[0]?.line).not.toContain('기다리는 중');
    expect(JSON.stringify(shut)).not.toContain('SUPER_SECRET_PROMPT_TEXT');
  });
  it('#213: still loads a trace written while Gate C ran, and shows the recorded verdict, not the advisory', () => {
    const trace = make();
    const base = { session_id: 's', prompt_id: 'p1', tool_use_id: 'toolu_1', task_id: 't1', rev: 1 };
    write(trace, 'result_intent-1.json', { ...base, phase: 'result_intent', request_id: 'r1', written_at: '2026-09-29T05:59:58.000Z' });
    write(trace, 'result_result-1.json', { ...base, phase: 'result_result', request_id: 'r1', attempted: true, decision: { verdict: 'rework', applied: false }, written_at: '2026-09-29T05:59:58.500Z' });
    write(trace, 'post-1.json', { ...base, phase: 'post', verdict: 'accept', advisory: 'rework', written_at: '2026-09-29T05:59:59.000Z' });
    const snap = loadActivity({ traceDir: trace, env: { JEV_GATE_STATE_DIR: make() }, now: new Date('2026-09-29T06:00:00.000Z') });
    expect(snap.traceFiles).toBe(3);
    expect(snap.events.find((e) => e.title === '워커 결과')?.used).toContain('워커 보고 accept');
    expect(JSON.stringify(snap)).not.toContain('rework');
  });

});

describe('dashboard server', () => {
  it('releases its listening port before an authenticated shutdown response permits a replacement', async () => {
    const sources = { traceDir: null, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } };
    const token = 'a'.repeat(32);
    const first = await startDashboard(sources, 0, { token });
    let replacement: Awaited<ReturnType<typeof startDashboard>> | undefined;
    try {
      const reply = await fetch(`${first.url}api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect(reply.ok).toBe(true);
      replacement = await startDashboard(sources, first.port);
      expect(replacement.url).toBe(first.url);
      expect((await fetch(`${replacement.url}api/health`)).ok).toBe(true);
    } finally {
      await replacement?.close();
      await first.close().catch(() => undefined);
    }
  });
  it.each(['ko', 'en'])('renders unknown and mismatched versions without interrupting live rendering (%s)', lang => {
    const functions = DASHBOARD_PAGE.split('\n').filter(line => line.startsWith('function showVersion(') || line.startsWith('function versionState(')).join('\n');
    const render = (version: { running: string; installed: string | null }) => {
      const badge = { dataset: {} as Record<string, string>, hidden: true, textContent: '', title: '', ariaLabel: '' };
      runInNewContext(`${functions}\nshowVersion(version)`, { lang, version, $: () => badge, date: (s: string) => s, label: (ko: string, en: string) => lang === 'ko' ? ko : en });
      return badge;
    };
    const unknown = render({ running: '0.7.1', installed: null });
    expect(unknown.hidden).toBe(false); expect(unknown.textContent).toBe('v0.7.1');
    expect(unknown.ariaLabel).toMatch(lang === 'ko' ? /^v0\.7\.1 · 최신 여부 미확인 · / : /^v0\.7\.1 · Update status unknown · /);
    expect(unknown.title).toContain(lang === 'ko' ? '설치된 Claude 플러그인: 미확인' : 'Installed Claude plugin: unknown');
    const mismatch = render({ running: '0.7.0', installed: '0.7.1' });
    expect(mismatch.textContent).toBe('v0.7.0 ≠ v0.7.1'); expect(mismatch.ariaLabel).toContain(lang === 'ko' ? '설치 버전 다름' : 'Installed version differs');
    expect(mismatch.title).toContain(lang === 'ko' ? '기존 세션은 이전 훅' : 'Existing sessions can retain older hooks');
  });

  it('notifies connected clients when only the installed plugin version changes', async () => {
    const home = make(); const registryDir = join(home, '.claude/plugins'); mkdirSync(registryDir, { recursive: true });
    const registry = join(registryDir, 'installed_plugins.json');
    const set = (version: string): void => writeFileSync(registry, JSON.stringify({ plugins: { 'jev-gate@jev-gate': [{ version }] } }));
    set('0.7.0');
    expect(readVersions({ HOME: home }, 'codex').installed).toBeNull();
    const server = await startDashboard({ traceDir: null, env: { HOME: home, JEV_GATE_STATE_DIR: make() } }, 0);
    const response = await fetch(`${server.url}api/live`); const reader = response.body!.getReader(), frames = liveFrames(reader);
    const read = (): Promise<{ version: { running: string; installed: string } }> => frames.next(2500, 'version SSE');
    try {
      const first = await read(); expect(first.version.installed).toBe('0.7.0');
      set('0.7.1'); const second = await read();
      expect(second.version.running).toBe(first.version.running); expect(second.version.installed).toBe('0.7.1');
    } finally { await reader.cancel(); await server.close(); }
  });

  it('pushes a Compact event even when the legacy single-turn signature is unchanged', async () => {
    const trace = make();
    const server = await startDashboard({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    const response = await fetch(`${server.url}api/live`);
    const reader = response.body!.getReader(), frames = liveFrames(reader);
    type Frame = { operations: { features: Array<{ id: string; count: number }> } };
    const read = (): Promise<Frame> => frames.next<Frame>(2500, 'SSE').catch(async error => {
      const snapshot = await (await fetch(`${server.url}api/snapshot`)).json() as { operations: { features: Array<{ id: string; count: number }> } };
      throw new Error(`${String(error)}; compact snapshot count=${snapshot.operations.features.find(f => f.id === 'compact')?.count ?? 'missing'}`);
    });
    try {
      await read();
      write(trace, 'mod_compact-1.json', { event: 'compact', run_id: 'live-1', mode: 'active', stage: 'started', host: 'claude', session_id: 's1', phase: 'mod_compact', version: 5, invocation_id: 'c1', written_at: new Date().toISOString() });
      const changed = await read();
      expect(changed.operations.features.find((f) => f.id === 'compact')?.count).toBe(1);
    } finally {
      await reader.cancel();
      await server.close();
    }
  });

  it('serves the page and a snapshot on loopback', async () => {
    const trace = make();
    write(trace, 'stop-1.json', { phase: 'stop', written_at: '2026-09-29T01:00:00.000Z', outcome: 'incomplete' });
    write(trace, 'stop-2.json', { phase: 'stop', written_at: '2026-09-29T02:00:00.000Z', outcome: 'completed' });
    const server = await startDashboard({ traceDir: trace, env: { JEV_GATE_STATE_DIR: make() } }, 0);
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('id="stages"');
      expect(html).toContain('id="theme"');
      expect(html).toContain('id="language"');
      const body = (await (await fetch(`${server.url}api/snapshot`)).json()) as Record<string, unknown> & { operations: { runs: unknown[] } };
      expect(body.operations.runs).toEqual(expect.any(Array));
      // The page draws the operations view; the event list, live board and worker activity stay on the server.
      expect(body).not.toHaveProperty('events'); expect(body).not.toHaveProperty('live'); expect(body).not.toHaveProperty('workerActivity');
      expect((await fetch(`${server.url}nope`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('leaves stage detail fields off frames and serves them for one step on loopback', async () => {
    const trace = make();
    write(trace, 'a1.json', { phase: 'admission_result', session_id: 's1', prompt_id: 'p1', request_id: 'r1', attempted: true, written_at: new Date().toISOString(), http: { status: 200, duration_ms: 210 }, decision: { shape: 'direct' } });
    const server = await startDashboard({ traceDir: trace, env: { JEV_GATE_STATE_DIR: make() } }, 0);
    try {
      type Shown = Record<string, unknown>;
      const body = await (await fetch(`${server.url}api/snapshot`)).json() as { operations: { runs: Array<{ id: string; steps: Shown[] }> } };
      const shown = body.operations.runs.flatMap(r => r.steps);
      expect(shown.length).toBeGreaterThan(0); expect(body.operations).not.toHaveProperty('feed');
      for (const s of shown) for (const field of ['details', 'routing', 'sessionId', 'agentId', 'callId']) expect(s).not.toHaveProperty(field);
      const run = body.operations.runs[0]!, full: Shown[] = [];
      for (const s of run.steps) {
        const response = await fetch(`${server.url}api/step?run=${encodeURIComponent(run.id)}&step=${encodeURIComponent(String(s['id']))}`);
        expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
        full.push(await response.json() as Shown);
      }
      // The fetched step is the frame step plus its detail fields.
      full.forEach((f, i) => { expect(f).toMatchObject(run.steps[i]!); expect(f['details']).toEqual(expect.any(Array)); expect(f['sessionId']).toBe('s1'); });
      expect(full.some(f => (f['details'] as string[]).length > 0)).toBe(true);
      for (const query of [`run=${run.id}&step=missing`, `run=missing&step=${String(run.steps[0]!['id'])}`, 'run=&step=', '']) expect((await fetch(`${server.url}api/step?${query}`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('pushes the open call and replaces it when the result file appears', async () => {
    const trace = make();
    const server = await startDashboard({ traceDir: trace, env: { JEV_GATE_STATE_DIR: make() } }, 0);
    const res = await fetch(`${server.url}api/live`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const frames = liveFrames(reader);
    type Step = { state: string; title: string; summary: string; executionPath?: string };
    const pull = (): Promise<{ operations: { runs: Array<{ steps: Step[] }> } }> => frames.next(2500, 'live event');
    const steps = (frame: { operations: { runs: Array<{ steps: Step[] }> } }): Step[] => frame.operations.runs.flatMap(run => run.steps);
    try {
      const first = await pull();
      expect(steps(first)).toEqual([]);
      write(trace, 'admission_intent-1.json', {
        phase: 'admission_intent',
        written_at: new Date().toISOString(),
        request_id: 'req-live',
        session_id: 'sess',
        prompt_id: 'p-live',
        prompt: 'SUPER_SECRET_PROMPT_TEXT',
      });
      let working = first;
      const until = Date.now() + 2500;
      while (!steps(working).length && Date.now() < until) working = await pull();
      expect(steps(working).find(step => step.title === 'Gate A · Jev 요청')).toMatchObject({ state: 'active' });
      expect(JSON.stringify(working)).not.toContain('SUPER_SECRET_PROMPT_TEXT');
      write(trace, 'admission_result-1.json', {
        phase: 'admission_result',
        written_at: new Date().toISOString(),
        request_id: 'req-live',
        session_id: 'sess',
        prompt_id: 'p-live',
        attempted: true,
        http: { status: 200, duration_ms: 280 },
        jev: { model: 'jev-1.14.0', usage: { input_tokens: 10, output_tokens: 4 } },
        decision: { shape: 'direct', reason: 'admission_not_worth' },
      });
      let shut = working;
      const untilDone = Date.now() + 2500;
      while (!steps(shut).some((step) => step.executionPath === 'direct') && Date.now() < untilDone) shut = await pull();
      expect(steps(shut).some((step) => step.state === 'active')).toBe(false);
      expect(steps(shut).find((step) => step.executionPath)).toMatchObject({ executionPath: 'direct', summary: '위임 이득 부족' });
    } finally {
      await reader.cancel();
      await server.close();
    }
  });
});


it('updates all viewers from shared directory notifications and reattaches after directory replacement', async () => {
  const parent = make(), trace = join(parent, 'trace'); mkdirSync(trace);
  const server = await startDashboard({ traceDir: trace, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
  const controllers = [new AbortController(), new AbortController()];
  const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
  try {
    for (const controller of controllers) {
      const response = await fetch(`${server.url}api/live`, { signal: controller.signal });
      const reader = response.body!.getReader(); readers.push(reader); await reader.read();
    }
    writeFileSync(join(trace, 'event.json'), JSON.stringify({ phase: 'admission_result', session_id: 's', prompt_id: 'p', written_at: new Date().toISOString(), attempted: true, decision: { shape: 'direct' } }));
    for (const reader of readers) {
      const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('shared viewer update timed out')), 5000))]);
      expect(new TextDecoder().decode(chunk.value)).toContain('"traceFiles":1');
    }
    rmSync(trace, { recursive: true }); mkdirSync(trace);
    writeFileSync(join(trace, 'replacement.json'), JSON.stringify({ phase: 'post', session_id: 's2', tool_use_id: 't2', written_at: new Date().toISOString(), requested_model: 'sonnet', resolved_model: 'claude-sonnet-5-5' }));
    await new Promise(resolve => setTimeout(resolve, 2100));
    let snapshot = await (await fetch(`${server.url}api/snapshot`)).json() as ActivitySnapshot;
    expect(snapshot.traceFiles).toBe(1);
    expect(snapshot.operations.runs.some(r => r.steps.some(s => s.model?.selected === 'sonnet'))).toBe(true);
    writeFileSync(join(trace, 'second.json'), JSON.stringify({ phase: 'failure', session_id: 's2', written_at: new Date().toISOString() }));
    // The reattached watcher hears it: the next paced rebuild, at most a second after the last one began, shows it.
    for (const deadline = Date.now() + 2500; snapshot.traceFiles !== 2 && Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 100));
      snapshot = await (await fetch(`${server.url}api/snapshot`)).json() as ActivitySnapshot;
    }
    expect(snapshot.traceFiles).toBe(2);
  } finally {
    for (const controller of controllers) controller.abort();
    for (const reader of readers) await reader.cancel().catch(() => undefined);
    await server.close();
  }
}, 10000);

it.each([['worker_check_duplicate', '검사 중복 보고'], ['worker_check_failed', '보고된 검사 실패'], ['worker_check_not_run', '필수 검사 미실행'], ['worker_checks_missing', '변경 후 검사 보고 없음'], ['worker_checks_unverified', '검사 실행 확인 불가'], ['worker_no_result', '워커 결과 미반환 · 예약 해제'], ['worker_failed', '워커 실행 실패'], ['worker_cancelled', '사용자가 워커 취소'], ['admission_needs_context', '요청만으로 범위를 정할 수 없어 직접 처리합니다'], ['admission_context_unclear', '요청 문맥 불명확'], ['admission_context_low_confidence', '독립 요청 근거 부족'], ['route_not_fast', '빠른 등급 요건 불충족']])('shows Gate cleanup reason %s', (reason, _label) => {
  const trace = make();
  const phase = reason.startsWith('worker_') ? 'post' : reason === 'route_not_fast' ? 'pre_result' : 'admission_result';
  write(trace, 'reason.json', { phase, written_at: '2026-09-29T06:00:00.000Z', session_id: 's1', verdict: 'incomplete', verdict_reason: reason,
    role: 'worker', decision: { shape: 'direct', action: 'preserve', reason } });
  const snap = loadActivity({ traceDir: trace, env: { JEV_GATE_STATE_DIR: make() }, now: new Date('2026-09-29T06:00:00.000Z') });
  expect(snap.events[0]?.used).toContain(_label);
});

describe('dashboard day summary under a record stream', () => {
  it('reuses the summary for CHECKS_MS while records arrive, then counts them all on its due rebuild', () => {
    const trace = make(), env = { HOME: make(), JEV_GATE_STATE_DIR: make() }, checks = checksMemo(), start = Date.parse('2026-10-22T03:00:00Z');
    const admit = (n: number, at: number): void => writeFileSync(join(trace, `a${n}.json`), JSON.stringify({ phase: 'admission_result', session_id: 's', written_at: new Date(at).toISOString(), decision: { shape: 'direct' } }));
    const fired = (at: number): number | undefined => loadActivity({ traceDir: trace, env, now: new Date(at), feed: false, checks }).activity24h.claude.find(c => c.feature === 'admission')?.metrics?.fired;
    admit(0, start - 1000);
    expect(fired(start)).toBe(1);
    expect(checks.due).toBe(Infinity);
    admit(1, start + 500);
    expect(fired(start + 1000)).toBe(1);
    expect(checks.due).toBe(start + CHECKS_MS);
    expect(fired(start + CHECKS_MS)).toBe(2);
    expect(checks.due).toBe(Infinity);
  });
});
