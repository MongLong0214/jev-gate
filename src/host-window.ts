import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

import type { Env } from './config.js';

/**
 * #48 P0-1: the window the host actually compacts at, resolved the way the host resolves it (code.claude.com
 * model-config, settings, managed-settings, 2026-09-27): the env var beats every settings scope; managed settings beat
 * project-local, which beats project-shared, which beats user; the result is clamped to the host's accepted range and
 * then capped at the model's own context window. When nothing sets it, the host compacts at the model's context
 * limit, so the model is the default. This never asks Jev and never guesses: what this cannot establish is `null`,
 * and the caller decides what unknown means, the same rule `depth.ts` uses for an unreadable transcript.
 *
 * Not visible from a hook, and so never read: a launch's `--autocompact` or `--settings` flag, MDM policies and
 * server-managed settings. A session started that way can compact somewhere this does not see; the liveness ring
 * (`liveness.ts`) is what notices a floor that is then never reached.
 */

/** A settings file larger than this is not read; a host settings file this large is not the kind we are looking for. */
export const HOST_WINDOW_MAX_BYTES = 1024 * 1024;
/** The host accepts a window from 100K to 1M tokens and clamps the env var into that range. */
export const HOST_WINDOW_MIN = 100_000;
export const HOST_WINDOW_MAX = 1_000_000;
/** The context window of a model without a native 1M window, and of every model under CLAUDE_CODE_DISABLE_1M_CONTEXT. */
export const STANDARD_CONTEXT_WINDOW = 200_000;
/** Bounds the walk up from the session directory to its repository root. */
const REPO_ROOT_MAX_DEPTH = 64;
/** The host names a folder under its projects directory after the session's directory, hashing names past this. */
const PROJECTS_FOLDER_NAME_MAX = 200;

export type HostWindowResult = { tokens: number; source: string } | { tokens: null; source: string };
type Known = { tokens: number; source: string };

export interface HostWindowOptions {
  /** The model the session is running, as the transcript records it; null when it could not be read. */
  model?: string | null;
  /** Directories holding managed-settings.json and managed-settings.d/; defaults to this platform's system directory. */
  managedDirs?: readonly string[];
  /** The hook's `transcript_path`; its folder names the session's directory once `/cd` has moved it. */
  transcriptPath?: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPositiveSafeInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const clampWindow = (n: number): number => Math.min(HOST_WINDOW_MAX, Math.max(HOST_WINDOW_MIN, n));
const isTruthyEnv = (v: string | undefined): boolean => typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false';

const defaultManagedDirs = (): string[] => {
  if (process.platform === 'darwin') return ['/Library/Application Support/ClaudeCode'];
  if (process.platform === 'win32') return ['C:\\Program Files\\ClaudeCode'];
  return ['/etc/claude-code'];
};

const fromEnv = (env: Env): number | null => {
  const raw = env['CLAUDE_CODE_AUTO_COMPACT_WINDOW'];
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) return null;
  const n = Number(raw);
  return isPositiveSafeInteger(n) ? n : null;
};

type Found<T> = { value: T; source: string };
type SettingsPick<T> = (settings: Record<string, unknown>) => T | null;

const pickWindow: SettingsPick<number> = (settings) => {
  const w = settings['autoCompactWindow'];
  return isPositiveSafeInteger(w) ? w : null;
};

/** One candidate file. Never throws: missing, oversized, unreadable, non-JSON and non-object all read as "not set here". */
const readSettingsKey = <T>(path: string, pick: SettingsPick<T>): T | null => {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > HOST_WINDOW_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isRecord(parsed) ? pick(parsed) : null;
  } catch {
    return null;
  }
};

/** The host merges managed-settings.json first, then every non-hidden `managed-settings.d/*.json` alphabetically; the last to set the key wins. */
const readManaged = <T>(dirs: readonly string[], pick: SettingsPick<T>): Found<T> | null => {
  let found: Found<T> | null = null;
  for (const dir of dirs) {
    const file = join(dir, 'managed-settings.json');
    const own = readSettingsKey(file, pick);
    if (own !== null) found = { value: own, source: `managed:${file}` };
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, 'managed-settings.d'))
        .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
        .sort();
    } catch {
      /* no drop-in directory is the common case */
    }
    for (const name of names) {
      const path = join(dir, 'managed-settings.d', name);
      const v = readSettingsKey(path, pick);
      if (v !== null) found = { value: v, source: `managed:${path}` };
    }
  }
  return found;
};

/** The host keeps local settings beside project settings when the root, or its `.git` or `.claude`, is not the user's own. */
const ownedByUser = (root: string): boolean => {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return true;
  for (const path of [root, join(root, '.git'), join(root, '.claude')]) {
    try {
      if (statSync(path).uid !== uid) return false;
    } catch {
      /* an absent `.claude` owns nothing */
    }
  }
  return true;
};

/**
 * The directory the host keeps `settings.local.json` in (settings docs, 2026-09-27): the repository root, and for a
 * linked worktree the main checkout's root; the session directory itself outside a repository, when the root is the
 * home directory, on Windows, or when the root or its `.git` or `.claude` entry is not owned by this user.
 */
const localSettingsDir = (primary: string, home: string): string => {
  if (process.platform === 'win32') return primary;
  const atRoot = (root: string): string => (root === resolve(home) || !ownedByUser(root) ? primary : root);
  let dir = resolve(primary);
  for (let i = 0; i < REPO_ROOT_MAX_DEPTH; i++) {
    const dotGit = join(dir, '.git');
    let st;
    try {
      st = statSync(dotGit);
    } catch {
      st = null;
    }
    if (st?.isDirectory()) return atRoot(dir);
    if (st?.isFile()) {
      // A linked worktree: `.git` names its own git dir, whose `commondir` names the main repository's `.git`.
      try {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
        if (!m || m[1] === undefined) return dir;
        const gitDir = isAbsolute(m[1]) ? m[1] : resolve(dir, m[1]);
        const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
        const commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
        return atRoot(dirname(commonDir));
      } catch {
        return dir;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return primary;
};

/** The session's project settings, local then shared, as the host reads them when the session's directory is `dir`. */
const projectSettingsFiles = (dir: string, home: string): string[] => {
  const rootLocal = join(localSettingsDir(dir, home), '.claude', 'settings.local.json');
  // Before 2.1.211 the host kept the local file in the starting directory, and it still reads one left there; the
  // root file's value wins where both set the key, so the legacy file is the next candidate rather than ignored.
  const legacyLocal = join(dir, '.claude', 'settings.local.json');
  return legacyLocal === rootLocal ? [rootLocal, join(dir, '.claude', 'settings.json')] : [rootLocal, legacyLocal, join(dir, '.claude', 'settings.json')];
};

const sameDir = (a: string, b: string): boolean => {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

/**
 * Whether `folder` is the name the host gives `dir`'s folder under its projects directory: every character but ASCII
 * letters and digits becomes `-`. Past 200 characters the host appends a hash of the path, which is not reproduced
 * here, so only the prefix is compared there.
 */
const namesDir = (folder: string, dir: string): boolean => {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {
    // An unreadable directory is compared by its given path alone.
  }
  return [dir, real].some((d) => {
    const name = d.replace(/[^a-zA-Z0-9]/g, '-');
    return name.length <= PROJECTS_FOLDER_NAME_MAX ? folder === name : folder.startsWith(`${name.slice(0, PROJECTS_FOLDER_NAME_MAX)}-`);
  });
};

/** The session's folder under the host's projects directory (`<config>/projects/<folder>/…`), or null elsewhere. */
const transcriptFolder = (transcriptPath: string | null | undefined): string | null => {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) return null;
  const parts = resolve(transcriptPath).split(sep);
  const i = parts.lastIndexOf('projects');
  return i >= 0 && i + 2 < parts.length ? (parts[i + 1] ?? null) : null;
};

const withParents = (dir: string): string[] => {
  const out: string[] = [];
  for (let d = resolve(dir), i = 0; i < REPO_ROOT_MAX_DEPTH; i += 1) {
    out.push(d);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return out;
};

/**
 * The directories whose project settings the host may be reading, or why none can be named. The host reads them from
 * the session's directory, which starts at CLAUDE_PROJECT_DIR; `/cd` moves it, and the hook's `cwd` with it, but
 * leaves CLAUDE_PROJECT_DIR at the start, and a `cd` in Bash moves only the `cwd`, back to the start included. So
 * neither names it once the session has moved. The host keeps the transcript in a folder named after the session's
 * directory and moves it on `/cd`, so where the transcript is in that layout its folder decides, rather than
 * CLAUDE_PROJECT_DIR or the `cwd`: the candidates (CLAUDE_PROJECT_DIR, the `cwd` and its parents) it names, or none.
 * Only without it do CLAUDE_PROJECT_DIR and the `cwd` stand in, and where they differ every candidate must agree.
 */
type SettingsDirs = { dirs: string[] } | { unknown: string };

const settingsDirCandidates = (env: Env, cwd: string | null | undefined, transcriptPath: string | null | undefined): SettingsDirs => {
  const envDir = env['CLAUDE_PROJECT_DIR'];
  const started = typeof envDir === 'string' && envDir.length > 0 ? envDir : null;
  const here = typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
  const candidates = [...new Set([...(started === null ? [] : [resolve(started)]), ...(here === null ? [] : withParents(here))])];
  const folder = transcriptFolder(transcriptPath);
  if (folder !== null && candidates.length > 0) {
    const named = candidates.filter((d) => namesDir(folder, d));
    return named.length > 0 ? { dirs: named } : { unknown: `the transcript folder ${folder} names none of CLAUDE_PROJECT_DIR, the cwd or its parents` };
  }
  if (started === null) return { dirs: here === null ? [] : [here] };
  if (here === null || sameDir(here, started)) return { dirs: [started] };
  return { dirs: candidates };
};

type Ambiguous = { ambiguous: string };

/**
 * Settings scopes a hook can read, first valid wins: managed, project-local, project-shared, user, with the project
 * scopes read from each directory in `where`. Several stand only once the session has moved; the value is known if
 * every one of them gives it.
 */
const readSettingsChain = <T>(env: Env, where: SettingsDirs, managedDirs: readonly string[], pick: SettingsPick<T>): Found<T> | Ambiguous | null => {
  const managed = readManaged(managedDirs, pick);
  if (managed !== null) return managed;

  const home = env['HOME'] && env['HOME'].length > 0 ? env['HOME'] : homedir();
  const configDir = env['CLAUDE_CONFIG_DIR'] && env['CLAUDE_CONFIG_DIR'].length > 0 ? env['CLAUDE_CONFIG_DIR'] : join(home, '.claude');
  const userFile = join(configDir, 'settings.json');
  const chain = (files: string[]): Found<T> | null => {
    for (const path of files) {
      const value = readSettingsKey(path, pick);
      if (value !== null) return { value, source: `settings:${path}` };
    }
    return null;
  };

  if ('unknown' in where) return { ambiguous: where.unknown };
  const dirs = where.dirs;
  if (dirs.length === 0) return chain([userFile]);
  const found = dirs.map((d) => chain([...projectSettingsFiles(d, home), userFile]));
  const first = found[0] ?? null;
  if (found.every((f) => (f?.value ?? null) === (first?.value ?? null))) return first;
  return { ambiguous: `the session moved from CLAUDE_PROJECT_DIR and its settings directories disagree (${dirs.length} candidates)` };
};

/**
 * #48: a variable a settings `env` block sets, resolved through the same scopes as the window -- managed, project-local,
 * project-shared, user -- for doctor, which runs outside any session and has only its own cwd. The host applies
 * settings env over the shell's, so a value found here is the one a session started from `cwd` would see.
 */
export const readSettingsEnvVar = (env: Env, cwd: string | null, key: string, managedDirs: readonly string[] = defaultManagedDirs()): Found<string> | Ambiguous | null =>
  readSettingsChain(env, settingsDirCandidates(env, cwd, null), managedDirs, (settings) => {
    const block = settings['env'];
    const value = isRecord(block) ? block[key] : undefined;
    return typeof value === 'string' ? value : null;
  });

const readConfiguredWindow = (env: Env, cwd: string | null | undefined, managedDirs: readonly string[], transcriptPath: string | null | undefined): Known | Ambiguous | null => {
  const envWindow = fromEnv(env);
  if (envWindow !== null) return { tokens: envWindow, source: 'env' };
  const found = readSettingsChain(env, settingsDirCandidates(env, cwd, transcriptPath), managedDirs, pickWindow);
  return found === null || 'ambiguous' in found ? found : { tokens: found.value, source: found.source };
};

/** ANTHROPIC_BASE_URL naming anything but Anthropic's own API, which the host treats as an LLM gateway. */
const behindGateway = (env: Env): boolean => {
  const raw = env['ANTHROPIC_BASE_URL'];
  if (typeof raw !== 'string' || raw.trim() === '') return false;
  try {
    return new URL(raw).hostname !== 'api.anthropic.com';
  } catch {
    return true;
  }
};

/**
 * The model's own context window, which caps any configured window and is the window when none is configured. From
 * the host's model-config page (2026-09-27): Fable, Sonnet 5 and Opus 4.7+ run a native 1M window on the Anthropic
 * API; earlier Opus and Sonnet (without an explicit `[1m]` variant) and Haiku run 200K; CLAUDE_CODE_DISABLE_1M_CONTEXT
 * treats every model as 200K. On Bedrock, Vertex and Foundry the host pins native-1M models per deployment, so their
 * window is not established here; behind an LLM gateway (ANTHROPIC_BASE_URL) Sonnet 5 is 200K unless `[1m]` was
 * picked. An ID this does not recognise, such as a gateway alias, is null.
 */
export const modelContextWindow = (env: Env, model: string | null | undefined): Known | null => {
  if (isTruthyEnv(env['CLAUDE_CODE_DISABLE_1M_CONTEXT'])) return { tokens: STANDARD_CONTEXT_WINDOW, source: 'CLAUDE_CODE_DISABLE_1M_CONTEXT' };
  if (typeof model !== 'string' || model.length === 0) return null;
  if (model.includes('[1m]')) return { tokens: HOST_WINDOW_MAX, source: `model:${model}` };
  // Claude 3.x names put the version first (claude-3-5-sonnet-...); all of them are 200K.
  if (/^claude-[0-9]/.test(model)) return { tokens: STANDARD_CONTEXT_WINDOW, source: `model:${model}` };
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2})(?!\d))?/.exec(model);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const family = m[1];
  const major = Number(m[2]);
  const minor = m[3] === undefined ? 0 : Number(m[3]);
  const native1M = family === 'fable' || (family === 'sonnet' && major >= 5) || (family === 'opus' && (major > 4 || (major === 4 && minor >= 7)));
  if (!native1M) return { tokens: STANDARD_CONTEXT_WINDOW, source: `model:${model}` };
  const thirdParty = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some((k) => isTruthyEnv(env[k]));
  if (thirdParty) return null;
  // Behind an LLM gateway the host cannot verify 1M support and budgets Sonnet 5 at 200K unless `sonnet[1m]` was
  // picked, which the `[1m]` check above already caught; the page says nothing of Opus or Fable there, so unknown.
  if (behindGateway(env)) return family === 'sonnet' ? { tokens: STANDARD_CONTEXT_WINDOW, source: `model:${model} behind ANTHROPIC_BASE_URL` } : null;
  return { tokens: HOST_WINDOW_MAX, source: `model:${model}` };
};

/**
 * Configured window (first valid wins: env, managed, project-local, project-shared, user), clamped to the host's
 * range, capped at the model's window when that is known; the model's window alone when nothing is configured.
 * `cwd` is the tool call's own `cwd`, not `process.cwd()` -- the hook runs as a child of the host.
 */
export const readHostCompactWindow = (env: Env, cwd: string | null | undefined, opts: HostWindowOptions = {}): HostWindowResult => {
  const configured = readConfiguredWindow(env, cwd, opts.managedDirs ?? defaultManagedDirs(), opts.transcriptPath ?? null);
  if (configured !== null && 'ambiguous' in configured) return { tokens: null, source: `unknown: ${configured.ambiguous}` };
  const model = modelContextWindow(env, opts.model ?? null);
  if (configured === null) return model === null ? { tokens: null, source: 'unknown' } : { tokens: model.tokens, source: `default:${model.source}` };
  const clamped = clampWindow(configured.tokens);
  const source = clamped === configured.tokens ? configured.source : `${configured.source} (clamped from ${configured.tokens})`;
  if (model !== null && model.tokens < clamped) return { tokens: model.tokens, source: `${source} capped by ${model.source}` };
  return { tokens: clamped, source };
};

export type WorktreeBaseRef = 'fresh' | 'head';
export type WorktreeBaseRefResult = { value: WorktreeBaseRef; source: string } | { value: null; source: string };

const pickBaseRef: SettingsPick<WorktreeBaseRef> = (settings) => {
  const worktree = settings['worktree'];
  if (!isRecord(worktree)) return null;
  const ref = worktree['baseRef'];
  return ref === 'fresh' || ref === 'head' ? ref : null;
};

/**
 * #48 P1-2 review: the ref a subagent's `isolation: "worktree"` branches from. Claude Code 2.1.283's settings schema
 * describes `worktree.baseRef` as applying to "--worktree, EnterWorktree, and agent isolation": `"fresh"`, the
 * default, branches from origin/<default-branch>; `"head"` from the session's local HEAD. Unset reads as `null`, which
 * the host treats as "fresh". Read through the same scopes as the window, with the same blind spots (`--settings`,
 * MDM, server-managed settings).
 */
export const readHostWorktreeBaseRef = (env: Env, projectDir: string | null | undefined, opts: Pick<HostWindowOptions, 'managedDirs' | 'transcriptPath'> & { cwd?: string | null } = {}): WorktreeBaseRefResult => {
  // #53 review: project scopes live in the session's directory. A hook's own `cwd` moves with `cd`, so reading them
  // from it alone could miss a "fresh" at the real project root and fall through to a user-level "head"; without
  // CLAUDE_PROJECT_DIR (or a caller that knows the directory, like doctor) the answer is unknown rather than guessed.
  // Once the `cwd` has moved away from it, the directory is chosen as for the window (`settingsDirCandidates`).
  const envDir = env['CLAUDE_PROJECT_DIR'];
  const dir = typeof envDir === 'string' && envDir.length > 0 ? envDir : projectDir;
  if (typeof dir !== 'string' || dir.length === 0) return { value: null, source: 'project dir unknown' };
  const where = settingsDirCandidates({ ...env, CLAUDE_PROJECT_DIR: dir }, opts.cwd ?? null, opts.transcriptPath ?? null);
  const found = readSettingsChain(env, where, opts.managedDirs ?? defaultManagedDirs(), pickBaseRef);
  if (found === null) return { value: null, source: 'unset' };
  return 'ambiguous' in found ? { value: null, source: `unknown: ${found.ambiguous}` } : found;
};
