import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { overlaps } from '../bench/paths.js';
import type { Obj } from './source.js';

type Word = { text: string; dynamic: boolean };
type Segment = { words: Word[]; redirects: { op: string; target: Word }[]; next: string; dynamic: boolean };
const OP = /^(?:<\(|>\(|&&|\|\||\|&|;;|>>|>&|>\||&>>?|<<-?|<&|<>|[|&;\n()<>])/;

/** POSIX words and operators with quoting honoured. Expansion outside single quotes, subshells and substitutions mark `dynamic`; null is unparseable. */
const parse = (src: string): Segment[] | null => {
  const segments: Segment[] = [];
  let seg: Segment = { words: [], redirects: [], next: '', dynamic: false };
  let word: Word | null = null; let redirect: string | null = null;
  const at = (): Word => (word ??= { text: '', dynamic: false });
  const flush = (): void => {
    if (!word) return;
    if (redirect) seg.redirects.push({ op: redirect, target: word }); else seg.words.push(word);
    word = null; redirect = null;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "'") { const close = src.indexOf("'", i + 1); if (close < 0) return null; at().text += src.slice(i + 1, close); i = close; continue; }
    if (c === '"') {
      const w = at();
      for (i++; src[i] !== '"'; i++) {
        if (i >= src.length) return null;
        if (src[i] === '$' || src[i] === '`') w.dynamic = true;
        if (src[i] === '\\' && '"\\$`'.includes(src[i + 1] ?? '\0')) i++;
        w.text += src[i];
      }
      continue;
    }
    if (c === '\\') { i++; if (i < src.length && src[i] !== '\n') at().text += src[i]; continue; }
    if (c === '#' && !word) { while (i + 1 < src.length && src[i + 1] !== '\n') i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); continue; }
    const op = OP.exec(src.slice(i))?.[0];
    if (!op) { if (c === '$' || c === '`') at().dynamic = true; at().text += c; continue; }
    flush(); i += op.length - 1;
    if (/^(?:[<>]|&>)/.test(op) && !op.endsWith('(')) { if (redirect) return null; redirect = op; continue; }
    if (redirect) return null;
    if (/[()]/.test(op)) { seg.dynamic = true; continue; }
    seg.next = op; segments.push(seg); seg = { words: [], redirects: [], next: '', dynamic: false };
  }
  flush();
  if (redirect) return null;
  segments.push(seg);
  return segments.filter(s => s.words.length || s.redirects.length || s.dynamic);
};

// Closed list: each entry only reads files or host state. Anything else, including an unlisted option that writes, is not read-only.
const READ_ONLY = new Set(['[', 'basename', 'cat', 'cd', 'cut', 'diff', 'dirname', 'echo', 'grep', 'head', 'jq', 'ls', 'nl', 'ps', 'pwd', 'realpath', 'stat', 'tail', 'test', 'tr', 'true', 'wc', 'which']);
/** `sed -n` whose every script only prints line addresses (`1,80p`, `10p;20,30p`, `$p`); any other option or command writes or executes. */
const printOnlySed = (args: string[]): boolean => {
  let quiet = false; const scripts: string[] = []; const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (/^(?:-n|--quiet|--silent)$/.test(args[i]!)) quiet = true;
    else if (args[i] === '-e' && i + 1 < args.length) scripts.push(args[++i]!);
    else if (args[i]!.startsWith('-')) return false;
    else files.push(args[i]!);
  }
  if (!scripts.length && files.length) scripts.push(files.shift()!);
  return quiet && scripts.length > 0 && scripts.every(s => s.split(/[;\n]/).every(c => /^\s*(?:\d+|\$)(?:,(?:\d+|\$))?p\s*$/.test(c)));
};
const readOnlyArgv = ([command, ...args]: string[]): boolean => {
  if (READ_ONLY.has(command ?? '')) return true;
  // A lone version flag on a program found by name, as in `node --version`.
  if (command && !command.includes('/') && args.length === 1 && /^(?:--version|-v|-V)$/.test(args[0]!)) return true;
  if (command === 'rg') return !args.some(a => /^--pre(?:=|$)/.test(a));
  if (command === 'find') return !args.some(a => /^-(?:delete|exec|execdir|ok|okdir|fls|fprint|fprint0|fprintf)$/.test(a));
  if (command === 'gh') return /^(?:issue|pr)$/.test(args[0] ?? '') && /^(?:view|list|status|diff|checks)$/.test(args[1] ?? '');
  if (command === 'sed') return printOnlySed(args);
  if (command === 'command') return /^-[vV]$/.test(args[0] ?? '') && args.length > 1;
  if (command === 'file') return !args.some(a => a === '--compile' || /^-[^-]*C/.test(a));
  // An output file (`-o`), a temporary directory (`-T`) or a compressor program; a second uniq operand is its output file.
  if (command === 'sort') return !args.some(a => /^--(?:output|temporary-directory|compress-program)(?:=|$)|^-[^-]*[oT]/.test(a));
  if (command === 'uniq') return args.filter(a => !a.startsWith('-')).length <= 1;
  if (command === 'printf') return args[0] !== '-v';
  if (command === 'date') return args.every(a => /^(?:\+.*|-u|--utc|-R|-I\w*|--iso-8601(?:=\w+)?|--rfc-3339=\w+)$/.test(a));
  if (command !== 'git') return false;
  let i = 0;
  for (; ; i++) { if (args[i] === '-C') i++; else if (args[i] !== '--no-pager' && args[i] !== '-P') break; }
  const [sub, ...rest] = args.slice(i);
  if (args.some(a => a.startsWith('--output'))) return false;
  if (/^(?:status|diff|log|show|rev-parse|ls-files|blame|cat-file|merge-base|describe)$/.test(sub ?? '')) return true;
  if (sub === 'branch') return rest.length === 1 && rest[0] === '--show-current';
  if (sub === 'remote') return rest.length === 1 && /^(?:-v|--verbose)$/.test(rest[0]!) || rest[0] === 'get-url';
  // Git refuses a second action, so a read action rules out every write.
  return sub === 'config' && /^(?:--get|--get-all|--get-regexp|--list|-l|get|list)$/.test(rest[0] ?? '');
};

/** Every pipeline stage is listed, nothing expands, and output goes only to the terminal, /dev/null or another descriptor. */
export const readOnlyCommand = (command: string): boolean => {
  const segments = parse(command);
  return !!segments?.length && segments.every(s => !s.dynamic && s.next !== '&' && s.words.length > 0 && !s.words.some(w => w.dynamic)
    && s.redirects.every(({ op, target: t }) => !t.dynamic && (op === '<' || op === '>&' && /^\d+$/.test(t.text) || /^(?:>|>>|&>)$/.test(op) && t.text === '/dev/null'))
    && readOnlyArgv(s.words.map(w => w.text)));
};

const at = (base: string, path: string): string => isAbsolute(path) ? path : `${base}/${path}`;

/**
 * A command is confined to its directory and the paths it names: an absolute leading `cd` chain (or a reported workdir) fixes the
 * directory, and every path-like piece of every word is resolved against it. Expansion, subshells, a later directory change or an
 * unknown directory make it unconfined (`/`, which overlaps every scope).
 * ponytail: a program can still write paths it computes rather than names (scripts, caches); a sandbox would be the upgrade.
 */
const shellTargets = (base: string | null, command: unknown): string[] => {
  const segments = typeof command === 'string' ? parse(command) : null;
  if (!segments) return ['/'];
  let i = 0;
  for (; i < segments.length; i++) {
    const { words: [cd, dir, ...extra], redirects, next, dynamic } = segments[i]!;
    if (cd?.text !== 'cd' || !dir || extra.length || redirects.length || dynamic || next !== '&&' || dir.dynamic || /^[-~]/.test(dir.text)) break;
    if (!base && !isAbsolute(dir.text)) return ['/'];
    base = at(base ?? '/', dir.text);
  }
  const words = segments.slice(i).flatMap(s => s.dynamic ? [null] : [...s.words, ...s.redirects.map(r => r.target)]);
  if (!base || words.some(w => !w || w.dynamic || /[$`]/.test(w.text))) return ['/'];
  const pieces = words.flatMap(w => w!.text.split(/[^\p{L}\p{N}_.~@+%/-]+/u)).map(p => p.replace(/^-+\w*?(?=\/|\.\.)/, ''));
  if (pieces.some(p => p.startsWith('~') || /^(?:cd|pushd|popd)$/.test(p))) return ['/'];
  return [base, ...pieces.filter(Boolean).map(p => at(base!, p))];
};

/** Raw absolute paths a native tool call may write; null when it writes nothing. Relative paths resolve against the call's directory. */
export const writeTargets = (cwd: string, tool: string, input: Obj): string[] | null => {
  const workdir = typeof input['workdir'] === 'string' ? at(cwd, input['workdir']) : null;
  const strings = (...values: unknown[]): string[] => values.filter((v): v is string => typeof v === 'string');
  if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    const files = strings(input['file_path'], input['path'], input['notebook_path']);
    return files.length ? files.map(f => at(cwd, f)) : [cwd];
  }
  if (tool === 'apply_patch') {
    const [patch] = strings(input['command'], input['input'], input['patch']);
    const files = [...(patch ?? '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(m => m[1]!.trim());
    return files.length ? files.map(f => at(workdir ?? cwd, f)) : [workdir ?? cwd];
  }
  if (tool === 'Bash' || tool === 'exec_command') {
    const command = input['command'] ?? input['cmd'];
    if (typeof command === 'string' && readOnlyCommand(command)) return null;
    // Codex reports exec_command to hooks as Bash without its workdir. The session cwd stands in for it, as before #234, so
    // a session outside every scope keeps its shell; a leading `cd` or a named path still decides where it writes.
    return shellTargets(workdir ?? cwd, command);
  }
  if (tool === 'write_stdin') return input['chars'] === '' ? null : [workdir ?? cwd];
  return tool === 'Agent' ? [workdir ?? cwd] : null;
};

/** The kernel resolves `..` after a symlink from the link target (native realpath; the JS one cleans `..` first); the lexical form is checked beside it. */
const physical = (path: string): string => {
  const parts = path.split('/');
  for (let n = parts.length; n > 1; n--) {
    try { return resolve(realpathSync.native(parts.slice(0, n).join('/')), ...parts.slice(n)); } catch { /* Missing: try its parent. */ }
  }
  return resolve(path);
};

export const writesInto = (targets: readonly string[], scopes: readonly string[]): boolean =>
  targets.some(t => [t, physical(t)].some(form => scopes.some(s => overlaps(s, form))));
