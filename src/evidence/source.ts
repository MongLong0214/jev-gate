import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';

import { LIMITS, type EvidenceConfig } from './types.js';

export const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A caller's or owner's relative path, lexically normalized: '' is the project root itself. Absolute paths, `..`
 * escapes, NUL and backslashes are refused rather than repaired.
 */
export const normalizeRelative = (p: string): string | null => {
  if (p === '' || isAbsolute(p) || p.includes('\0') || p.includes('\\')) return null;
  const n = posix.normalize(p).replace(/\/+$/, '');
  if (n === '..' || n.startsWith('../') || n.startsWith('/')) return null;
  return n === '.' ? '' : n;
};

/** Component-wise, never a string prefix: `src` holds `src/a.ts`, not `src-old/a.ts`. */
export const within = (rel: string, root: string): boolean => root === '' || rel === root || rel.startsWith(`${root}/`);

const EXCLUDED_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'bower_components', 'jspm_packages', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.venv', 'venv', '__pycache__', 'pods', '.gradle',
]);
const CREDENTIAL_FILE =
  /^(?:\.env.*|.*\.(?:pem|key|p12|pfx|jks|keystore|crt|cer|der|gpg|asc|kdbx|tfstate|tfstate\.backup)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.netrc|\.pgpass|\.git-credentials|\.htpasswd|credentials(?:\.[\w-]+)?)$/i;

/** `**` crosses directories, `*` and `?` do not; everything else is literal. */
export const globToRegExp = (glob: string): RegExp => {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
};

/** The fixed exclusions, then the owner's, which may only narrow further. A glob matching a directory excludes its contents. */
export const excluded = (rel: string, ownerGlobs: readonly RegExp[]): boolean => {
  const parts = rel.split('/');
  // Lower-cased: on a case-insensitive file system NODE_MODULES is node_modules.
  if (parts.some((p) => EXCLUDED_DIRS.has(p.toLowerCase())) || CREDENTIAL_FILE.test(parts[parts.length - 1]!)) return true;
  if (ownerGlobs.length === 0) return false;
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (ownerGlobs.some((g) => g.test(prefix))) return true;
  }
  return false;
};

/** Git with the repository's configurable command hooks off and no inherited redirection of which repository it reads. */
const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
};
const GIT_PREFIX = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '--literal-pathspecs'];

const git = (cwd: string, args: string[], maxBuffer: number, timeout: number): Promise<{ stdout: Buffer; error: NodeJS.ErrnoException | null; killed: boolean }> =>
  new Promise((resolve) => {
    execFile('git', [...GIT_PREFIX, ...args], { cwd, encoding: 'buffer', maxBuffer, timeout, windowsHide: true, env: gitEnv() }, (error, stdout) => {
      const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({ stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0), error: e, killed: e?.killed === true });
    });
  });

export type ConfigLoad = { ok: true; config: EvidenceConfig } | { ok: false; reason: 'unavailable_config' | 'unsupported_inventory'; detail: string };

const CONFIG_KEYS = new Set(['projectRoot', 'allowedRoots', 'excludeGlobs', 'remote']);

/**
 * The one configuration, read once at start from the absolute path in JEV_EVIDENCE_CONFIG. No search for a file, no
 * key in it, no reload. The detail names what is wrong, never a value from the file.
 */
export const loadConfig = async (env: Readonly<Record<string, string | undefined>>): Promise<ConfigLoad> => {
  const bad = (detail: string): ConfigLoad => ({ ok: false, reason: 'unavailable_config', detail });
  const path = env['JEV_EVIDENCE_CONFIG'];
  if (!path) return bad('JEV_EVIDENCE_CONFIG is not set');
  if (!isAbsolute(path)) return bad('JEV_EVIDENCE_CONFIG is not an absolute path');
  let raw: unknown;
  try {
    // One descriptor and a capped read, so a file that grows after the check is still read only to its bound.
    const fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let text: string;
    try {
      if (!(await fh.stat()).isFile()) return bad('JEV_EVIDENCE_CONFIG is not a regular file');
      const cap = Buffer.alloc(LIMITS.configBytes + 1);
      const { bytesRead } = await fh.read(cap, 0, cap.length, 0);
      if (bytesRead > LIMITS.configBytes) return bad('the config file is over 64 KiB');
      text = cap.subarray(0, bytesRead).toString('utf8');
    } finally {
      await fh.close();
    }
    raw = JSON.parse(text);
  } catch {
    return bad('the config file cannot be read as JSON');
  }
  if (!isRecord(raw)) return bad('the config is not a JSON object');
  const unknown = Object.keys(raw).find((k) => !CONFIG_KEYS.has(k));
  if (unknown) return bad(`unknown config key ${JSON.stringify(unknown)}`);
  const { projectRoot, allowedRoots, excludeGlobs, remote } = raw;
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)) return bad('projectRoot is not an absolute path');
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0 || allowedRoots.length > 64) return bad('allowedRoots is not a list of 1 to 64 paths');
  const roots: string[] = [];
  for (const r of allowedRoots) {
    const n = typeof r === 'string' ? (r === '.' ? '' : normalizeRelative(r)) : null;
    if (n === null) return bad('an allowedRoots entry is not a relative path inside the project');
    roots.push(n);
  }
  if (excludeGlobs !== undefined && (!Array.isArray(excludeGlobs) || excludeGlobs.length > 64 || !excludeGlobs.every((g) => typeof g === 'string' && g !== '' && !g.includes('\0'))))
    return bad('excludeGlobs is not a list of up to 64 globs');
  if (remote !== undefined && typeof remote !== 'boolean') return bad('remote is not a boolean');

  // The root's own OS alias (a symlinked checkout, /tmp on macOS) is resolved once here; nothing below it is followed.
  let canonical: string;
  try {
    canonical = await realpath(projectRoot);
  } catch {
    return bad('projectRoot does not exist');
  }
  const top = await git(canonical, ['rev-parse', '--show-toplevel'], 64 * 1024, 2000);
  const topPath = top.error ? null : top.stdout.toString('utf8').trim();
  let topReal: string | null = null;
  try {
    topReal = topPath ? await realpath(topPath) : null;
  } catch {
    topReal = null;
  }
  if (topReal !== canonical) return { ok: false, reason: 'unsupported_inventory', detail: 'projectRoot is not the root of a Git worktree' };
  return { ok: true, config: { projectRoot: canonical, allowedRoots: roots, excludeGlobs: (excludeGlobs as string[] | undefined) ?? [], remote: remote === true } };
};

export interface Inventory {
  /** Candidate paths in byte order, deduplicated; not yet filtered by exclusions. */
  paths: string[];
  /** False when the listing stopped at its byte or time bound: the paths are a prefix, and no total is known. */
  complete: boolean;
  /** Listed names that are not UTF-8 or name a nested repository: never readable here. */
  unreadable: number;
}

/**
 * Tracked plus non-ignored untracked files under the given literal pathspecs, NUL-separated. The caller's strings
 * are arguments after `--`, never a shell line. Null: not a Git worktree here, or Git failed outright.
 */
export const listFiles = async (root: string, pathspecs: readonly string[], timeoutMs: number): Promise<Inventory | null> => {
  const specs = pathspecs.map((p) => (p === '' ? '.' : p));
  const run = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...specs], LIMITS.inventoryBytes, Math.max(1, timeoutMs));
  const truncated = run.error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || run.killed;
  if (run.error && !truncated) return null;
  const fields = run.stdout.toString('latin1').split('\0');
  // The last field is either the empty string after a final NUL or, when the output was cut, a partial name.
  fields.pop();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const seen = new Set<string>();
  let unreadable = 0;
  for (const f of fields) {
    let name: string;
    try {
      name = decoder.decode(Buffer.from(f, 'latin1'));
    } catch {
      unreadable++;
      continue;
    }
    if (name.endsWith('/')) unreadable++;
    else seen.add(name);
  }
  return { paths: [...seen].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))), complete: !truncated, unreadable };
};

/** Whether anything is at the path, without reading it or following a final symlink. */
export const exists = (root: string, rel: string): Promise<boolean> => lstat(join(root, rel)).then(() => true, () => false);

export type ReadOutcome =
  | { ok: true; bytes: number; text: string; sha256: string }
  /** `excluded`: not a readable text source by rule (binary, not UTF-8, a symlink or special file, gone); `incomplete`: a limit or a change stopped the read. */
  | { ok: false; kind: 'excluded' | 'incomplete'; why: 'missing' | 'not_regular' | 'binary' | 'too_large' | 'changed' | 'error'; bytes: number };

const sameFile = (a: { ino: number; dev: number; size: number; mtimeMs: number; ctimeMs: number }, b: typeof a): boolean =>
  a.ino === b.ino && a.dev === b.dev && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/**
 * One file below the canonical root: its real path must be exactly the lexical one (no symlink at any component),
 * it must be a regular file under the per-file bound, observed the same before and after the read, and strict UTF-8
 * without NUL. The text keeps a BOM, so slices of it are the file's own characters. `bytes` is what was read.
 */
export const readSource = async (root: string, rel: string): Promise<ReadOutcome> => {
  const abs = join(root, rel);
  let before;
  try {
    if ((await realpath(abs)) !== abs) return { ok: false, kind: 'excluded', why: 'not_regular', bytes: 0 };
    before = await lstat(abs);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR';
    return { ok: false, kind: missing ? 'excluded' : 'incomplete', why: missing ? 'missing' : 'error', bytes: 0 };
  }
  if (!before.isFile()) return { ok: false, kind: 'excluded', why: 'not_regular', bytes: 0 };
  if (before.size > LIMITS.fileBytes) return { ok: false, kind: 'incomplete', why: 'too_large', bytes: 0 };
  let buf: Buffer;
  try {
    const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await fh.stat();
      if (!st.isFile() || !sameFile(st, before)) return { ok: false, kind: 'incomplete', why: 'changed', bytes: 0 };
      const cap = Buffer.alloc(LIMITS.fileBytes + 1);
      let n = 0;
      for (;;) {
        const { bytesRead } = await fh.read(cap, n, cap.length - n, n);
        if (bytesRead === 0) break;
        n += bytesRead;
        if (n === cap.length) break;
      }
      buf = cap.subarray(0, n);
    } finally {
      await fh.close();
    }
    const after = await lstat(abs);
    // Again after the read: an ancestor swapped for a symlink between the checks would resolve elsewhere now.
    if (!sameFile(after, before) || buf.length !== before.size || (await realpath(abs)) !== abs) return { ok: false, kind: 'incomplete', why: 'changed', bytes: buf.length };
  } catch {
    return { ok: false, kind: 'incomplete', why: 'error', bytes: 0 };
  }
  if (buf.includes(0)) return { ok: false, kind: 'excluded', why: 'binary', bytes: buf.length };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch {
    return { ok: false, kind: 'excluded', why: 'binary', bytes: buf.length };
  }
  return { ok: true, bytes: buf.length, text, sha256: sha256Hex(buf) };
};
