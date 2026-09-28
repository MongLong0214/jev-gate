import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';

import { loadConfig } from '../../src/evidence/source.js';
import type { EvidenceConfig } from '../../src/evidence/types.js';

/** Shared by the evidence tests: real temporary Git repositories and the one config file the service reads. */
export const tmp = mkdtempSync(join(tmpdir(), 'jev-evidence-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

export const write = (root: string, rel: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

/** A fresh repository whose files are all untracked and not ignored unless a test adds or ignores them. */
export const repo = (files: Record<string, string | Buffer> = {}): string => {
  const root = mkdtempSync(join(tmp, 'repo-'));
  git(root, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  return root;
};

export const configFile = (body: unknown): string => {
  const path = join(mkdtempSync(join(tmp, 'cfg-')), 'evidence.json');
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
};

export const config = async (projectRoot: string, over: Record<string, unknown> = {}): Promise<EvidenceConfig> => {
  const loaded = await loadConfig({ JEV_EVIDENCE_CONFIG: configFile({ projectRoot, allowedRoots: ['.'], ...over }) });
  if (!loaded.ok) throw new Error(`config refused: ${loaded.detail}`);
  return loaded.config;
};

export const live = (): AbortSignal => new AbortController().signal;

/** Lines start..end (1-based, inclusive) of the file's own bytes: the oracle a returned `text` must equal. */
export const lineBytes = (buf: Buffer, start: number, end: number): Buffer => {
  const starts = [0];
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) starts.push(i + 1);
  if (starts[starts.length - 1] !== buf.length) starts.push(buf.length);
  return buf.subarray(starts[start - 1], starts[end]);
};
