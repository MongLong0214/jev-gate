import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Env } from '../src/config.js';
import {
  cancelPurpose,
  isPurposeEvidence,
  loadPurpose,
  MAX_REQUESTS_BYTES,
  purposeDir,
  purposePath,
  purposeUnchanged,
  recordPrompt,
  startSession,
} from '../src/context/purpose.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-context-purpose-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const freshEnv = (): Env => ({ JEV_GATE_STATE_DIR: mkdtempSync(join(tmp, 'state-')) });
const CWD = '/repo/main';
const SESSION = 'session-1';

const load = (env: Env, over: Partial<Parameters<typeof loadPurpose>[0]> = {}): ReturnType<typeof loadPurpose> =>
  loadPurpose({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, agentId: undefined, agentType: undefined, ...over });

const anchored = (env: Env): void => {
  expect(startSession({ env, sessionId: SESSION, cwd: CWD, source: 'startup' }).ok).toBe(true);
};

describe('purpose record', () => {
  it('anchors a fresh startup and keeps the session requests verbatim and in order', () => {
    const env = freshEnv();
    anchored(env);
    expect(recordPrompt({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, prompt: '  키워드 검색을 고쳐줘  ' }).ok).toBe(true);
    const first = load(env);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.purpose.requests).toEqual(['  키워드 검색을 고쳐줘  ']);
    expect(recordPrompt({ env, sessionId: SESSION, promptId: 'p2', cwd: CWD, prompt: 'and keep the CRLF handling' }).ok).toBe(true);
    const second = load(env, { promptId: 'p2' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.purpose.requests).toEqual(['  키워드 검색을 고쳐줘  ', 'and keep the CRLF handling']);
    expect(second.purpose.revision).not.toBe(first.purpose.revision);
  });

  it('stores the record privately, under its own subdirectory, with no V5 job state nearby', () => {
    const env = freshEnv();
    anchored(env);
    const dir = purposeDir(env);
    expect(dir.endsWith(join('jev-gate', 'context-purpose'))).toBe(true);
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(purposePath(env, SESSION)).mode & 0o777).toBe(0o600);
    }
    // The file name is a digest, so the directory listing never carries a session identifier.
    expect(purposePath(env, SESSION)).toMatch(/[0-9a-f]{64}\.json$/);
    const body = JSON.parse(readFileSync(purposePath(env, SESSION), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['cwd_id', 'prompt_id', 'reason', 'requests', 'session_id', 'updated_at', 'usable', 'version']);
    expect(body['cwd_id']).not.toBe(CWD);
  });

  it.each([['resume'], ['compact'], ['clear'], [undefined]])('refuses to anchor a session started with source %s', (source) => {
    const env = freshEnv();
    expect(startSession({ env, sessionId: SESSION, cwd: CWD, source }).ok).toBe(true);
    expect(recordPrompt({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, prompt: 'fix the search' }).ok).toBe(true);
    expect(load(env)).toEqual({ ok: false, code: 'purpose_not_anchored' });
  });

  it('refuses a mid-session installation, where no earlier request was ever seen', () => {
    const env = freshEnv();
    expect(recordPrompt({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, prompt: 'fix the search' }).ok).toBe(true);
    expect(load(env)).toEqual({ ok: false, code: 'purpose_not_anchored' });
  });

  it.each([
    ['an empty request', '   '],
    ['a slash command', '  /compact'],
  ])('treats %s as no evidence that the previous purpose still holds', (_name, prompt) => {
    const env = freshEnv();
    anchored(env);
    recordPrompt({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, prompt: 'fix the keyword search' });
    expect(load(env).ok).toBe(true);
    recordPrompt({ env, sessionId: SESSION, promptId: 'p2', cwd: CWD, prompt });
    expect(load(env, { promptId: 'p2' })).toEqual({ ok: false, code: 'purpose_unusable' });
    expect(isPurposeEvidence(prompt)).toBe(false);
  });

  it('disables the filter over the request bound instead of silently shortening the purpose', () => {
    const env = freshEnv();
    anchored(env);
    recordPrompt({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, prompt: 'keep this first constraint' });
    const huge = 'x'.repeat(MAX_REQUESTS_BYTES + 1);
    expect(recordPrompt({ env, sessionId: SESSION, promptId: 'p2', cwd: CWD, prompt: huge }).ok).toBe(true);
    expect(load(env, { promptId: 'p2' })).toEqual({ ok: false, code: 'purpose_over_bound' });
    const body = JSON.parse(readFileSync(purposePath(env, SESSION), 'utf8')) as { requests: string[] };
    expect(body.requests).toEqual(['keep this first constraint']);
  });

  it('refuses a moved cwd, a missing identifier, a changed prompt and a cancelled turn', () => {
    const env = freshEnv();
    anchored(env);
    recordPrompt({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, prompt: 'fix the keyword search' });
    expect(load(env, { cwd: '/repo/worktree-2' })).toEqual({ ok: false, code: 'purpose_cwd_changed' });
    expect(load(env, { promptId: 'p9' })).toEqual({ ok: false, code: 'purpose_prompt_changed' });
    expect(load(env, { sessionId: undefined })).toEqual({ ok: false, code: 'purpose_missing' });
    expect(load(env, { promptId: undefined })).toEqual({ ok: false, code: 'purpose_missing' });
    expect(load(env, { cwd: undefined })).toEqual({ ok: false, code: 'purpose_missing' });
    expect(load(env, { sessionId: 'other-session' })).toEqual({ ok: false, code: 'purpose_not_anchored' });
    expect(cancelPurpose(env, SESSION).ok).toBe(true);
    expect(load(env)).toEqual({ ok: false, code: 'purpose_cancelled' });
  });

  it('re-anchors after a moved cwd rather than carrying the other checkout purpose over', () => {
    const env = freshEnv();
    anchored(env);
    recordPrompt({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, prompt: 'fix the keyword search' });
    expect(recordPrompt({ env, sessionId: SESSION, promptId: 'p2', cwd: '/repo/other', prompt: 'now in another checkout' }).ok).toBe(true);
    expect(load(env, { promptId: 'p2', cwd: '/repo/other' })).toEqual({ ok: false, code: 'purpose_cwd_changed' });
  });

  it('never filters inside a child or custom agent context', () => {
    const env = freshEnv();
    anchored(env);
    recordPrompt({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, prompt: 'fix the keyword search' });
    expect(load(env, { agentId: 'agent-7' })).toEqual({ ok: false, code: 'purpose_unusable' });
    expect(load(env, { agentType: 'my-custom-agent' })).toEqual({ ok: false, code: 'purpose_unusable' });
  });

  it('reports a state error instead of guessing when the record cannot be read', () => {
    const env = freshEnv();
    anchored(env);
    recordPrompt({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, prompt: 'fix the keyword search' });
    writeFileSync(purposePath(env, SESSION), '{not json');
    expect(load(env)).toEqual({ ok: false, code: 'purpose_state_error' });
    writeFileSync(purposePath(env, SESSION), JSON.stringify({ version: 4, session_id: SESSION, requests: [], cwd_id: 'x' }));
    expect(load(env)).toEqual({ ok: false, code: 'purpose_state_error' });
    expect(recordPrompt({ env, sessionId: SESSION, promptId: 'p2', cwd: CWD, prompt: 'next' })).toEqual({ ok: false, code: 'purpose_state_error' });
  });

  it('detects a purpose that moved while a request was in flight', () => {
    const env = freshEnv();
    anchored(env);
    recordPrompt({ env, sessionId: SESSION, promptId: 'p1', cwd: CWD, prompt: 'fix the keyword search' });
    const before = load(env);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const args = { env, sessionId: SESSION, promptId: 'p1', cwd: CWD, agentId: undefined, agentType: undefined };
    expect(purposeUnchanged(args, before.purpose.revision)).toBe(true);
    recordPrompt({ env, sessionId: SESSION, promptId: 'p2', cwd: CWD, prompt: 'actually search for something else' });
    expect(purposeUnchanged(args, before.purpose.revision)).toBe(false);
  });
});
