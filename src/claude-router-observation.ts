import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routerObservation, type RouterObservation } from './router-observation.js';
import { subagentTranscriptPath } from './verify.js';

/** The session's main transcript, `<config>/projects/<project>/<session>.jsonl`. Hooks modules learn its path only from
 * classic events, and a plugin earlier in that chain can skip them (2.1.304: every routed result went unobserved), so the
 * session id finds it. A second match is ambiguous and reads nothing. */
export const transcriptOf = (session: string, env: NodeJS.ProcessEnv = process.env): string | null => {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(session)) return null;
  const projects = join(env['CLAUDE_CONFIG_DIR'] || join(env['HOME'] || homedir(), '.claude'), 'projects');
  try {
    const found = readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(projects, d.name, `${session}.jsonl`)).filter(p => existsSync(p));
    return found.length === 1 ? found[0]! : null;
  } catch { return null; }
};

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
  const [session = '', agent = '', since = '', raw = 'null'] = process.argv.slice(2);
  try {
    const usage: unknown = JSON.parse(raw), deadline = Date.now() + 300;
    // A new session's transcript file appears with its first rows, so it is looked up again only until it is found.
    let path: string | null = null;
    const read = (): RouterObservation | null => readRouterObservation((path ??= transcriptOf(session)) ?? '', session, agent, Number(since), usage);
    let observation = read();
    // Claude queues transcript writes: the response can finish before its assistant row reaches disk. Bound the wait
    // within the adapter's 500 ms process deadline; this reads metadata again and never repeats a model request.
    while (!observation && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      observation = read();
    }
    process.stdout.write(JSON.stringify(observation));
  }
  catch { process.stdout.write('null'); }
}
