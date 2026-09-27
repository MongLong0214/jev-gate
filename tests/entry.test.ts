import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { Env } from '../src/config.js';
import { isDefinitelyOff } from '../src/entry.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-entry-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let seq = 0;
const configFile = (body: unknown): string => {
  const p = join(tmp, `c${(seq += 1)}.json`);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body));
  return p;
};

const HOME = tmp; // no ~/.claude config file lives here, so an unset JEV_GATE_CONFIG resolves to "no file"

describe('isDefinitelyOff (#48 P2)', () => {
  it('is definitely off when JEV_GATE_MODE=off, no config file needed', () => {
    expect(isDefinitelyOff({ HOME, JEV_GATE_MODE: 'off' } as Env)).toBe(true);
  });

  it('is not off for native, auto or lean via env', () => {
    for (const mode of ['native', 'auto', 'lean']) expect(isDefinitelyOff({ HOME, JEV_GATE_MODE: mode } as Env)).toBe(false);
  });

  it('is not off when no env and no config file exist at all (defaults to off, so this IS off)', () => {
    // DEFAULT_CONFIG.mode is 'off', so an installation with no env override and no config file is correctly the fast path.
    expect(isDefinitelyOff({ HOME } as Env)).toBe(true);
  });

  it('reads mode:"off" from a config file when no env override is set -- the config-file-off variant', () => {
    const cfg = configFile({ version: 5, mode: 'off' });
    expect(isDefinitelyOff({ HOME, JEV_GATE_CONFIG: cfg } as Env)).toBe(true);
  });

  it('a config file with mode:"auto" is not off', () => {
    const cfg = configFile({ version: 5, mode: 'auto' });
    expect(isDefinitelyOff({ HOME, JEV_GATE_CONFIG: cfg } as Env)).toBe(false);
  });

  it('JEV_GATE_MODE overrides a config file that says off', () => {
    const cfg = configFile({ version: 5, mode: 'off' });
    expect(isDefinitelyOff({ HOME, JEV_GATE_CONFIG: cfg, JEV_GATE_MODE: 'auto' } as Env)).toBe(false);
  });

  it('is conservative: an unreadable or invalid config file is NOT treated as off (falls through to hook.js)', () => {
    expect(isDefinitelyOff({ HOME, JEV_GATE_CONFIG: join(tmp, 'does-not-exist.json') } as Env)).toBe(false);
    expect(isDefinitelyOff({ HOME, JEV_GATE_CONFIG: configFile('{not json') } as Env)).toBe(false);
    expect(isDefinitelyOff({ HOME, JEV_GATE_CONFIG: configFile({ version: 5, mode: 'bogus' }) } as Env)).toBe(false);
  });

  it('an invalid JEV_GATE_MODE value is also not treated as off', () => {
    expect(isDefinitelyOff({ HOME, JEV_GATE_MODE: 'bogus' } as Env)).toBe(false);
  });
});
