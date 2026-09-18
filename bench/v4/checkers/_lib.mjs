import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Contract: `node checker.mjs --describe` → {checks:[id]}; `node checker.mjs <evalDir>` → {checks:[{id,pass}],environmentError}.
// A check is false when the candidate's behavior is wrong, null when it could not be evaluated, and
// environmentError is set only for checker/environment failures, never for candidate code errors.
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
  const check = async (id, fn) => {
    if (!results.has(id)) throw new Error(`unknown check id ${id}`);
    try {
      results.set(id, Boolean(await fn()));
    } catch {
      results.set(id, false);
    }
  };
  if (!evalDir) {
    out.environmentError = 'missing eval directory argument';
  } else {
    const importModule = async (rel) => import(pathToFileURL(join(evalDir, rel)).href);
    const runTests = () => {
      const r = spawnSync(process.execPath, ['--test'], { cwd: evalDir, encoding: 'utf8', timeout: 60_000, env: process.env });
      if (r.error) throw new Error(`cannot spawn node --test: ${r.error.message}`);
      return r.status === 0;
    };
    // Runs the candidate's own test/ directory against a different src/ (a pristine buggy fixture),
    // so a "does this test actually catch the bug" check does not depend on file layout or naming.
    const runTestsAgainst = (srcDir) => {
      const probe = mkdtempSync(join(tmpdir(), 'checker-probe-'));
      cpSync(srcDir, join(probe, 'src'), { recursive: true });
      cpSync(join(evalDir, 'test'), join(probe, 'test'), { recursive: true });
      const pkg = join(evalDir, 'package.json');
      if (existsSync(pkg)) cpSync(pkg, join(probe, 'package.json'));
      const r = spawnSync(process.execPath, ['--test'], { cwd: probe, encoding: 'utf8', timeout: 60_000, env: process.env });
      rmSync(probe, { recursive: true, force: true });
      if (r.error) throw new Error(`cannot spawn node --test: ${r.error.message}`);
      return r.status === 0;
    };
    try {
      await body({ evalDir, check, importModule, runTests, runTestsAgainst });
    } catch (err) {
      out.environmentError = `checker failure: ${err?.message ?? String(err)}`;
    }
  }
  out.checks = required.map((id) => ({ id, pass: results.get(id) }));
  process.stdout.write(JSON.stringify(out) + '\n');
};

export const sameKeys = (obj, keys) => obj !== null && typeof obj === 'object' && JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort());
