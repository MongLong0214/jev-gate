import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { gradeDir, minimalEnv } from '../src/bench/checker.js';

const tmp = mkdtempSync(join(tmpdir(), 'jev-checker-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const checker = (body: string): string => {
  const p = join(tmp, `checker-${n++}.mjs`);
  writeFileSync(p, body);
  return p;
};
const evalDir = join(tmp, 'eval');
mkdirSync(evalDir, { recursive: true });
const opts = { timeoutMs: 5000, checkerId: 'test' };
const describeOk = `if (process.argv.includes('--describe')) { console.log(JSON.stringify({checks:['a','b']})); } else {`;

describe('gradeDir protocol', () => {
  it('passes only when every declared check is true with a normal exit', () => {
    const g = gradeDir(checker(`${describeOk} console.log(JSON.stringify({checks:[{id:'a',pass:true},{id:'b',pass:true}],environmentError:null})); }`), evalDir, opts);
    expect(g).toMatchObject({ quality: 'pass', reason: null, required: ['a', 'b'], checkerId: 'test' });
  });

  it('regression: PASS JSON followed by exit 23 is unknown, never pass', () => {
    const g = gradeDir(checker(`${describeOk} console.log(JSON.stringify({checks:[{id:'a',pass:true},{id:'b',pass:true}],environmentError:null})); process.exitCode = 23; }`), evalDir, opts);
    expect(g.quality).toBe('unknown');
    expect(g.reason).toMatch(/exit 23/);
    expect(g.checks.map((c) => c.pass)).toEqual([true, true]);
  });

  it('regression: PASS JSON followed by a hang is unknown (timeout), not pass', () => {
    const g = gradeDir(checker(`${describeOk} console.log(JSON.stringify({checks:[{id:'a',pass:true},{id:'b',pass:true}],environmentError:null})); setInterval(() => {}, 1000); }`), evalDir, { ...opts, timeoutMs: 800 });
    expect(g.quality).toBe('unknown');
    expect(g.reason).toMatch(/timeout/);
    expect(g.run?.timedOut).toBe(true);
  });

  it('a verified requirement failure is fail even when dependent checks were not run', () => {
    const g = gradeDir(checker(`${describeOk} console.log(JSON.stringify({checks:[{id:'a',pass:false},{id:'b',pass:null}],environmentError:null})); }`), evalDir, opts);
    expect(g.quality).toBe('fail');
    expect(g.reason).toMatch(/failed: a; not evaluated: b/);
  });

  it('environment errors and unrun observations are unknown', () => {
    expect(gradeDir(checker(`${describeOk} console.log(JSON.stringify({checks:[{id:'a',pass:true},{id:'b',pass:null}],environmentError:'registry down'})); }`), evalDir, opts)).toMatchObject({ quality: 'unknown', reason: 'environment: registry down' });
    expect(gradeDir(checker(`${describeOk} console.log(JSON.stringify({checks:[{id:'a',pass:true},{id:'b',pass:null}],environmentError:null})); }`), evalDir, opts)).toMatchObject({ quality: 'unknown', reason: 'not evaluated: b' });
  });

  it('protocol violations are unknown: failed describe, empty/duplicate ids, mismatched ids, missing environmentError, wrong types', () => {
    expect(gradeDir(checker(`process.exit(3)`), evalDir, opts).reason).toMatch(/describe did not complete/);
    expect(gradeDir(checker(`if (process.argv.includes('--describe')) console.log(JSON.stringify({checks:[]})); else console.log('{}')`), evalDir, opts).reason).toMatch(/invalid, empty or duplicated/);
    expect(gradeDir(checker(`if (process.argv.includes('--describe')) console.log(JSON.stringify({checks:['a','a']})); else console.log('{}')`), evalDir, opts).reason).toMatch(/invalid, empty or duplicated/);
    expect(gradeDir(checker(`${describeOk} console.log(JSON.stringify({checks:[{id:'a',pass:true}],environmentError:null})); }`), evalDir, opts).reason).toMatch(/does not match/);
    expect(gradeDir(checker(`${describeOk} console.log(JSON.stringify({checks:[{id:'a',pass:true},{id:'b',pass:true}]})); }`), evalDir, opts).reason).toMatch(/violates the protocol/);
    expect(gradeDir(checker(`${describeOk} console.log(JSON.stringify({checks:[{id:'a',pass:'yes'},{id:'b',pass:true}],environmentError:null})); }`), evalDir, opts).reason).toMatch(/violates the protocol/);
    expect(gradeDir(join(tmp, 'missing.mjs'), evalDir, opts).reason).toBe('checker file missing');
  });

  it('runs evaluationSetup in the evaluation copy with a minimal environment and stops on setup failure', () => {
    const probe = checker(`${describeOk} const ok = process.env.TYPESAFE_API_KEY === undefined && process.env.ANTHROPIC_API_KEY === undefined && process.env.NODE_OPTIONS === undefined; console.log(JSON.stringify({checks:[{id:'a',pass:ok},{id:'b',pass:true}],environmentError:null})); }`);
    process.env['TYPESAFE_API_KEY'] = 'leak-test';
    process.env['NODE_OPTIONS'] = '--no-warnings';
    try {
      const g = gradeDir(probe, evalDir, { ...opts, evaluationSetup: [[process.execPath, '-e', 'process.exit(0)']] });
      expect(g.quality).toBe('pass');
      expect(g.evaluationSetup).toHaveLength(1);
      const failed = gradeDir(probe, evalDir, { ...opts, evaluationSetup: [[process.execPath, '-e', 'process.exit(4)']] });
      expect(failed.quality).toBe('unknown');
      expect(failed.reason).toMatch(/evaluation setup failed/);
      expect(failed.describe).toBeNull();
    } finally {
      delete process.env['TYPESAFE_API_KEY'];
      delete process.env['NODE_OPTIONS'];
    }
    expect(Object.keys(minimalEnv('/h')).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
  });
});
