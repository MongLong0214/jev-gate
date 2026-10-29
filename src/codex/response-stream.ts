import { StringDecoder } from 'node:string_decoder';
import type { IncomingMessage } from 'node:http';
import type { Transform } from 'node:stream';
import * as zlib from 'node:zlib';
import { obj, type Obj } from './source.js';

export type ResponseStreamEnd = 'eof' | 'unobserved';

/** A bounded observation branch; native response bytes and headers stay untouched. */
export const observeResponseStream = (response: IncomingMessage, completed: (response: Obj) => void, failed?: (response: Obj) => void, ended?: (outcome: ResponseStreamEnd) => void): void => {
  let finished = false; let observable = true;
  const finish = (eof = false): void => { if (finished) return; finished = true; try { ended?.(eof && observable ? 'eof' : 'unobserved'); } catch { /* Observation only. */ } };
  const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  let inflate: Transform | undefined;
  if (encoding === 'gzip') inflate = zlib.createGunzip();
  else if (encoding === 'deflate') inflate = zlib.createInflate();
  else if (encoding === 'br') inflate = zlib.createBrotliDecompress();
  else if (encoding === 'zstd') {
    const create = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
    if (!create) { response.once('close', () => finish()); return; }
    inflate = create();
  } else if (encoding !== 'identity') { response.once('close', () => finish()); return; }
  const source = inflate ?? response;
  const decoder = new StringDecoder('utf8');
  const limit = 4 * 1024 * 1024;
  let line = ''; let data: string[] = []; let size = 0; let discarded = false; let skipLf = false;
  source.once('end', () => {
    // A dropped or unterminated event could contain the terminal response. Only a
    // fully observed, clean EOF establishes that no terminal event arrived.
    if (decoder.end() || line || data.length || discarded) observable = false;
    finish(response.complete !== false);
  });
  source.once('close', () => finish());
  const newline = (): void => {
    if (!line && !discarded && data.length) {
      try {
        const event = obj(JSON.parse(data.join('\n')));
        if (!event || typeof event['type'] !== 'string') observable = false;
        else if (event['type'] === 'response.completed') {
          const value = obj(event['response']); if (value) completed(value); else observable = false;
        } else if (event?.['type'] === 'response.failed' || event?.['type'] === 'response.incomplete') {
          const value = obj(event['response']); if (value) failed?.(value); else observable = false;
        }
      } catch { observable = false; /* Observation loss never establishes provider failure. */ }
    }
    if (!line) { data = []; size = 0; discarded = false; }
    else if (!discarded && line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    line = '';
  };
  source.on('data', chunk => {
    const text = decoder.write(Buffer.from(chunk));
    if (text.includes('\uFFFD')) observable = false;
    let start = 0;
    if (skipLf && text.startsWith('\n')) start = 1;
    if (text.length) skipLf = false;
    const delimiters = /\r\n|\r|\n/g; delimiters.lastIndex = start;
    let match: RegExpExecArray | null;
    const append = (value: string): void => {
      size += Buffer.byteLength(value);
      if (size > limit) { observable = false; discarded = true; data = []; }
      // Keep a nonempty sentinel until the next empty line, without retaining oversized payloads.
      line = discarded ? (line || (value.length ? '!' : '')) : line + value;
    };
    while ((match = delimiters.exec(text))) {
      append(text.slice(start, match.index)); newline();
      start = delimiters.lastIndex;
      skipLf = match[0] === '\r' && start === text.length;
    }
    append(text.slice(start));
  });
  if (inflate) {
    const drain = (): void => {
      response.unpipe(inflate);
      // Drain bytes already received before deciding cancellation: a complete compressed
      // terminal event may still be waiting on zlib when the client disconnects.
      if (!inflate.writableEnded && !inflate.destroyed) inflate.end();
    };
    inflate.on('error', () => { response.unpipe(inflate); inflate.destroy(); });
    response.once('aborted', drain); response.once('error', drain);
    response.pipe(inflate);
  }
};
