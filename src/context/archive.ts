import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import type { Env } from '../config.js';
import type { ContextCode } from '../types.js';
import { contextDir, createExclusivePrivate, dirFileBytes, ensurePrivateDir } from './store.js';

/**
 * §8: before any replacement is proposed, the search content actually received in this call is written to a private local
 * file, so the omitted original is recoverable by the session's own `Read`. Re-running the search later can return
 * something else, which is why the snapshot is this call's bytes rather than a pointer to the source files.
 *
 * Nothing here uploads, overwrites, follows a symlink, deletes to make room, or expires on a timer.
 */
export const ARCHIVE_SUBDIR = 'context-archive';
/**
 * A development resource cap for the whole directory. Over it new filtering is skipped rather than a referenced snapshot
 * being removed, and because the check races concurrent writers it bounds growth instead of enforcing an exact quota.
 */
export const ARCHIVE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type ArchiveCode = Extract<ContextCode, 'archive_dir_failed' | 'archive_write_failed' | 'archive_cap_reached'>;

export interface ArchiveOwner {
  sessionId: string;
  promptId: string;
  toolUseId: string;
}

export type ArchiveResult = { ok: true; file: string; digest: string } | { ok: false; code: ArchiveCode };

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export const archiveDir = (env: Env): string => contextDir(env, ARCHIVE_SUBDIR);

/** Opaque and deterministic: derived from the owner and the content digest, so it carries no prompt text or secret. */
export const archiveName = (owner: ArchiveOwner, digest: string): string =>
  `${sha256(JSON.stringify([owner.sessionId, owner.promptId, owner.toolUseId, digest]))}.txt`;

/**
 * The header binds the snapshot to its digest without repeating any identifier that could be sensitive; the original
 * content follows it verbatim, so a `Read` of this file shows exactly the bytes the search returned.
 */
const body = (digest: string, content: string): string => `jev-gate original search result\ndigest sha256:${digest}\nbytes ${Buffer.byteLength(content, 'utf8')}\n--\n${content}`;

export const archiveSearchResult = (env: Env, owner: ArchiveOwner, content: string, maxTotalBytes: number = ARCHIVE_MAX_TOTAL_BYTES): ArchiveResult => {
  const dir = archiveDir(env);
  const opened = ensurePrivateDir(dir);
  if (!opened.ok) return { ok: false, code: 'archive_dir_failed' };
  if (dirFileBytes(dir) >= maxTotalBytes) return { ok: false, code: 'archive_cap_reached' };
  const digest = sha256(content);
  const file = join(dir, archiveName(owner, digest));
  const text = body(digest, content);
  const written = createExclusivePrivate(file, text);
  if (written.ok) return { ok: true, file, digest };
  // EEXIST means this exact owner and content was already archived, so recovery works and nothing is overwritten. It is
  // only accepted after confirming the existing path really is that snapshot: `wx` refuses a symlink but does not say so.
  if (written.error !== 'EEXIST') return { ok: false, code: 'archive_write_failed' };
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size !== Buffer.byteLength(text, 'utf8')) return { ok: false, code: 'archive_write_failed' };
  } catch {
    return { ok: false, code: 'archive_write_failed' };
  }
  return { ok: true, file, digest };
};
