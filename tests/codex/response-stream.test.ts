import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import * as zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { observeResponseStream } from '../../src/codex/response-stream.js';

const response = { model: 'fixture-luna', output: [], usage: { input_tokens: 42 }, label: '한글' };
const event = (ending: string) => `: heartbeat${ending}event: response.completed${ending}data: ${JSON.stringify({ type: 'response.completed', response })}${ending}${ending}`;
const observe = async (bytes: Buffer, encoding?: string, split = false) => {
  const input = new PassThrough() as unknown as IncomingMessage;
  input.headers = encoding ? { 'content-encoding': encoding } : {};
  const native: Buffer[] = []; input.on('data', chunk => native.push(Buffer.from(chunk)));
  const completed = vi.fn(); observeResponseStream(input, completed);
  if (split) for (const byte of bytes) (input as unknown as PassThrough).write(Buffer.from([byte]));
  (input as unknown as PassThrough).end(split ? undefined : bytes);
  await new Promise<void>(resolve => setTimeout(resolve, 20));
  expect(Buffer.concat(native).equals(bytes)).toBe(true);
  return completed;
};

describe('native Responses observation without required Content-Type', () => {
  it.each(['\n', '\r\n', '\r'])('observes split UTF-8 and %j line endings without modifying native bytes', async ending => {
    const completed = await observe(Buffer.from(event(ending)), undefined, true);
    expect(completed).toHaveBeenCalledExactlyOnceWith(response);
  });
  it.each(['gzip', 'deflate', 'br', 'zstd'])('decodes %s only for observation', async encoding => {
    const compress = encoding === 'gzip' ? zlib.gzipSync : encoding === 'deflate' ? zlib.deflateSync : encoding === 'br' ? zlib.brotliCompressSync
      : (zlib as unknown as { zstdCompressSync?: (bytes: Buffer) => Buffer }).zstdCompressSync;
    if (!compress) return;
    const completed = await observe(compress(Buffer.from(event('\r\n'))), encoding, true);
    await vi.waitFor(() => expect(completed).toHaveBeenCalledExactlyOnceWith(response), { timeout: 2000 });
  });
  it('drops malformed and oversized events, then recovers on the next full event', async () => {
    const completed = await observe(Buffer.from('data: nope\n\ndata: ' + 'x'.repeat(4 * 1024 * 1024 + 1) + '\n\n' + event('\n')));
    expect(completed).toHaveBeenCalledExactlyOnceWith(response);
  });
  it.each(['gzip', 'unknown'])('preserves invalid or unsupported %s bytes', async encoding => {
    const completed = await observe(Buffer.from(event('\n')), encoding);
    expect(completed).not.toHaveBeenCalled();
  });
  it('does not mistake an incomplete event or a nonterminal event for completion', async () => {
    const completed = await observe(Buffer.from('data: {"type":"response.created"}\n\n' + event('\n').slice(0, -1)));
    expect(completed).not.toHaveBeenCalled();
  });
  it('continues forwarding when observation throws', async () => {
    const input = new PassThrough() as unknown as IncomingMessage; input.headers = {};
    const native: Buffer[] = []; input.on('data', chunk => native.push(Buffer.from(chunk)));
    observeResponseStream(input, () => { throw new Error('trace unavailable'); });
    const bytes = Buffer.from(event('\n')); (input as unknown as PassThrough).end(bytes);
    expect(Buffer.concat(native).equals(bytes)).toBe(true);
  });
  it.each(['response.failed', 'response.incomplete'])('reports %s separately while preserving usage and native bytes', type => {
    const input = new PassThrough() as unknown as IncomingMessage; input.headers = {};
    const native: Buffer[] = []; input.on('data', chunk => native.push(Buffer.from(chunk)));
    const completed = vi.fn(), failed = vi.fn(); observeResponseStream(input, completed, failed);
    const bytes = Buffer.from(`data: ${JSON.stringify({ type, response })}\n\n`);
    (input as unknown as PassThrough).end(bytes);
    expect(completed).not.toHaveBeenCalled(); expect(failed).toHaveBeenCalledExactlyOnceWith(response);
    expect(Buffer.concat(native).equals(bytes)).toBe(true);
  });
  it.each([false, true])('drains already-received gzip before settling a disconnect (complete=%s)', async complete => {
    const input = new PassThrough() as unknown as IncomingMessage; input.headers = { 'content-encoding': 'gzip' };
    const completed = vi.fn(), ended = vi.fn();
    observeResponseStream(input, completed, undefined, ended);
    const bytes = zlib.gzipSync(Buffer.from(event('\n')));
    (input as unknown as PassThrough).write(complete ? bytes : bytes.subarray(0, 10));
    input.emit('aborted');
    await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(completed).toHaveBeenCalledTimes(complete ? 1 : 0);
    if (complete) expect(completed.mock.invocationCallOrder[0]).toBeLessThan(ended.mock.invocationCallOrder[0]!);
    (input as unknown as PassThrough).destroy();
  });
  it.each(['empty', 'created', 'gzip', 'malformed', 'oversized', 'partial', 'unknown_encoding', 'invalid_gzip', 'invalid_terminal', 'invalid_utf8'])('distinguishes fully observed EOF from observation loss: %s', async scenario => {
    const input = new PassThrough() as unknown as IncomingMessage;
    input.headers = scenario.includes('gzip') ? { 'content-encoding': 'gzip' } : scenario === 'unknown_encoding' ? { 'content-encoding': 'unknown' } : {};
    const created = 'data: {"type":"response.created"}\n\n';
    const text = scenario === 'empty' ? '' : scenario === 'malformed' ? 'data: nope\n\n' + created : scenario === 'oversized' ? 'data: ' + 'x'.repeat(4 * 1024 * 1024 + 1) + '\n\n' + created : scenario === 'partial' ? event('\n').slice(0, -1) : scenario === 'invalid_terminal' ? 'data: {"type":"response.completed"}\n\n' : created;
    const bytes = scenario === 'gzip' ? zlib.gzipSync(Buffer.from(text)) : scenario === 'invalid_utf8' ? Buffer.concat([Buffer.from('data: {"type":"response.created","text":"'), Buffer.from([0xff]), Buffer.from('"}\n\n')]) : Buffer.from(text);
    const native: Buffer[] = []; input.on('data', chunk => native.push(Buffer.from(chunk)));
    const completed = vi.fn(), failed = vi.fn(), ended = vi.fn(); observeResponseStream(input, completed, failed, ended);
    (input as unknown as PassThrough).end(bytes);
    await vi.waitFor(() => expect(ended).toHaveBeenCalledExactlyOnceWith(['empty', 'created', 'gzip'].includes(scenario) ? 'eof' : 'unobserved'));
    expect(completed).not.toHaveBeenCalled(); expect(failed).not.toHaveBeenCalled();
    expect(Buffer.concat(native)).toEqual(bytes);
  });
});
