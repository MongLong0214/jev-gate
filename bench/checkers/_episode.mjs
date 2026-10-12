import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// True when fn throws an error of exactly this class and message; a different error is a wrong answer, not a pass.
export const throwsExactly = (fn, Kind, message) => {
  try {
    fn();
  } catch (err) {
    return err instanceof Kind && err.message === message;
  }
  return false;
};

// Some file under test/ mentions the module, which is what "add a test for it" leaves behind whatever its file name.
export const testMentions = (evalDir, pattern) => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  try {
    return walk(join(evalDir, 'test')).some((f) => /\.(m?js|cjs)$/.test(f) && pattern.test(readFileSync(f, 'utf8')));
  } catch {
    return false;
  }
};
