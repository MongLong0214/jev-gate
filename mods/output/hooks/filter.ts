/** The host's own persisted-output size (bytes, from its metadata) above which the log is left alone, unread. */
export const MAX_BYTES = 1024 * 1024;
/** The fold replaces what the model would have read only when it is at least this many UTF-8 bytes smaller. */
export const MIN_SAVING = 512;
/** A run shorter than this stays as it is: one line and a count line save nothing on two. */
const MIN_RUN = 3;

export const MARK = '[jev-gate output]';

/** One formatter: `vitest run` called directly, with plain arguments. A wrapper (`npm test`), a pipe, a redirect or a compound command is not a known log. */
const VITEST_COMMAND = /^(?:npx |pnpm (?:exec )?|yarn |bunx )?vitest run(?: [\w@./=:,+-]+)*$/;

export const isVitestCommand = (command: string): boolean => VITEST_COMMAND.test(command);

/** The first line of a Vitest log, and its closing summary with nothing failed, in the order Vitest prints them. */
const RUN_LINE = /^ RUN {2}v\d+\.\d+\.\d+ \S/;
const SUMMARY = [
  /^ Test Files {2}\d+ passed(?: \| \d+ skipped)? \(\d+\)$/,
  /^ {6}Tests {2}\d+ passed(?: \| \d+ (?:skipped|todo))* \(\d+\)$/,
  /^ {3}Start at {2}\d{2}:\d{2}:\d{2}$/,
  /^ {3}Duration {2}\S.*$/,
];

/**
 * A line that makes the log something other than a plain passing run: a terminal redraw or colour, a failure or
 * error section, a code frame, a diff, JSON or source code among the output, or this module's own marker.
 */
const NOT_PLAIN = [
  /[\x1b\r]/,
  /⎯/,
  /^ (?:FAIL|×|❯) /,
  /FAIL|failed|Error|Unhandled/,
  /^\s*\d+\s*\|/,
  /^(?:diff --git |@@ |\+\+\+ |--- )/,
  /^\s*[{[]/,
  /^\s*(?:import|export|const|let|var|function|class|return)\s/,
  /[;{}]\s*$/,
];

export type FoldResult = { ok: true; text: string; runs: number } | { ok: false; reason: 'format' | 'nothing_folded' };

/**
 * A complete passing Vitest log with every run of three or more byte-identical consecutive non-blank lines shown once,
 * followed by a line with its exact count. Nothing else changes: every other line, unique or not, stays where it was.
 */
export const foldVitest = (log: string): FoldResult => {
  const lines = log.replace(/\n+$/, '').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0 || !RUN_LINE.test(lines[first]!)) return { ok: false, reason: 'format' };
  const tail = lines.filter((l) => l.trim() !== '').slice(-SUMMARY.length);
  if (tail.length < SUMMARY.length || !SUMMARY.every((re, i) => re.test(tail[i]!))) return { ok: false, reason: 'format' };
  if (lines.some((l) => l.includes(MARK) || NOT_PLAIN.some((re) => re.test(l)))) return { ok: false, reason: 'format' };

  const out: string[] = [];
  let runs = 0;
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const line = lines[i]!;
    if (j - i >= MIN_RUN && line.trim() !== '') {
      out.push(line, `${MARK} the line above, ${j - i} times in a row`);
      runs++;
    } else {
      for (let k = i; k < j; k++) out.push(line);
    }
    i = j;
  }
  return runs === 0 ? { ok: false, reason: 'nothing_folded' } : { ok: true, text: out.join('\n'), runs };
};

/** The folded log as the model reads it: what was done, and where the host keeps the original. */
export const withNote = (folded: string, path: string, size: number): string =>
  `${MARK} Only runs of identical consecutive lines were folded, each kept once with its count; no other line was removed. The full original (${size} bytes) is at ${path}\n\n${folded}`;

/** UTF-8 bytes of a string, as the model's text is sent; a lone surrogate counts as the three bytes of U+FFFD. */
export const utf8Bytes = (s: string): number => {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
};
