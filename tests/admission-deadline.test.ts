import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHook, type HookDeps } from '../src/hook.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { readJob, updateJob, newGeneration, jobPath } from '../src/job.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'jev-deadline-')); roots.push(root);
  let now = 100000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const env = { HOME: root, JEV_GATE_STATE_DIR: root, TYPESAFE_API_KEY: 'fake', JEV_GATE_MODE: 'auto' };
  const controller = new AbortController();
  const host: NonNullable<HookDeps['host']> = { id: 'codex', config: { ...DEFAULT_CONFIG, mode: 'auto', maxParallelWorkers: 1, workerIsolation: 'none', admittedShape: 'single', delegationDepthFloor: 0 },
    depth: () => ({ ok: true, tokens: 500000, model: null, modelSwitched: false, bytesRead: 0, durationMs: 0 }), compactWindow: null, recentRequests: () => ['implement the feature'], source: () => ({ ok: false, reason: 'source_unavailable', detail: 'fixture', bytesRead: 0, durationMs: 0 }), observation: () => null };
  const reply = (context = 'self_contained') => new Response(JSON.stringify({ answers: { forbids_delegation: { type: 'noul', noul: 0 }, task_context: { type: 'choice', choice: context, confidence: 1, probabilities: { self_contained: context === 'self_contained' ? 1 : 0, needs_context: context === 'needs_context' ? 1 : 0, unclear: 0 } }, tool_calls: { type: 'score', score: 4, confidence: 1, probabilities: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1 } } } }));
  const run = (fetchImpl: typeof fetch) => runHook({ env, host, startedAt: 100000, signal: controller.signal, fetchImpl, stdin: (async function* () { yield JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt_id: 'p', prompt: 'continue' }); })() });
  return { env, host, run, reply, controller, time: () => now, advance: (ms: number) => { now += ms; } };
};
describe('Gate A single hook deadline (#138)', () => {
  it('shares remaining budget across the context retry and rejects a late answer despite timer lag', async () => {
    const f = fixture(); let calls = 0;
    const fetchImpl = vi.fn(async () => { f.advance(++calls === 1 ? 2800 : 1700); return f.reply(calls === 1 ? 'needs_context' : 'self_contained'); });
    const r = await f.run(fetchImpl as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r.code).toBe('deadline_exhausted');
    expect(readJob(f.env, 's')).toMatchObject({ ok: true, value: { current: { shape: 'direct' } } });
  });
  it('counts preparation and context reading and sends nothing with less than 250ms left', async () => {
    const f = fixture(); f.host.depth = () => { f.advance(2000); return { ok: true, tokens: 500000, model: null, modelSwitched: false, bytesRead: 0, durationMs: 2000 }; };
    f.host.recentRequests = () => { f.advance(300); return ['original constraint']; };
    const fetchImpl = vi.fn(async () => { f.advance(2000); return f.reply('needs_context'); });
    expect((await f.run(fetchImpl as typeof fetch)).code).toBe('deadline_exhausted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel', 'supersede'])('emits no old guidance after %s during context preparation', async action => {
    const f = fixture();
    f.host.recentRequests = () => { if (action === 'cancel') f.controller.abort(); else updateJob(f.env, 's', p => newGeneration(p, 's', 'new', 'direct').state); return ['old constraint']; };
    const fetchImpl = vi.fn(async () => f.reply('needs_context'));
    expect((await f.run(fetchImpl as typeof fetch)).stdout).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('does not begin HTTP after preparation has exhausted the hook budget', async () => {
    const f = fixture(); f.advance(4200);
    const fetchImpl = vi.fn();
    expect((await f.run(fetchImpl)).code).toBe('deadline_exhausted');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('accepts an on-time answer within the commit reserve', async () => {
    const f = fixture(); const fetchImpl = vi.fn(async () => { f.advance(4300); return f.reply(); });
    expect((await f.run(fetchImpl as typeof fetch)).kind).toBe('guidance');
    expect(readJob(f.env, 's')).toMatchObject({ ok: true, value: { current: { shape: 'orchestrated' } } });
  });
  it('preserves a shorter explicit request deadline rather than resetting it for admission', async () => {
    const f = fixture(); f.host.config.requestDeadlineMs = 50;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      await new Promise<void>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return f.reply();
    });
    expect((await f.run(fetchImpl as typeof fetch)).code).toBe('timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('rejects a body that finishes after the deadline while the timer queue is delayed', async () => {
    const f = fixture(); const fetchImpl = vi.fn(async () => {
      const content = await f.reply().text();
      return new Response(new ReadableStream({ start(controller) { f.advance(4500); controller.enqueue(new TextEncoder().encode(content)); controller.close(); } }));
    });
    expect((await f.run(fetchImpl as typeof fetch)).code).toBe('deadline_exhausted');
    expect(readJob(f.env, 's')).toMatchObject({ ok: true, value: { current: { shape: 'direct' } } });
  });

  it('does not read recent context when less than the minimum HTTP budget remains', async () => {
    const f = fixture(); const recent = vi.fn(() => ['prior']); f.host.recentRequests = recent;
    const fetchImpl = vi.fn(async () => { f.advance(4300); return f.reply('needs_context'); });
    expect((await f.run(fetchImpl as typeof fetch)).code).toBe('deadline_exhausted');
    expect(recent).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(['cancel', 'deadline'])('rechecks %s inside the final commit lock', async action => {
    const f = fixture(); const lock = jobPath(f.env, 's') + '.lock'; let acquired = false;
    const fetchImpl = vi.fn(async () => {
      f.advance(4300); mkdirSync(lock); writeFileSync(join(lock, 'owner'), String(process.pid));
      vi.spyOn(Date, 'now').mockImplementation(() => {
        if (!acquired && new Error().stack?.includes('acquireLock')) { acquired = true; rmSync(lock, { recursive: true }); if (action === 'cancel') f.controller.abort(); else f.advance(800); }
        return f.time();
      });
      return f.reply();
    });
    const r = await f.run(fetchImpl as typeof fetch);
    expect(acquired).toBe(true); expect(readJob(f.env, 's')).toMatchObject({ ok: true, value: { current: { shape: 'direct' } } });
    if (action === 'cancel') expect(r.stdout).toBeNull(); else expect(r.code).toBe('deadline_exhausted');
  });

});
