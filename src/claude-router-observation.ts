import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routerObservation, type RouterObservation } from './router-observation.js';
import { subagentTranscriptPath } from './verify.js';

/** Like claudeTerminal: no symlinks, regular files only, bounded tail, and no transcript text returned to the hook. */
export const readRouterObservation = (path: string, session: string, agent: string, since: number, raw: unknown): RouterObservation | null => {
  if (!path || !session) return null;
  const file = agent ? subagentTranscriptPath(path, session, agent) : path;
  if (!file) return null;
  let fd: number | undefined;
  try {
    for (const dir of [dirname(file), dirname(dirname(file))]) if (lstatSync(dir).isSymbolicLink()) return null;
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd); if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - 1024 * 1024), buffer = Buffer.alloc(stat.size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    return routerObservation(start ? text.slice(text.indexOf('\n') + 1) : text, session, agent, since, raw);
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
};

const isMain = (): boolean => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
};
if (isMain()) {
  const [path = '', session = '', agent = '', since = '', raw = 'null'] = process.argv.slice(2);
  try {
    const usage: unknown = JSON.parse(raw), deadline = Date.now() + 300;
    let observation = readRouterObservation(path, session, agent, Number(since), usage);
    // Claude queues transcript writes: the response can finish before its assistant row reaches disk. Bound the wait
    // within the adapter's 500 ms process deadline; this reads metadata again and never repeats a model request.
    while (!observation && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      observation = readRouterObservation(path, session, agent, Number(since), usage);
    }
    process.stdout.write(JSON.stringify(observation));
  }
  catch { process.stdout.write('null'); }
}
