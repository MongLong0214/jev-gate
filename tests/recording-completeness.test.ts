import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createRecorder, createRecordingState, type RecorderIO } from '../mods/router/hooks/recording.ts';
import { createRecorder as compactRecorder } from '../mods/compact/hooks/recording.ts';
import { recordingComplete, rowOf, type CellResult } from '../src/bench/ab.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jev-recording-')); dirs.push(dir);
  const io: RecorderIO = {
    paths: async () => ({ home: dir, state: undefined, config: undefined, trace: dir, session: 's' }),
    stat: async () => ({ isLink: false, kind: 'dir', size: 0 }), exists: async () => false, read: async () => '',
    write: async (path, text) => { writeFileSync(path, text); },
    wait: (ms, signal) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); signal.addEventListener('abort', () => clearTimeout(timer), { once: true }); }),
  };
  const cell = { cond: 'C', sid: 's', trace_complete: true, recording_version: 1, prime: {}, harness: {} } as CellResult;
  const receipt = () => readdirSync(dir).filter(n => n.startsWith('mod_recording-')).map(n => JSON.parse(readFileSync(join(dir, n), 'utf8')) as Record<string, unknown>);
  return { dir, io, cell, receipt };
};

describe('recording completion', () => {
  for (const [component, create] of [['router', createRecorder], ['compact', compactRecorder]] as const) {
    it(`${component}: retains a write failure before any file, even when the failure marker would also fail`, async () => {
      const { dir, io, cell, receipt } = fixture(); let fail = true;
      const recorder = create({ ...io, write: async (path, text) => { if (fail) throw new Error('EMFILE'); await io.write(path, text); } });
      recorder.log(`jev-${component} {"event":"request","sent":true}`);
      await recorder.flush();
      expect(readdirSync(dir)).toEqual([]);
      expect(rowOf(cell, null, null, dir).jev_cost).toBeNull();
      fail = false;
      await recorder.finish();
      expect(receipt()).toMatchObject([{ complete: false, attempted: 1, written: 0 }]);
      await create(io).finish(); // The other CLI launch was healthy; it cannot erase this failure.
      expect(rowOf(cell, null, null, dir).jev_cost).toBeNull();
    });
  }

  it('shares failure and counts across Router and Compact callbacks, while healthy empty launches prove zero', async () => {
    const { dir, io, cell, receipt } = fixture(); const state = createRecordingState();
    const router = createRecorder(io, state), compact = compactRecorder(io, state);
    router.log('jev-router {"event":"root","skipped":"no_alternative"}');
    compact.log('jev-compact {"event":"compact","deferred":"trigger"}');
    await compact.finish(); await createRecorder(io).finish();
    expect(receipt()).toEqual(expect.arrayContaining([expect.objectContaining({ complete: true, written: 2 }), expect.objectContaining({ complete: true, written: 0 })]));
    expect(recordingComplete(dir, 's', 'C', 2)).toBe(true);
    expect(rowOf(cell, null, null, dir).jev_cost).toBe(0);
    // Missing or extra records invalidate the manifest count, even after the cell was serialized.
    const record = readdirSync(dir).find(n => n.startsWith('mod_router-'))!;
    rmSync(join(dir, record));
    expect(rowOf(cell, null, null, dir).jev_cost).toBeNull();
  });

  it('retains a queued-write timeout after the queued write eventually succeeds', async () => {
    const { dir, io, cell, receipt } = fixture(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const recorder = createRecorder({ ...io, write: async (path, text) => { if (path.includes('mod_router-')) await held; await io.write(path, text); }, wait: async () => undefined });
    recorder.log('jev-router {"event":"request","sent":true}');
    await recorder.flush(); await recorder.finish();
    expect(receipt()).toMatchObject([{ complete: false, attempted: 1, written: 0 }]);
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(readdirSync(dir).some(n => n.startsWith('mod_router-'))).toBe(true);
    await createRecorder(io).finish();
    expect(rowOf(cell, null, null, dir).jev_cost).toBeNull();
  });

  it('prices a healthy recorded call from its own model, with complete evidence for both CLI launches', async () => {
    const { dir, io, cell } = fixture();
    const recorder = compactRecorder(io);
    recorder.log('jev-compact {"event":"compact","run_id":"r","stage":"started"}');
    recorder.log('jev-compact {"event":"compact","run_id":"r","stage":"jev","jev_sent":true,"jev_model":"jev-1.14.0","usage":{"input_tokens":10000,"output_tokens":1}}');
    await recorder.finish(); await createRecorder(io).finish();
    expect(rowOf(cell, null, null, dir).jev_cost).toBeCloseTo(0.00042, 12);
  });

  it('retains settings-read and Compact marker failures in the shared process state', async () => {
    for (const kind of ['settings', 'touch']) {
      const { io, receipt } = fixture(); let fail = true;
      const recorder = createRecorder({ ...io, exists: async () => kind === 'settings',
        stat: async path => ({ isLink: false, kind: path.endsWith('recording.json') ? 'file' : 'dir', size: 10 }),
        read: async () => { if (fail) throw new Error('EMFILE'); return '{"version":1,"enabled":true}'; },
        write: async (path, text) => { if (fail && path.endsWith('.asked')) throw new Error('ENOSPC'); await io.write(path, text); },
      });
      if (kind === 'settings') recorder.log('jev-router {"event":"request","sent":true}'); else recorder.touch();
      await recorder.flush(); fail = false; await recorder.finish();
      expect(receipt()).toMatchObject([{ complete: false }]);
    }
  });

  it('does not fabricate completion when initialization or the terminal receipt fails', async () => {
    const { dir, io, cell } = fixture();
    const bad = createRecorder({ ...io, stat: async () => { throw new Error('EACCES'); } });
    bad.log('jev-compact {"event":"compact","stage":"started"}');
    await bad.finish();
    expect(readdirSync(dir)).toEqual([]);
    await createRecorder(io).finish();
    expect(rowOf(cell, null, null, dir).jev_cost).toBeNull();
    const failedEnd = createRecorder({ ...io, write: async () => { throw new Error('ENOSPC'); } });
    await failedEnd.finish();
    expect(recordingComplete(dir, 's', 'C', 2)).toBe(false);
  });
});
