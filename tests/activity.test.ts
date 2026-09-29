import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadActivity } from '../src/activity.js';
import { startDashboard } from '../src/dashboard.js';

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

describe('loadActivity', () => {
  it('says a Gate A call stayed direct, and drops prompt text and keys', () => {
    const trace = make();
    const debug = make();
    write(trace, 'admission_result-1.json', {
      phase: 'admission_result',
      written_at: '2026-09-29T05:40:48.363Z',
      attempted: true,
      prompt: 'SUPER_SECRET_PROMPT_TEXT',
      prompt_sha256: 'abc',
      http: { status: 200, duration_ms: 329 },
      jev: { model: 'jev-1.13.0', usage: { input_tokens: 832, output_tokens: 105 } },
      decision: { shape: 'direct', reason: 'admission_not_worth' },
      estimate: { turns: 13.9, saving_tokens: -187992 },
    });
    writeFileSync(
      join(debug, 'session.txt'),
      `2026-09-28T03:09:41.216Z [DEBUG] jev-router ${JSON.stringify({ event: 'router', key: 'sk-live-secret-value', root_effort: true })}\n` +
        `2026-09-28T03:09:42.000Z [DEBUG] jev-router ${JSON.stringify({ event: 'root', sent: true, from: { model: 'claude-sonnet-5', effort: 'xhigh' }, patch: { effort: 'low' }, reasons: { model: 'not_asked', effort: 'applied' }, usage: { input: 941, output: 105 }, prompt: 'SUPER_SECRET_PROMPT_TEXT' })}\n`,
    );
    const snap = loadActivity({ traceDir: trace, debugDir: debug, env: { JEV_GATE_STATE_DIR: make() }, now: new Date('2026-09-29T06:00:00.000Z') });
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
    expect(gate?.call).toContain('jev-1.13.0');
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
    const snap = loadActivity({ traceDir: link, debugDir: null, env: { JEV_GATE_STATE_DIR: make() } });
    expect(snap.traceFiles).toBe(0);
    expect(snap.jevCalls).toBe(0);
    expect(snap.notes.some((n) => n.includes('심볼릭 링크'))).toBe(true);
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
    const open = loadActivity({ traceDir: trace, debugDir: null, env, now: new Date('2026-09-29T06:00:00.000Z') });
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
    const stale = loadActivity({ traceDir: trace, debugDir: null, env, now: new Date('2026-09-29T06:00:00.000Z') });
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
      jev: { model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 4 } },
      decision: { shape: 'direct', reason: 'admission_not_worth' },
    });
    const shut = loadActivity({ traceDir: trace, debugDir: null, env, now: new Date('2026-09-29T06:00:01.000Z') });
    expect(shut.live.mode).toBe('waiting');
    expect(shut.live.steps).toHaveLength(1);
    expect(shut.live.steps[0]?.state).toBe('done');
    expect(shut.live.steps[0]?.line).toContain('직접 처리');
    expect(shut.live.steps[0]?.line).not.toContain('기다리는 중');
    expect(JSON.stringify(shut)).not.toContain('SUPER_SECRET_PROMPT_TEXT');
  });
});

describe('dashboard server', () => {
  it('serves the page and a snapshot on loopback', async () => {
    const trace = make();
    write(trace, 'stop-1.json', { phase: 'stop', written_at: '2026-09-29T01:00:00.000Z', outcome: 'incomplete' });
    write(trace, 'stop-2.json', { phase: 'stop', written_at: '2026-09-29T02:00:00.000Z', outcome: 'completed' });
    const server = await startDashboard({ traceDir: trace, debugDir: null, env: { JEV_GATE_STATE_DIR: make() } }, 0);
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('호출이 기록되는 즉시');
      const body = (await (await fetch(`${server.url}api/snapshot`)).json()) as { events: Array<{ title: string; used: string }> };
      expect(body.events.map((e) => e.used).join('\n')).not.toContain('completed');
      expect(body.events[0]?.title).toBe('턴 종료');
      expect(body.events[0]?.used).toContain('incomplete');
      expect((await fetch(`${server.url}nope`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('pushes the open call and replaces it when the result file appears', async () => {
    const trace = make();
    const server = await startDashboard({ traceDir: trace, debugDir: null, env: { JEV_GATE_STATE_DIR: make() } }, 0);
    const res = await fetch(`${server.url}api/live`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const dec = new TextDecoder();
    let buf = '';
    const pull = async (): Promise<{ live: { mode: string; steps: Array<{ state: string; line: string }> } }> => {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const cut = buf.indexOf('\n\n');
        if (cut >= 0) {
          const raw = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const line = raw.split('\n').find((item) => item.startsWith('data: '));
          if (line) return JSON.parse(line.slice(6)) as { live: { mode: string; steps: Array<{ state: string; line: string }> } };
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('live event timed out')), deadline - Date.now())),
        ]);
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
      }
      throw new Error('live event timed out');
    };
    try {
      const first = await pull();
      expect(first.live.mode).toBe('waiting');
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
      while (working.live.mode !== 'working' && Date.now() < until) working = await pull();
      expect(working.live.mode).toBe('working');
      expect(working.live.steps[0]?.state).toBe('active');
      expect(JSON.stringify(working)).not.toContain('SUPER_SECRET_PROMPT_TEXT');
      write(trace, 'admission_result-1.json', {
        phase: 'admission_result',
        written_at: new Date().toISOString(),
        request_id: 'req-live',
        session_id: 'sess',
        prompt_id: 'p-live',
        attempted: true,
        http: { status: 200, duration_ms: 280 },
        jev: { model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 4 } },
        decision: { shape: 'direct', reason: 'admission_not_worth' },
      });
      let shut = working;
      const untilDone = Date.now() + 2500;
      while (!(shut.live.mode === 'waiting' && shut.live.steps.some((step) => step.line.includes('직접 처리'))) && Date.now() < untilDone) shut = await pull();
      expect(shut.live.steps.some((step) => step.state === 'active')).toBe(false);
      expect(shut.live.steps.map((step) => step.line).join('\n')).toContain('직접 처리');
    } finally {
      await reader.cancel();
      await server.close();
    }
  });
});
