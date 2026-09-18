import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONTENT_KEY, NUM_LINES_KEY, parseGrepResponse, renderGrepResponse, TOTAL_LINES_KEY } from '../src/context/blocks.js';

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

  /** The same fixture with the host's own truncation marks cleared: real host text, real size, nothing else changed. */
  it('parses that result once it is no longer truncated, and carries both counts into meta', () => {
    const { tool_input, tool_response } = fixture('grep-truncated');
    const eligible = { ...tool_response };
    delete eligible['appliedLimit'];
    delete eligible['_source'];
    delete eligible['model_facing_render'];
    eligible[TOTAL_LINES_KEY] = eligible[NUM_LINES_KEY];

    const parsed = parseGrepResponse(tool_input, eligible);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.meta.numLines).toBe(250);
    expect(parsed.meta.totalLines).toBe(250);
    expect(parsed.meta.contentBytes).toBe(Buffer.byteLength(eligible[CONTENT_KEY] as string, 'utf8'));

    // Rendering every block back reproduces the host's own counts rather than dropping the key it sent.
    const replacement = renderGrepResponse(parsed.meta, parsed.blocks);
    expect(replacement[NUM_LINES_KEY]).toBe(250);
    expect(replacement[TOTAL_LINES_KEY]).toBe(250);
    expect(replacement[CONTENT_KEY]).toBe(eligible[CONTENT_KEY]);
  });
});
