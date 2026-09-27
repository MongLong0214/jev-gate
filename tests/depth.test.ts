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
    for (const v of Object.values(r)) expect(v === null || ['number', 'boolean', 'string'].includes(typeof v)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/secret/);
    expect(Object.keys(r).sort()).toEqual(['bytesRead', 'durationMs', 'model', 'modelSwitched', 'ok', 'tokens']);
  });

  /**
   * #48 review: a `/model` switch writes only a display name, and the next reply is the first line with the new ID;
   * until then the previous reply's model would give the next prompt the wrong window in either direction.
   */
  it('reads the model as unknown after a /model command that follows the last usage line', () => {
    const opus = usageLine({ message: { role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 10 } } });
    const command = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>' } });
    const stdout = JSON.stringify({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model to `Haiku 4.5`</local-command-stdout>' } });
    expect(readSessionDepth(write([opus, command, stdout]))).toMatchObject({ ok: true, tokens: 10, model: null, modelSwitched: true });
    // Before the last reply, the reply already carries the model that the switch chose.
    expect(readSessionDepth(write([command, stdout, opus]))).toMatchObject({ model: 'claude-opus-5-5', modelSwitched: false });
    // A subagent does not switch the session's model.
    const sidechain = JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: '<command-name>/model</command-name>' } });
    expect(readSessionDepth(write([opus, sidechain]))).toMatchObject({ model: 'claude-opus-5-5', modelSwitched: false });
    // The command and the usage line in different read chunks: the mark carries across them.
    const filler = userLine('x'.repeat(300 * 1024));
    expect(readSessionDepth(write([opus, filler, command, filler]))).toMatchObject({ ok: true, model: null, modelSwitched: true });
  });

  it('carries the usage line\'s model ID for the host-window default, and nothing that is not shaped like one', () => {
    const withModel = (model: unknown): string => JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: 10, cache_read_input_tokens: 400_000 } } });
    expect(readSessionDepth(write([withModel('claude-opus-5-5')]))).toMatchObject({ ok: true, tokens: 400_010, model: 'claude-opus-5-5' });
    expect(readSessionDepth(write([withModel('claude-opus-4-6[1m]')]))).toMatchObject({ model: 'claude-opus-4-6[1m]' });
    for (const bad of ['a secret, with spaces', '', 42, null, 'x'.repeat(200)]) {
      expect(readSessionDepth(write([withModel(bad)]))).toMatchObject({ ok: true, tokens: 400_010, model: null });
    }
    // A sidechain turn is skipped whole, so its model never stands in for the root's.
    const side = JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1 } } });
    expect(readSessionDepth(write([withModel('claude-opus-5-5'), side]))).toMatchObject({ tokens: 400_010, model: 'claude-opus-5-5' });
  });

  it('ignores a usage object with no readable term, and a usage that is not an object', () => {
    expect(readSessionDepth(write([usageLine(), JSON.stringify({ type: 'assistant', message: { usage: { output_tokens: 900 } } })]))).toMatchObject({ ok: true, tokens: 405_012 });
    expect(readSessionDepth(write([usageLine(), JSON.stringify({ type: 'assistant', message: { usage: 'high' } })]))).toMatchObject({ ok: true, tokens: 405_012 });
    expect(readSessionDepth(write([JSON.stringify({ usage: { input_tokens: 5 } })]))).toMatchObject({ ok: false, reason: 'depth_unknown' });
  });
});
