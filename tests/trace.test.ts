import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { openTraceDir } from '../src/trace.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-trace-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('openTraceDir', () => {
  it('creates a private directory and writes private, atomic, randomly named phase files with join keys inside', () => {
    const dir = join(tmp, 'a', 'b');
    const opened = openTraceDir(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    const r1 = opened.writer.write('pre_intent', { session_id: 's', tool_use_id: 't', caller: { agent_id: null, agent_type: null } });
    const r2 = opened.writer.write('pre_result', { session_id: 's', tool_use_id: 't', caller: { agent_id: null, agent_type: null } });
    expect(r1.ok && r2.ok).toBe(true);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^(pre_intent|pre_result)-[0-9a-f-]{36}\.json$/.test(f))).toBe(true);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    for (const f of files) {
      if (process.platform !== 'win32') expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
      const body = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
      expect(body).toMatchObject({ version: 4, session_id: 's', tool_use_id: 't' });
      expect(typeof body['invocation_id']).toBe('string');
      expect(f).toContain(String(body['invocation_id']));
    }
  });

  it('refuses a symlinked trace directory', () => {
    const real = join(tmp, 'real');
    const link = join(tmp, 'link');
    openTraceDir(real);
    symlinkSync(real, link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(openTraceDir(link)).toMatchObject({ ok: false, error: 'trace directory is a symlink' });
  });

  it('reports write failures instead of throwing', () => {
    const opened = openTraceDir(join(tmp, 'w'));
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    rmSync(join(tmp, 'w'), { recursive: true, force: true });
    expect(opened.writer.write('post', {})).toMatchObject({ ok: false });
  });
});
