import { StringDecoder } from 'node:string_decoder';
import type { IncomingMessage } from 'node:http';
import type { Transform } from 'node:stream';
import * as zlib from 'node:zlib';
import { obj, type Obj } from './source.js';

/** A bounded observation branch; native response bytes and headers stay untouched. */
export const observeResponseStream = (response: IncomingMessage, completed: (response: Obj) => void): void => {
  const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  let inflate: Transform | undefined;
  if (encoding === 'gzip') inflate = zlib.createGunzip();
  else if (encoding === 'deflate') inflate = zlib.createInflate();
  else if (encoding === 'br') inflate = zlib.createBrotliDecompress();
  else if (encoding === 'zstd') {
    const create = (zlib as unknown as { createZstdDecompress?: () => Transform }).createZstdDecompress;
    if (!create) return;
    inflate = create();
  } else if (encoding !== 'identity') return;
  const source = inflate ?? response;
  const decoder = new StringDecoder('utf8');
  const limit = 4 * 1024 * 1024;
  let line = ''; let data: string[] = []; let size = 0; let discarded = false; let skipLf = false;
  const newline = (): void => {
    if (!line && !discarded) {
      try {
        const event = obj(JSON.parse(data.join('\n')));
        if (event?.['type'] === 'response.completed') {
          const value = obj(event['response']); if (value) completed(value);
        }
      } catch { /* Unknown events and observer errors never affect native inference. */ }
    }
    if (!line) { data = []; size = 0; discarded = false; }
    else if (!discarded && line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    line = '';
  };
  source.on('data', chunk => {
    const text = decoder.write(Buffer.from(chunk));
    let start = 0;
    if (skipLf && text.startsWith('\n')) start = 1;
    if (text.length) skipLf = false;
    const delimiters = /\r\n|\r|\n/g; delimiters.lastIndex = start;
    let match: RegExpExecArray | null;
    const append = (value: string): void => {
      size += Buffer.byteLength(value);
      if (size > limit) { discarded = true; data = []; }
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
    const stop = (): void => { response.unpipe(inflate); inflate.destroy(); };
    inflate.on('error', stop); response.once('aborted', stop); response.once('error', stop);
    response.pipe(inflate);
  }
};
