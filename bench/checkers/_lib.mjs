import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Contract: `node checker.mjs --describe` → {checks:[id]}; `node checker.mjs <evalDir>` → {checks:[{id,pass}],environmentError}.
// A check is false when the candidate's behavior is wrong, null when it could not be evaluated, and
// environmentError is set only for checker/environment failures, never for candidate code errors.
export const runChecker = async (required, body) => {
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
    const countTestFiles = () => {
      try {
        return readdirSync(join(evalDir, 'test')).filter((f) => /\.test\.(mjs|cjs|js|ts)$/.test(f)).length;
      } catch {
        return 0;
      }
    };
    try {
      await body({ evalDir, check, importModule, runTests, countTestFiles });
    } catch (err) {
      out.environmentError = `checker failure: ${err?.message ?? String(err)}`;
    }
  }
  out.checks = required.map((id) => ({ id, pass: results.get(id) }));
  process.stdout.write(JSON.stringify(out) + '\n');
};

export const sameKeys = (obj, keys) => obj !== null && typeof obj === 'object' && JSON.stringify(Object.keys(obj).sort()) === JSON.stringify([...keys].sort());
