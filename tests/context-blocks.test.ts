import { describe, expect, it } from 'vitest';

import {
  CONTENT_KEY,
  contentBytesOf,
  isProtectedPath,
  MAX_CONTENT_CHARS,
  MIN_CONTENT_BYTES,
  parseGrepResponse,
  renderGrepResponse,
  sanitizeGrepInput,
  type GrepMeta,
} from '../src/context/blocks.js';
import { buildContextOutput, NOTICE_HEADER, renderDisclosure } from '../src/context/render.js';

const countLines = (content: string): number => {
  const lines = content.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
};

const pad = (n: number): string => 'x'.repeat(n);

/** A contiguous run of match lines for one file, which the parser has to read back as exactly one block. */
const run = (path: string, start: number, count: number, body = 'value'): string =>
  Array.from({ length: count }, (_, i) => `${path}:${start + i}:${body} ${i} ${pad(80)}`).join('\n');

/**
 * Content of exactly `chars` characters, as contiguous numbered lines of one file — the same shape the cap probe's
 * generator produced, so a boundary asserted here is the boundary that was measured.
 */
const padTo = (chars: number, path: string, fill = 'x'): string => {
  const lines: string[] = [];
  let total = 0;
  for (;;) {
    const index = lines.length + 1;
    const prefix = `${path}:${index}:`;
    const separator = index === 1 ? 0 : 1;
    const room = chars - total - separator - prefix.length;
    if (room <= 0) throw new Error(`cannot reach ${String(chars)} characters exactly for ${path}`);
    // Take a bounded slice, unless what is left could not form another line — then take all of it and land exactly.
    const width = room <= 200 + `${path}:${String(index + 1)}:`.length + 2 ? room : 200;
    lines.push(prefix + fill.repeat(width));
    total += separator + prefix.length + width;
    if (total === chars) break;
  }
  return lines.join('\n');
};

const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ pattern: 'value', output_mode: 'content', '-n': true, ...over });

/** The confirmed content-mode shape, key for key: `bench/results/v5-context-probe-2026-09-18/grep-content.json`. */
const response = (content: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 'content',
  numFiles: 0,
  filenames: [],
  [CONTENT_KEY]: content,
  numLines: countLines(content),
  totalLines: countLines(content),
  ...over,
});

/** Over MIN_CONTENT_BYTES so eligibility is never the reason a case fails. */
const bulk = (path = 'src/bulk.ts'): string => run(path, 1, 120);

describe('parseGrepResponse', () => {
  it('builds one block per contiguous run and keeps order, paths with colons and Korean text byte-identical', () => {
    const korean = `src/ko.ts:12:const 메시지 = '한국어 텍스트입니다'; ${pad(80)}`;
    const colonPath = `src/we:ird.ts:30:const a = { k: 1 }; ${pad(80)}`;
    const content = [bulk(), korean, colonPath].join('\n');
    const parsed = parseGrepResponse(input(), response(content));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blocks.map((b) => b.sourcePath)).toEqual(['src/bulk.ts', 'src/ko.ts', 'src/we:ird.ts']);
    expect(parsed.blocks[0]).toMatchObject({ startLine: 1, endLine: 120, protected: false, id: 'b0' });
    expect(parsed.blocks[1]?.text).toBe(korean);
    expect(parsed.blocks[2]).toMatchObject({ sourcePath: 'src/we:ird.ts', startLine: 30, endLine: 30 });
    // The lazy split only accepts a colon followed by digits and a colon, so the colon inside the path survives.
    expect(parsed.blocks[2]?.text).toBe(colonPath);
    expect(parsed.meta.contentBytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('uses the response file list to split exactly, including a path that itself contains a line-number-shaped run', () => {
    const tricky = 'src/a:12:b.ts';
    const content = [bulk(), `${tricky}:30:hit ${pad(80)}`].join('\n');
    const withList = parseGrepResponse(input(), response(content, { filenames: ['src/bulk.ts', tricky], numFiles: 2 }));
    expect(withList.ok).toBe(true);
    if (withList.ok) expect(withList.blocks.map((b) => b.sourcePath)).toEqual(['src/bulk.ts', tricky]);
    // Documented residual (§6): with no file list to disambiguate, that one path shape splits at its first run instead.
    const noList = parseGrepResponse(input(), response(content));
    expect(noList.ok).toBe(true);
    if (noList.ok) expect(noList.blocks.map((b) => b.sourcePath)).toEqual(['src/bulk.ts', 'src/a']);
  });

  it('rejects a line whose path is not in the list the response supplied', () => {
    const content = [bulk(), `src/other.ts:3:hit ${pad(80)}`].join('\n');
    expect(parseGrepResponse(input(), response(content, { filenames: ['src/bulk.ts'], numFiles: 1 }))).toEqual({ ok: false, reason: 'context_response_unparsed' });
  });

  it('keeps CRLF line endings inside the block text', () => {
    const content = `${run('src/crlf.ts', 1, 120).split('\n').join('\r\n')}\r\n`;
    const parsed = parseGrepResponse(input(), response(content));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]?.text.includes('\r\n')).toBe(true);
    // Only the final newline is consumed; the CR before it is part of the original bytes and stays in the block.
    expect(parsed.blocks[0]?.text).toBe(content.slice(0, -1));
  });

  it('groups by the host hunk separator when it is present and keeps context lines with their match', () => {
    const hunk = ['src/ctx.ts-9-before', 'src/ctx.ts:10:hit', 'src/ctx.ts-11-after'].join('\n');
    const content = [bulk(), '--', hunk].join('\n');
    const parsed = parseGrepResponse(input({ '-C': 1 }), response(content));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks[1]).toMatchObject({ sourcePath: 'src/ctx.ts', startLine: 9, endLine: 11 });
    expect(parsed.blocks[1]?.text).toBe(hunk);
  });

  it('splits a context line on its dash even when the matched text contains a colon run', () => {
    const content = [bulk(), '--', 'src/ctx.ts-40-  const m = { k:12:v };'].join('\n');
    const parsed = parseGrepResponse(input({ '-C': 1 }), response(content));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.blocks[1]).toMatchObject({ sourcePath: 'src/ctx.ts', startLine: 40 });
  });

  it('drops only byte-identical occurrences of the same path and range, never a same-text hit elsewhere', () => {
    const hit = (path: string, line: number): string => `${path}:${line}:const same = 1;`;
    const content = [bulk(), '--', hit('src/dup.ts', 7), '--', hit('src/dup.ts', 7), '--', hit('src/dup.ts', 90), '--', hit('src/other.ts', 7)].join('\n');
    const parsed = parseGrepResponse(input(), response(content));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blocks.map((b) => `${b.sourcePath}:${String(b.startLine)}`)).toEqual(['src/bulk.ts:1', 'src/dup.ts:7', 'src/dup.ts:90', 'src/other.ts:7']);
  });

  it('marks instruction files protected and refuses a result made only of them', () => {
    const content = [bulk(), `CLAUDE.md:3:always ${pad(80)}`, `docs/AGENTS.md:4:always ${pad(80)}`, `.claude/skills/x.md:5:always ${pad(80)}`].join('\n');
    const parsed = parseGrepResponse(input(), response(content));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blocks.map((b) => b.protected)).toEqual([false, true, true, true]);
    expect(['CLAUDE.md', 'AGENTS.md', 'a/CLAUDE.local.md', '.claude/agents/w.md', '.cursorrules'].every(isProtectedPath)).toBe(true);
    expect(isProtectedPath('src/claude.ts')).toBe(false);
    const onlyProtected = parseGrepResponse(input(), response(run('CLAUDE.md', 1, 120)));
    expect(onlyProtected).toEqual({ ok: false, reason: 'context_no_candidates' });
  });

  it.each([
    ['a short result', input(), response(run('src/s.ts', 1, 2))],
    ['a count result', input({ output_mode: 'count' }), { mode: 'count', content: bulk(), numLines: countLines(bulk()) }],
    ['a files-only result', input({ output_mode: 'files_with_matches' }), { mode: 'files_with_matches', filenames: ['src/a.ts'], numFiles: 1 }],
    ['a bare string response', input(), 'src/a.ts:1:hit'],
    ['a head-limited result', input({ head_limit: 10 }), response(bulk())],
    ['a paginated result', input({ offset: 20 }), response(bulk())],
    ['a natively truncated result', input(), response(`${bulk()}\n(Results are truncated. Consider a more specific path or pattern.)`)],
    ['a flagged truncated result', input(), response(bulk(), { truncated: true })],
    // What Claude Code actually sends. The first two are the recorded markers; the third is the count they arrive with.
    ['a head-limited result marked on the response', input(), response(bulk(), { appliedLimit: 250 })],
    ['a paginated result marked on the response', input(), response(bulk(), { appliedOffset: 20 })],
    ['a result whose total exceeds the lines delivered', input(), response(bulk(), { totalLines: countLines(bulk()) + 1 })],
    ['a total below the lines delivered, whose meaning is unknown', input(), response(bulk(), { totalLines: 3 })],
    ['a non-integer total', input(), response(bulk(), { totalLines: 'many' })],
    ['an errored result', input(), response(bulk(), { error: 'no such path' })],
    ['an interrupted result', input(), response(bulk(), { interrupted: true })],
    ['a failed status', input(), response(bulk(), { status: 'error' })],
    ['a line count that does not match', input(), response(bulk(), { numLines: 3 })],
    ['a file count that does not match its list', input(), response(bulk(), { filenames: ['src/bulk.ts'], numFiles: 4 })],
    ['a result with no line numbers and no file list', input({ '-n': false }), response(Array.from({ length: 120 }, () => `src/a.ts:hit ${pad(80)}`).join('\n'))],
  ])('passes %s through with no parsed blocks, so no provider call can be built', (_name, toolInput, toolResponse) => {
    const parsed = parseGrepResponse(toolInput, toolResponse);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(typeof parsed.reason).toBe('string');
  });

  /**
   * The reason code matters on its own here: `totalLines > numLines` is the host saying it cut the result, and it is the
   * only signal when `appliedLimit` is absent. Rejecting it as merely inconsistent would lose that, and asserting only
   * `ok: false` cannot tell the two apart — the confirmed truncated fixture carries `appliedLimit`, caught earlier.
   */
  it('reads a total above the delivered lines as truncation, not as an inconsistent count', () => {
    const content = bulk();
    const lines = countLines(content);
    expect(parseGrepResponse(input(), response(content, { totalLines: lines + 1 }))).toEqual({ ok: false, reason: 'context_response_truncated' });
    expect(parseGrepResponse(input(), response(content, { totalLines: lines - 1 }))).toEqual({ ok: false, reason: 'context_meta_inconsistent' });
    expect(parseGrepResponse(input(), response(content, { totalLines: lines })).ok).toBe(true);
  });

  /**
   * The two thresholds are denominated differently on purpose, and the Korean case is the one that proves it: the host
   * delivered 19,974 characters / 51,894 bytes whole in the same run that capped 20,001 ASCII bytes
   * (`bench/results/v5-context-cap-2026-09-18`). A byte-denominated ceiling would switch the filter off on non-ASCII
   * source while it was still well inside what the host would have delivered.
   */
  it('measures the host ceiling in characters, at the boundary that was bisected', () => {
    const atCap = padTo(MAX_CONTENT_CHARS, 'src/cap.ts');
    expect(atCap.length).toBe(MAX_CONTENT_CHARS);
    expect(parseGrepResponse(input(), response(atCap)).ok).toBe(true);

    const overCap = padTo(MAX_CONTENT_CHARS + 1, 'src/cap.ts');
    expect(overCap.length).toBe(MAX_CONTENT_CHARS + 1);
    expect(parseGrepResponse(input(), response(overCap))).toEqual({ ok: false, reason: 'context_response_capped' });

    // Three bytes per character, so this is far over the byte ceiling a careless reading would have imposed, and the
    // host delivers it whole. It has to stay eligible.
    const korean = padTo(MAX_CONTENT_CHARS, 'src/ko.ts', '한');
    expect(korean.length).toBe(MAX_CONTENT_CHARS);
    expect(Buffer.byteLength(korean, 'utf8')).toBeGreaterThan(MAX_CONTENT_CHARS * 2);
    expect(parseGrepResponse(input(), response(korean)).ok).toBe(true);
  });

  it('checks the eligibility threshold in bytes, not in characters', () => {
    const korean = 'src/ko.ts:1:한'.padEnd(20, '가');
    const many = Array.from({ length: 200 }, (_, i) => `src/ko.ts:${String(i + 1)}:${korean}`).join('\n');
    expect(Buffer.byteLength(many, 'utf8')).toBeGreaterThan(MIN_CONTENT_BYTES);
    expect(many.length).toBeLessThan(MIN_CONTENT_BYTES);
    const parsed = parseGrepResponse(input(), response(many));
    expect(parsed.ok).toBe(true);
  });

  it('forwards only the whitelisted search arguments', () => {
    expect(sanitizeGrepInput(input({ head_limit: 3, secret: 'x' }))).toEqual({ pattern: 'value', output_mode: 'content', '-n': true });
    expect(sanitizeGrepInput('nope')).toEqual({});
  });
});

describe('renderGrepResponse', () => {
  const parsed = parseGrepResponse(input(), response([bulk(), `src/keep.ts:5:hit ${pad(80)}`].join('\n'), { extra: { host: 'field' } }));

  it('keeps every unknown key, rewrites only the counts whose meaning was verified', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const kept = parsed.blocks.slice(1);
    const out = renderGrepResponse(parsed.meta, kept);
    expect(out['extra']).toEqual({ host: 'field' });
    expect(out[CONTENT_KEY]).toBe(kept[0]?.text);
    expect(out['numLines']).toBe(1);
    // Regenerated with numLines: left at the original 121 this replacement would read as natively truncated.
    expect(out['totalLines']).toBe(1);
    // filenames is hard-coded empty in content mode on this host, so it is left exactly as received.
    expect(out['filenames']).toEqual([]);
    expect(out['numFiles']).toBe(0);
  });

  it('rewrites the file list when the response actually carried one', () => {
    const withList = parseGrepResponse(input(), response([bulk(), `src/keep.ts:5:hit ${pad(80)}`].join('\n'), { filenames: ['src/bulk.ts', 'src/keep.ts'], numFiles: 2 }));
    expect(withList.ok).toBe(true);
    if (!withList.ok) return;
    const out = renderGrepResponse(withList.meta, withList.blocks.slice(1));
    expect(out['filenames']).toEqual(['src/keep.ts']);
    expect(out['numFiles']).toBe(1);
  });
});

describe('buildContextOutput', () => {
  const parsed = parseGrepResponse(input(), response([bulk(), `src/keep.ts:5:hit ${pad(80)}`].join('\n')));
  const meta = (parsed.ok ? parsed.meta : null) as GrepMeta;

  it('emits one PostToolUse envelope whose notice states counts and the recovery path only', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const kept = parsed.blocks.slice(1);
    const out = buildContextOutput({ meta, kept, returned: parsed.blocks.length, recoveryPath: '/tmp/state/jev-gate/context-archive/abc.txt' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const envelope = JSON.parse(out.stdout) as { hookSpecificOutput: Record<string, unknown> };
    expect(Object.keys(envelope)).toEqual(['hookSpecificOutput']);
    expect(envelope.hookSpecificOutput['hookEventName']).toBe('PostToolUse');
    expect(typeof envelope.hookSpecificOutput['updatedToolOutput']).toBe('object');
    expect(out.additionalContext).toBe(renderDisclosure(2, 1, '/tmp/state/jev-gate/context-archive/abc.txt'));
    expect(out.additionalContext).toContain(NOTICE_HEADER);
    expect(out.additionalContext).toContain('returned 2 result blocks; 1 are shown');
    expect(out.additionalContext).toContain('/tmp/state/jev-gate/context-archive/abc.txt');
    expect(out.additionalContext).not.toContain('hit');
    expect(out.afterBytes).toBeLessThan(out.beforeBytes);
    expect(out.beforeBytes).toBe(contentBytesOf(parsed.blocks));
  });

  it('refuses a replacement that is not smaller than the original once the notice is counted', () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(buildContextOutput({ meta, kept: parsed.blocks, returned: parsed.blocks.length, recoveryPath: '/tmp/a.txt' })).toEqual({ ok: false, code: 'replacement_not_smaller' });
  });
});
