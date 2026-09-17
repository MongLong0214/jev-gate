import type { PromptBlock } from './types.js';

export const MAX_BLOCKS = 24;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Line {
  start: number;
  end: number;
  text: string;
}

const splitLines = (prompt: string): Line[] => {
  const lines: Line[] = [];
  let start = 0;
  for (let i = 0; i < prompt.length; i++) {
    if (prompt[i] === '\n') {
      lines.push({ start, end: i + 1, text: prompt.slice(start, i + 1) });
      start = i + 1;
    }
  }
  if (start < prompt.length) lines.push({ start, end: prompt.length, text: prompt.slice(start) });
  return lines;
};

const isBlank = (line: Line): boolean => line.text.trim().length === 0;

const fenceClosesAt = (line: Line, fence: string): boolean => {
  const m = FENCE_OPEN_RE.exec(line.text);
  if (!m || !m[1]) return false;
  const marker = m[1];
  return marker[0] === fence[0] && marker.length >= fence.length && line.text.slice(m[0].length).trim().length === 0;
};

/**
 * Splits the prompt into contiguous UTF-16 ranges whose texts concatenate back to the prompt exactly.
 * Each non-blank line is a block, blank lines attach to the preceding block, a code fence is one block.
 * Adjacent blocks merge (smallest pair first) until at most MAX_BLOCKS remain. No text is altered.
 */
export const splitLossless = (prompt: string): PromptBlock[] => {
  const lines = splitLines(prompt);
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const open = FENCE_OPEN_RE.exec(line.text);
    if (open && open[1]) {
      const fence = open[1];
      let j = i + 1;
      while (j < lines.length && !fenceClosesAt(lines[j]!, fence)) j++;
      const last = lines[Math.min(j, lines.length - 1)]!;
      ranges.push({ start: line.start, end: last.end });
      i = Math.min(j, lines.length - 1) + 1;
      continue;
    }
    if (isBlank(line)) {
      const prev = ranges[ranges.length - 1];
      if (prev) prev.end = line.end;
      else ranges.push({ start: line.start, end: line.end });
      i++;
      continue;
    }
    ranges.push({ start: line.start, end: line.end });
    i++;
  }
  // A leading blank-only range merges forward so blocks never start with pure whitespace unless the prompt is all whitespace.
  if (ranges.length > 1 && prompt.slice(ranges[0]!.start, ranges[0]!.end).trim().length === 0) {
    ranges[1]!.start = ranges[0]!.start;
    ranges.shift();
  }
  while (ranges.length > MAX_BLOCKS) {
    let best = 0;
    let bestLen = Number.POSITIVE_INFINITY;
    for (let k = 0; k + 1 < ranges.length; k++) {
      const len = ranges[k + 1]!.end - ranges[k]!.start;
      if (len < bestLen) {
        bestLen = len;
        best = k;
      }
    }
    ranges[best]!.end = ranges[best + 1]!.end;
    ranges.splice(best + 1, 1);
  }
  return ranges.map((r, idx) => ({ id: `u${idx + 1}`, start: r.start, end: r.end, text: prompt.slice(r.start, r.end) }));
};
