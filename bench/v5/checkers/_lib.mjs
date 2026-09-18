import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Contract: `node checker.mjs --describe` → {checks:[id]}; `node checker.mjs <evalDir>` → {checks:[{id,pass,reason}],environmentError}.
// A check is false when the candidate's behavior is wrong, null when it could not be evaluated, and
// environmentError is set only for checker/environment failures, never for candidate code errors.
// V5 (ADR #22 A11): a check body may return `{ passed, reason }` instead of a bare boolean so a failure says which
// behavior regressed and a pass can carry a measured value. A bare boolean stays valid; `reason` is extra JSON the
// runner ignores (it only reads id/pass), so the wire protocol is unchanged.
export const runChecker = async (required, body) => {
  // Candidate code may leak unhandled rejections (e.g. a queue that swallows errors). The evaluator must observe that
  // behavior through its checks, not crash on it: a crash would turn a genuine candidate failure into "unknown".
  process.on('unhandledRejection', () => undefined);
  if (process.argv.includes('--describe')) {
    process.stdout.write(JSON.stringify({ checks: required }) + '\n');
    return;
  }
  const evalDir = process.argv[2];
  const results = new Map(required.map((id) => [id, null]));
  const out = { checks: [], environmentError: null };
  const reasons = new Map();
  const check = async (id, fn) => {
    if (!results.has(id)) throw new Error(`unknown check id ${id}`);
    try {
      const r = await fn();
      const outcome = r !== null && typeof r === 'object' ? r : { passed: r, reason: null };
      results.set(id, Boolean(outcome.passed));
      if (outcome.reason) reasons.set(id, String(outcome.reason));
    } catch (err) {
      results.set(id, false);
      reasons.set(id, `threw: ${err?.message ?? String(err)}`);
    }
  };
  if (!evalDir) {
    out.environmentError = 'missing eval directory argument';
  } else {
    const importModule = async (rel) => import(pathToFileURL(join(evalDir, rel)).href);
    // A suite that hangs or cannot import its target did not pass: that is candidate behavior, not an environment fault,
    // so it is recorded as a failed check with a reason instead of being raised as an environment error.
    const runTests = () => {
      const r = spawnSync(process.execPath, ['--test'], { cwd: evalDir, encoding: 'utf8', timeout: 60_000, env: process.env });
      if (r.error && r.error.code === 'ETIMEDOUT') return { passed: false, reason: 'node --test did not finish within 60s' };
      if (r.error) throw new Error(`cannot spawn node --test: ${r.error.message}`);
      if (r.status === 0) return { passed: true, reason: null };
      return { passed: false, reason: `node --test exited ${r.status}: ${(r.stdout + r.stderr).slice(-300).replace(/\s+/g, ' ').trim()}` };
    };
    // Runs the candidate's own test/ directory against a different src/ (a pristine buggy fixture),
    // so a "does this test actually catch the bug" check does not depend on file layout or naming.
    const runTestsAgainst = (srcDir) => {
      const probe = mkdtempSync(join(tmpdir(), 'checker-probe-'));
      cpSync(srcDir, join(probe, 'src'), { recursive: true });
      cpSync(join(evalDir, 'test'), join(probe, 'test'), { recursive: true });
      const pkg = join(evalDir, 'package.json');
      if (existsSync(pkg)) cpSync(pkg, join(probe, 'package.json'));
      const r = spawnSync(process.execPath, ['--test'], { cwd: probe, encoding: 'utf8', timeout: 30_000, env: process.env });
      rmSync(probe, { recursive: true, force: true });
      // A suite that never completes against the unfixed source (e.g. awaiting a rejection the bug swallows) did not pass.
      // Only a spawn failure is an environment error; the candidate's own suite must still pass (test_suite_passes).
      if (r.error && r.error.code === 'ETIMEDOUT') return false;
      if (r.error) throw new Error(`cannot spawn node --test: ${r.error.message}`);
      return r.status === 0;
    };
    try {
      await body({ evalDir, check, importModule, runTests, runTestsAgainst });
    } catch (err) {
      out.environmentError = `checker failure: ${err?.message ?? String(err)}`;
    }
  }
  out.checks = required.map((id) => ({ id, pass: results.get(id), reason: reasons.get(id) ?? null }));
  process.stdout.write(JSON.stringify(out) + '\n');
};

export const sameKeys = (obj, keys) => obj !== null && typeof obj === 'object' && JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort());
