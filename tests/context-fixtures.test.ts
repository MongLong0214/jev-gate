import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONTENT_KEY, MAX_CONTENT_CHARS, NUM_LINES_KEY, parseGrepResponse, renderGrepResponse, TOTAL_LINES_KEY } from '../src/context/blocks.js';

/**
 * The adapter against the host payloads themselves, not against a hand-written idea of them. These four files are real
 * `PostToolUse` payloads recorded from Claude Code 2.1.276 (probe of 2026-09-18); the guessed shape this adapter was
 * written to accepted `grep-truncated.json` and would have rewritten a result the host had already cut.
 */
const PROBE_DIR = join(process.cwd(), 'bench/results/v5-context-probe-2026-09-18');

interface Fixture {
  tool_input: Record<string, unknown>;
  tool_response: Record<string, unknown>;
}

const fixture = (name: string): Fixture => JSON.parse(readFileSync(join(PROBE_DIR, `${name}.json`), 'utf8')) as Fixture;

/**
 * The cap constant is answerable to the run that measured it, not to a number someone remembered. This reads the
 * recorded cells and derives the boundary from them, so editing MAX_CONTENT_CHARS without a new measurement fails here.
 */
describe('the bisected model-facing cap', () => {
  interface Cell {
    cell: string;
    hook_content_chars: number;
    hook_content_bytes: number;
    model_facing_bytes: number;
    delivered_whole: boolean;
  }
  const cells = JSON.parse(readFileSync(join(process.cwd(), 'bench/results/v5-context-cap-2026-09-18/measurements.json'), 'utf8')) as Cell[];

  it('separates cleanly at MAX_CONTENT_CHARS, with no cell on the wrong side', () => {
    expect(cells.length).toBeGreaterThan(30);
    const whole = cells.filter((c) => c.delivered_whole);
    const capped = cells.filter((c) => !c.delivered_whole);
    expect(whole.length).toBeGreaterThan(0);
    expect(capped.length).toBeGreaterThan(0);
    expect(Math.max(...whole.map((c) => c.hook_content_chars))).toBe(MAX_CONTENT_CHARS);
    expect(Math.min(...capped.map((c) => c.hook_content_chars))).toBe(MAX_CONTENT_CHARS + 1);
  });

  it('shows the cap counting characters: Korean cells far over the ceiling in bytes were delivered whole', () => {
    const korean = cells.filter((c) => c.cell.startsWith('KOMARK') && c.delivered_whole);
    expect(korean.length).toBeGreaterThan(0);
    for (const c of korean) {
      expect(c.hook_content_chars).toBeLessThanOrEqual(MAX_CONTENT_CHARS);
      // Well past two bytes per character, so a byte-denominated ceiling would have excluded every one of these.
      expect(c.hook_content_bytes).toBeGreaterThan(c.hook_content_chars * 2);
      expect(c.model_facing_bytes).toBe(c.hook_content_bytes);
    }
  });

  it('shows every capped cell reaching the model far smaller than the hook saw', () => {
    for (const c of cells.filter((x) => !x.delivered_whole)) {
      expect(c.model_facing_bytes).toBeLessThan(c.hook_content_bytes);
      expect(c.model_facing_bytes).toBeLessThan(6 * 1024);
    }
  });
});

describe('recorded host fixtures', () => {
  it('reads all four back as the three documented shapes', () => {
    const shape = (name: string): unknown => {
      const { tool_response: r } = fixture(name);
      return { mode: r['mode'], keys: Object.keys(r).filter((k) => k !== '_source' && k !== 'model_facing_render').sort() };
    };
    expect(shape('grep-content')).toEqual({ mode: 'content', keys: ['content', 'filenames', 'mode', 'numFiles', 'numLines', 'totalLines'] });
    expect(shape('grep-truncated')).toEqual({ mode: 'content', keys: ['appliedLimit', 'content', 'filenames', 'mode', 'numFiles', 'numLines', 'totalLines'] });
    expect(shape('grep-count')).toEqual({ mode: 'count', keys: ['content', 'filenames', 'mode', 'numFiles', 'numMatches'] });
    expect(shape('grep-files')).toEqual({ mode: 'files_with_matches', keys: ['filenames', 'mode', 'numFiles', 'totalFiles'] });
  });

  it('holds the invariant the parser relies on: numLines is the raw line count, with no trailing newline', () => {
    for (const name of ['grep-content', 'grep-truncated']) {
      const content = fixture(name).tool_response[CONTENT_KEY] as string;
      expect(content.endsWith('\n')).toBe(false);
      expect(fixture(name).tool_response[NUM_LINES_KEY]).toBe(content.split('\n').length);
    }
  });

  it('confirms content mode says nothing through numFiles or filenames', () => {
    for (const name of ['grep-content', 'grep-truncated']) {
      expect(fixture(name).tool_response['numFiles']).toBe(0);
      expect(fixture(name).tool_response['filenames']).toEqual([]);
    }
  });

  /** The regression this fix exists for: `appliedLimit` and `totalLines > numLines`, on neither of the old guessed keys. */
  it('rejects the natively truncated result the earlier guessed shape let through', () => {
    const { tool_input, tool_response } = fixture('grep-truncated');
    expect(tool_input['head_limit']).toBeUndefined();
    expect(tool_response['truncated']).toBeUndefined();
    expect(tool_response['hasMore']).toBeUndefined();
    expect(tool_response['appliedLimit']).toBe(250);
    expect(tool_response[TOTAL_LINES_KEY]).toBeGreaterThan(tool_response[NUM_LINES_KEY] as number);
    expect(parseGrepResponse(tool_input, tool_response)).toEqual({ ok: false, reason: 'context_response_truncated' });
  });

  it('passes a count result and a files-only result through untouched', () => {
    for (const name of ['grep-count', 'grep-files']) {
      const { tool_input, tool_response } = fixture(name);
      expect(parseGrepResponse(tool_input, tool_response).ok).toBe(false);
    }
  });

  it('passes a content result below the floor through, so no provider call is made for it', () => {
    const { tool_input, tool_response } = fixture('grep-content');
    expect(parseGrepResponse(tool_input, tool_response)).toEqual({ ok: false, reason: 'context_response_short' });
  });

  /**
   * The same fixture with the host's own truncation marks cleared. It is still refused, and the second reason is worth
   * stating: at 28,891 characters this result is above the cap too, so even untruncated the model would only ever have
   * seen a preview of it. Both of the probe's ceilings bind on the one payload it recorded.
   */
  it('still refuses that result once it is no longer truncated, because it is over the cap', () => {
    const { tool_input, tool_response } = fixture('grep-truncated');
    const untruncated = { ...tool_response };
    delete untruncated['appliedLimit'];
    delete untruncated['_source'];
    delete untruncated['model_facing_render'];
    untruncated[TOTAL_LINES_KEY] = untruncated[NUM_LINES_KEY];
    expect((untruncated[CONTENT_KEY] as string).length).toBeGreaterThan(MAX_CONTENT_CHARS);
    expect(parseGrepResponse(tool_input, untruncated)).toEqual({ ok: false, reason: 'context_response_capped' });
  });

  /** Trimmed under both ceilings: still the host's own line format and bytes, now in the window a filter can work in. */
  it('parses that same text once it is inside the window, and carries both counts into meta', () => {
    const { tool_input, tool_response } = fixture('grep-truncated');
    const lines = (tool_response[CONTENT_KEY] as string).split('\n').slice(0, 120);
    const eligible: Record<string, unknown> = {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      [CONTENT_KEY]: lines.join('\n'),
      [NUM_LINES_KEY]: lines.length,
      [TOTAL_LINES_KEY]: lines.length,
    };

    const parsed = parseGrepResponse(tool_input, eligible);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta.numLines).toBe(120);
    expect(parsed.meta.totalLines).toBe(120);
    expect(parsed.meta.contentBytes).toBe(Buffer.byteLength(lines.join('\n'), 'utf8'));

    // Rendering every block back reproduces the host's own counts rather than dropping the key it sent.
    const replacement = renderGrepResponse(parsed.meta, parsed.blocks);
    expect(replacement[NUM_LINES_KEY]).toBe(120);
    expect(replacement[TOTAL_LINES_KEY]).toBe(120);
    expect(replacement[CONTENT_KEY]).toBe(lines.join('\n'));
  });
});
