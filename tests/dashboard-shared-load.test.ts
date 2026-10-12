import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/activity.js', async (original) => {
  const actual = await original<typeof import('../src/activity.js')>();
  return { ...actual, loadActivity: (...args: Parameters<typeof actual.loadActivity>) => { loads.count++; return actual.loadActivity(...args); } };
});
const { startDashboard } = await import('../src/dashboard.js');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const make = (): string => { const dir = mkdtempSync(join(tmpdir(), 'jev-shared-load-')); dirs.push(dir); return dir; };

// #210: concurrent viewers and snapshot requests share one rebuild instead of each computing the history.
describe('dashboard rebuild sharing (#210)', () => {
  it('computes once for simultaneous viewers and once more per change', async () => {
    const trace = make();
    writeFileSync(join(trace, 'a.json'), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
    const server = await startDashboard({ traceDir: trace, debugDir: null, env: { HOME: make(), JEV_GATE_STATE_DIR: make() } }, 0);
    const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
    const frame = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> => {
      for (;;) {
        const chunk = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('frame timed out')), 5000))]);
        if (chunk.done) throw new Error('SSE ended');
        const text = new TextDecoder().decode(chunk.value);
        if (text.includes('data: {')) return text;
      }
    };
    try {
      loads.count = 0;
      const responses = await Promise.all([fetch(`${server.url}api/live`), fetch(`${server.url}api/live`), fetch(`${server.url}api/live`), fetch(`${server.url}api/snapshot`)]);
      readers.push(...responses.slice(0, 3).map(r => r.body!.getReader()));
      expect(((await responses[3]!.json()) as { traceFiles: number }).traceFiles).toBe(1);
      for (const reader of readers) expect(await frame(reader)).toContain('"traceFiles":1');
      expect(loads.count).toBe(1);

      writeFileSync(join(trace, 'b.json'), JSON.stringify({ phase: 'stop', session_id: 's', written_at: new Date().toISOString(), outcome: 'completed' }));
      for (const reader of readers) expect(await frame(reader)).toContain('"traceFiles":2');
      expect(loads.count).toBe(2);
    } finally {
      for (const reader of readers) await reader.cancel().catch(() => undefined);
      await server.close();
    }
  });
});
