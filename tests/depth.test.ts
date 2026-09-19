import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { DEPTH_MAX_BYTES, DEPTH_MAX_MS, readSessionDepth } from '../src/depth.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-depth-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const write = (lines: string[], trailingNewline = true): string => {
  const p = join(tmp, `t-${(seq += 1)}.jsonl`);
  writeFileSync(p, lines.join('\n') + (trailingNewline ? '\n' : ''));
  return p;
};

const usageLine = (over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { cache_read_input_tokens: 400_000, cache_creation_input_tokens: 5_000, input_tokens: 12, ...usage } }, ...over });

const userLine = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

describe('readSessionDepth', () => {
  it('sums the three input terms of the last usage line, the way the 61-prompt replay did', () => {
    const p = write([userLine('first'), usageLine({}, { cache_read_input_tokens: 1, cache_creation_input_tokens: 2, input_tokens: 3 }), userLine('second'), usageLine()]);
    expect(readSessionDepth(p)).toMatchObject({ ok: true, tokens: 405_012 });
  });

  it('reads the last one, not the largest or the first', () => {
    const p = write([usageLine({}, { cache_read_input_tokens: 900_000, cache_creation_input_tokens: 0, input_tokens: 0 }), usageLine({}, { cache_read_input_tokens: 10, cache_creation_input_tokens: 0, input_tokens: 0 })]);
    expect(readSessionDepth(p)).toMatchObject({ ok: true, tokens: 10 });
  });

  it('skips sidechain turns: a subagent carries its own context, not this session’s', () => {
    const p = write([usageLine({}, { cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0, input_tokens: 0 }), usageLine({ isSidechain: true }, { cache_read_input_tokens: 9_000_000, cache_creation_input_tokens: 0, input_tokens: 0 })]);
    expect(readSessionDepth(p)).toMatchObject({ ok: true, tokens: 300_000 });
  });

  it('ignores a truncated final line rather than failing on it', () => {
    const p = write([usageLine({}, { cache_read_input_tokens: 7, cache_creation_input_tokens: 0, input_tokens: 0 }), '{"type":"assistant","message":{"usage":{"cache_read'], false);
    expect(readSessionDepth(p)).toMatchObject({ ok: true, tokens: 7 });
  });

  it('finds usage that sits further back than one read chunk, across chunk and multi-byte boundaries', () => {
    // 2 MB of padding, in Korean, so the chunk boundaries fall inside multi-byte characters as well as inside lines.
    const filler = userLine('긴 한글 패딩 '.repeat(4_000));
    const lines = [usageLine({}, { cache_read_input_tokens: 123_456, cache_creation_input_tokens: 0, input_tokens: 0 })];
    for (let i = 0; i < 20; i += 1) lines.push(filler);
    const p = write(lines);
    const r = readSessionDepth(p);
    expect(r).toMatchObject({ ok: true, tokens: 123_456 });
    expect(r.ok && r.bytesRead).toBeGreaterThan(1_000_000);
  });

  it('is unknown for a missing path, an empty path and a file with no usage at all', () => {
    expect(readSessionDepth(join(tmp, 'nope.jsonl'))).toMatchObject({ ok: false, reason: 'depth_unknown' });
    expect(readSessionDepth('')).toMatchObject({ ok: false, reason: 'depth_unknown', bytesRead: 0 });
    expect(readSessionDepth(null)).toMatchObject({ ok: false, reason: 'depth_unknown' });
    expect(readSessionDepth(write([userLine('a'), userLine('b')]))).toMatchObject({ ok: false, reason: 'depth_unknown' });
  });

  it('is unknown, not wrong, when the usage sits beyond the byte cap', () => {
    const p = write([usageLine(), 'x'.repeat(DEPTH_MAX_BYTES + 1024)]);
    const r = readSessionDepth(p);
    expect(r).toMatchObject({ ok: false, reason: 'depth_unknown' });
    expect(r.bytesRead).toBeLessThanOrEqual(DEPTH_MAX_BYTES);
  });

  it('stops at the time cap even when the bytes would have been affordable', () => {
    const p = write([usageLine(), ...Array.from({ length: 40 }, () => userLine('pad '.repeat(20_000)))]);
    let clock = 0;
    // Each call advances the clock, so the cap is reached partway through rather than by real elapsed time.
    expect(readSessionDepth(p, () => (clock += DEPTH_MAX_MS / 3))).toMatchObject({ ok: false, reason: 'depth_unknown' });
  });

  it('reports only numbers: no line of the transcript can leave through this reading', () => {
    const p = write([usageLine(), userLine('a secret the hook must never carry anywhere')]);
    const r = readSessionDepth(p);
    for (const v of Object.values(r)) expect(['number', 'boolean', 'string']).toContain(typeof v);
    expect(JSON.stringify(r)).not.toMatch(/secret/);
    expect(Object.keys(r).sort()).toEqual(['bytesRead', 'durationMs', 'ok', 'tokens']);
  });

  it('ignores a usage object with no readable term, and a usage that is not an object', () => {
    expect(readSessionDepth(write([usageLine(), JSON.stringify({ type: 'assistant', message: { usage: { output_tokens: 900 } } })]))).toMatchObject({ ok: true, tokens: 405_012 });
    expect(readSessionDepth(write([usageLine(), JSON.stringify({ type: 'assistant', message: { usage: 'high' } })]))).toMatchObject({ ok: true, tokens: 405_012 });
    expect(readSessionDepth(write([JSON.stringify({ usage: { input_tokens: 5 } })]))).toMatchObject({ ok: false, reason: 'depth_unknown' });
  });
});
