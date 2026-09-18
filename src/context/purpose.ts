import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { Env } from '../config.js';
import type { ContextCode } from '../types.js';
import { contextDir, ensurePrivateDir, writeAtomicPrivate } from './store.js';

/**
 * §5: one small record per main session, holding the user's own requests verbatim so the filter judges against the real
 * purpose instead of guessing one from the search pattern. It is not V5 job state: its own subdirectory, its own shape,
 * and no reservation, plan or receipt ever touches it.
 *
 * Reuse is refused, not repaired, whenever the connection to those requests is not intact: a resumed or compacted
 * session, a mid-session installation, a new prompt, a cancellation, a moved cwd, a missing identifier, or a state error.
 */
export const PURPOSE_SUBDIR = 'context-purpose';
/** §5: a development resource bound, not a token budget or a quality guarantee. Over it the filter is disabled, never truncated. */
export const MAX_REQUESTS_BYTES = 8 * 1024;
/** A closed bound on how many requests one record holds; past it the record is disabled like any over-bound bundle. */
export const MAX_REQUESTS = 64;
export const PURPOSE_MAX_FILE_BYTES = 64 * 1024;

export type PurposeCode = Extract<
  ContextCode,
  'purpose_missing' | 'purpose_not_anchored' | 'purpose_unusable' | 'purpose_prompt_changed' | 'purpose_cwd_changed' | 'purpose_cancelled' | 'purpose_over_bound' | 'purpose_state_error'
>;

export interface PurposeRecord {
  version: 5;
  session_id: string;
  /** A digest of the working directory: a purpose from another checkout or worktree is never reused here. */
  cwd_id: string;
  prompt_id: string | null;
  /** The session's user requests, verbatim and in order. Nothing is summarised and nothing else is stored. */
  requests: string[];
  usable: boolean;
  /** Why the record cannot be used, when it cannot. Null only while it is usable. */
  reason: PurposeCode | null;
  updated_at: string;
}

/** What one selection request may use, plus the revision that has to still match after the HTTP call (§5). */
export interface UsablePurpose {
  requests: string[];
  prompt_id: string;
  revision: string;
}

export type PurposeResult = { ok: true; purpose: UsablePurpose } | { ok: false; code: PurposeCode };

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const purposeDir = (env: Env): string => contextDir(env, PURPOSE_SUBDIR);
export const purposePath = (env: Env, sessionId: string): string => join(purposeDir(env), `${sha256(sessionId)}.json`);

/** Changes whenever the identity or the requests change, so an answer for an older purpose can be discarded on arrival. */
export const purposeRevision = (record: PurposeRecord): string =>
  sha256(JSON.stringify([record.session_id, record.cwd_id, record.prompt_id, record.requests]));

/** §5: an empty request and a slash command are not evidence that the previous purpose still holds. */
export const isPurposeEvidence = (prompt: string): boolean => prompt.trim().length > 0 && !prompt.trimStart().startsWith('/');

const read = (env: Env, sessionId: string): { ok: true; record: PurposeRecord | null } | { ok: false; code: PurposeCode } => {
  const file = purposePath(env, sessionId);
  let text: string;
  try {
    if (statSync(file).size > PURPOSE_MAX_FILE_BYTES) return { ok: false, code: 'purpose_state_error' };
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { ok: true, record: null } : { ok: false, code: 'purpose_state_error' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, code: 'purpose_state_error' };
  }
  if (!isRecord(parsed) || parsed['version'] !== 5 || parsed['session_id'] !== sessionId) return { ok: false, code: 'purpose_state_error' };
  const requests = parsed['requests'];
  if (!Array.isArray(requests) || requests.some((r) => typeof r !== 'string') || typeof parsed['cwd_id'] !== 'string') return { ok: false, code: 'purpose_state_error' };
  return {
    ok: true,
    record: {
      version: 5,
      session_id: sessionId,
      cwd_id: parsed['cwd_id'],
      prompt_id: typeof parsed['prompt_id'] === 'string' ? parsed['prompt_id'] : null,
      requests: requests as string[],
      usable: parsed['usable'] === true,
      reason: typeof parsed['reason'] === 'string' ? (parsed['reason'] as PurposeCode) : null,
      updated_at: typeof parsed['updated_at'] === 'string' ? parsed['updated_at'] : '',
    },
  };
};

const write = (env: Env, record: PurposeRecord): { ok: true; record: PurposeRecord } | { ok: false; code: PurposeCode } => {
  const dir = ensurePrivateDir(purposeDir(env));
  if (!dir.ok) return { ok: false, code: 'purpose_state_error' };
  const body = JSON.stringify({ ...record, updated_at: new Date().toISOString() });
  if (bytes(body) > PURPOSE_MAX_FILE_BYTES) return { ok: false, code: 'purpose_state_error' };
  const written = writeAtomicPrivate(purposePath(env, record.session_id), body);
  return written.ok ? { ok: true, record: JSON.parse(body) as PurposeRecord } : { ok: false, code: 'purpose_state_error' };
};

export interface SessionStartInput {
  env: Env;
  sessionId: string;
  cwd: string;
  /** The host's SessionStart source. Only `startup` can anchor a purpose; resume, compact and clear cannot (§5). */
  source: string | undefined;
}

/**
 * A fresh startup anchors an empty, usable record. Resume, compact and clear anchor an unusable one on purpose: the
 * earlier user requests of such a session cannot be connected in this MVP, and this feature does not collect transcripts
 * to fake them.
 */
export const startSession = (input: SessionStartInput): { ok: true; record: PurposeRecord } | { ok: false; code: PurposeCode } => {
  const anchored = input.source === 'startup';
  return write(input.env, {
    version: 5,
    session_id: input.sessionId,
    cwd_id: sha256(input.cwd),
    prompt_id: null,
    requests: [],
    usable: anchored,
    reason: anchored ? null : 'purpose_not_anchored',
    updated_at: '',
  });
};

export interface PromptInput {
  env: Env;
  sessionId: string;
  promptId: string | undefined;
  cwd: string;
  prompt: string;
}

/**
 * Appends this turn's request verbatim and makes it the current prompt. A session with no anchored record was installed
 * mid-session and stays unusable; a moved cwd, a missing prompt identity, an empty request, a slash command and an
 * over-bound bundle each leave the record unusable rather than letting an incomplete purpose be used.
 */
export const recordPrompt = (input: PromptInput): { ok: true; record: PurposeRecord } | { ok: false; code: PurposeCode } => {
  const prev = read(input.env, input.sessionId);
  if (!prev.ok) return prev;
  const cwdId = sha256(input.cwd);
  const unusable = (reason: PurposeCode, requests: string[]): { ok: true; record: PurposeRecord } | { ok: false; code: PurposeCode } =>
    write(input.env, {
      version: 5,
      session_id: input.sessionId,
      cwd_id: cwdId,
      prompt_id: input.promptId ?? null,
      requests,
      usable: false,
      reason,
      updated_at: '',
    });
  if (prev.record === null) return unusable('purpose_not_anchored', []);
  if (prev.record.cwd_id !== cwdId) return unusable('purpose_cwd_changed', []);
  if (prev.record.reason === 'purpose_not_anchored') return unusable('purpose_not_anchored', []);
  if (input.promptId === undefined || input.promptId.length === 0) return unusable('purpose_missing', prev.record.requests);
  if (!isPurposeEvidence(input.prompt)) return unusable('purpose_unusable', prev.record.requests);
  const requests = [...prev.record.requests, input.prompt];
  // §5: over the bound the filter is disabled for this context. The oversized bundle is not stored, because keeping a
  // shortened version of it would be exactly the silent truncation the bound exists to prevent.
  if (requests.length > MAX_REQUESTS || bytes(requests.join('\n')) > MAX_REQUESTS_BYTES) return unusable('purpose_over_bound', prev.record.requests);
  return write(input.env, {
    version: 5,
    session_id: input.sessionId,
    cwd_id: cwdId,
    prompt_id: input.promptId,
    requests,
    usable: true,
    reason: null,
    updated_at: '',
  });
};

/** A cancelled turn stops the purpose being reused; the requests already collected are kept for the session's history. */
export const cancelPurpose = (env: Env, sessionId: string): { ok: true; record: PurposeRecord } | { ok: false; code: PurposeCode } => {
  const prev = read(env, sessionId);
  if (!prev.ok) return prev;
  const record = prev.record;
  if (record === null) return { ok: false, code: 'purpose_missing' };
  return write(env, { ...record, usable: false, reason: 'purpose_cancelled' });
};

export interface LoadPurposeInput {
  env: Env;
  sessionId: string | undefined;
  promptId: string | undefined;
  cwd: string | undefined;
  /** §5: a child or custom-agent context gets no filtering at all; the root purpose is never applied to a worker. */
  agentId: string | undefined;
  agentType: string | undefined;
}

export const loadPurpose = (input: LoadPurposeInput): PurposeResult => {
  if (input.agentId || input.agentType) return { ok: false, code: 'purpose_unusable' };
  if (!input.sessionId || !input.promptId || !input.cwd) return { ok: false, code: 'purpose_missing' };
  const prev = read(input.env, input.sessionId);
  if (!prev.ok) return { ok: false, code: prev.code };
  const record = prev.record;
  if (record === null) return { ok: false, code: 'purpose_not_anchored' };
  if (!record.usable) return { ok: false, code: record.reason ?? 'purpose_unusable' };
  if (record.cwd_id !== sha256(input.cwd)) return { ok: false, code: 'purpose_cwd_changed' };
  if (record.prompt_id !== input.promptId) return { ok: false, code: 'purpose_prompt_changed' };
  if (record.requests.length === 0) return { ok: false, code: 'purpose_missing' };
  return { ok: true, purpose: { requests: record.requests, prompt_id: record.prompt_id, revision: purposeRevision(record) } };
};

/** §5: the same check after the HTTP call. A purpose that moved while the request was in flight keeps the original result. */
export const purposeUnchanged = (input: LoadPurposeInput, revision: string): boolean => {
  const now = loadPurpose(input);
  return now.ok && now.purpose.revision === revision;
};
