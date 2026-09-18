import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** #15 §1: a case id is one safe path component; arm/repetition components come from trusted values. */
export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const isSafeId = (id: string): boolean => SAFE_ID_RE.test(id) && id.length <= 64;

/** Canonical containment: `child` resolves inside `parent` (both may not exist yet; the nearest existing ancestor is canonicalized). */
export const canonicalize = (p: string): string => {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    tail.unshift(cur.slice(dirname(cur).length + 1));
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return join(realpathSync(cur), ...tail);
};

export const isInside = (parent: string, child: string): boolean => {
  const rel = relative(canonicalize(parent), canonicalize(child));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};

export const overlaps = (a: string, b: string): boolean => isInside(a, b) || isInside(b, a);

/** Credential-like names are never copied into a run (#15 §3, #8 R9). Harmless examples such as `.env.example` are allowed. */
export const SENSITIVE_NAME_RE = /^(\.env(\..+)?|.*\.pem|.*\.key|id_rsa.*|id_ed25519.*|\.npmrc|\.netrc|credentials(\..+)?)$/i;
export const isSensitiveName = (name: string): boolean => SENSITIVE_NAME_RE.test(name) && name !== '.env.example';
export const EXCLUDED_DIRS = new Set(['.git', 'node_modules']);

export interface SnapshotEntry {
  path: string;
  kind: 'symlink' | 'sensitive' | 'unsupported';
  target?: string;
}

export interface SnapshotReport {
  files: number;
  bytes: number;
  skipped: SnapshotEntry[];
  sha256: string;
}

interface CopyOptions {
  /** Preserve `.git` (final snapshots keep intermediate commits); initial fixtures exclude it. */
  keepGit?: boolean;
  /** Paths (canonical) that must never be entered, such as the run's own output directory. */
  forbiddenRoots?: string[];
  /** When true, a symlink inside the source is a preparation error instead of a recorded skip (#15 §3). */
  strictSymlinks?: boolean;
}

const hashFile = (h: ReturnType<typeof createHash>, rel: string, mode: number, data: Buffer): void => {
  h.update(`${rel}\0${(mode & 0o111) !== 0 ? 'x' : '-'}\0${data.byteLength}\0`);
  h.update(data);
};

/**
 * Copies regular files and directories, preserving executable bits and recording (never following) symlinks, sensitive
 * names and unsupported entry types. Returns a content hash over (relative path, exec bit, bytes) in sorted order.
 */
export const copyTree = (src: string, dst: string, opts: CopyOptions = {}): SnapshotReport => {
  const srcCanon = canonicalize(src);
  // Forbidden roots are never entered while walking the source (e.g. a run directory nested under an input tree).
  const forbidden = (opts.forbiddenRoots ?? []).map(canonicalize);
  if (overlaps(srcCanon, canonicalize(dst))) throw new Error(`source ${src} and destination ${dst} overlap`);
  const report: SnapshotReport = { files: 0, bytes: 0, skipped: [], sha256: '' };
  const h = createHash('sha256');
  const walk = (from: string, to: string, rel: string): void => {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from).sort()) {
      const s = join(from, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (forbidden.some((f) => canonicalize(s) === f)) continue;
      const st = lstatSync(s);
      if (st.isSymbolicLink()) {
        if (opts.strictSymlinks) throw new Error(`unsupported symlink in source: ${relPath}`);
        report.skipped.push({ path: relPath, kind: 'symlink', target: readlinkSync(s) });
        h.update(`${relPath}\0symlink\0`);
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDED_DIRS.has(name) && !(name === '.git' && opts.keepGit)) continue;
        walk(s, join(to, name), relPath);
        continue;
      }
      if (!st.isFile()) {
        report.skipped.push({ path: relPath, kind: 'unsupported' });
        h.update(`${relPath}\0unsupported\0`);
        continue;
      }
      if (isSensitiveName(name)) {
        report.skipped.push({ path: relPath, kind: 'sensitive' });
        h.update(`${relPath}\0sensitive\0${st.size}\0`);
        continue;
      }
      const data = readFileSync(s);
      copyFileSync(s, join(to, name));
      try {
        const mode = statSync(s).mode;
        if ((mode & 0o111) !== 0) chmodSync(join(to, name), mode & 0o777);
      } catch {
        /* mode preservation is best effort */
      }
      hashFile(h, relPath, st.mode, data);
      report.files++;
      report.bytes += data.byteLength;
    }
  };
  walk(srcCanon, dst, '');
  report.sha256 = h.digest('hex');
  return report;
};

/** Hash of an existing tree using the same rules as copyTree, without copying. */
export const hashTree = (dir: string, keepGit = true): string => {
  const h = createHash('sha256');
  const walk = (from: string, rel: string): void => {
    for (const name of readdirSync(from).sort()) {
      const s = join(from, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const st = lstatSync(s);
      if (st.isSymbolicLink()) {
        h.update(`${relPath}\0symlink\0`);
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDED_DIRS.has(name) && !(name === '.git' && keepGit)) continue;
        walk(s, relPath);
        continue;
      }
      if (!st.isFile()) {
        h.update(`${relPath}\0unsupported\0`);
        continue;
      }
      if (isSensitiveName(name)) {
        h.update(`${relPath}\0sensitive\0${st.size}\0`);
        continue;
      }
      hashFile(h, relPath, st.mode, readFileSync(s));
    }
  };
  walk(dir, '');
  return h.digest('hex');
};

/** Creates `dir` exclusively (parent must exist or be creatable; the leaf must not exist, even empty). */
export const createExclusiveDir = (dir: string): void => {
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir); // throws EEXIST when the leaf already exists, empty or not
};
