
type Component = 'router' | 'compact' | 'output';
const absolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);

/** Metadata emitted by the Mods, independent of --debug. Never given prompts, keys or model output. */
export interface RecorderIO {
  paths(): Promise<{ home: string | undefined; state: string | undefined; config: string | undefined; trace: string | undefined; session: string }>;
  stat(path: string): Promise<{ isLink: boolean; kind: string; size: number }>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  debug(line: string): void;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}
export const createRecorder = (io: RecorderIO) => {
  const pending = new Set<Promise<void>>();
  let context: Promise<{ dir: string; settings: string; session: string } | null> | undefined;
  const load = () => context ??= (async () => {
    try {
      const { home, state, config, trace, session } = await io.paths();
      if (!home || !absolute(home)) return null;
      const dir = trace ?? `${state || `${home}/.local/state`}/jev-gate/claude/traces`;
      const settings = `${config || `${home}/.config`}/jev-gate/auth/recording.json`;
      if (!absolute(dir) || !absolute(settings)) return null;
      // Integrated initialization makes this directory private. Never follow a redirected recording root.
      const stat = await io.stat(dir);
      if (stat.isLink || stat.kind !== 'dir') return null;
      return { dir, settings, session };
    } catch { return null; }
  })();
  const log = (line: string): void => {
    const match = /^jev-(router|compact|output) (\{.*\})$/.exec(line);
    if (!match) return;
    let fields: Record<string, unknown>;
    try { fields = JSON.parse(match[2]!); } catch { return; }
    const component = match[1] as Component;
    const at = new Date().toISOString(); const id = crypto.randomUUID();
    const task = (async () => {
      const c = await load();
      if (c) {
        if (await io.exists(c.settings)) {
          const stat = await io.stat(c.settings);
          if (stat.isLink || stat.kind !== 'file' || stat.size > 16 * 1024) return;
          const setting = JSON.parse(await io.read(c.settings)) as { version?: unknown; enabled?: unknown };
          if (setting.version !== 1 || setting.enabled !== true) return;
        }
        await io.write(`${c.dir}/mod_${component}-${id}.json`, JSON.stringify({
          ...fields, host: 'claude', session_id: c.session, phase: `mod_${component}`, version: 5, invocation_id: id, written_at: at,
        }));
      }
      // Keep explicit host debug logs compatible. Failure of either sink never retries a native operation.
      try { io.debug(line); } catch { /* Optional host sink. */ }
    })().catch(() => undefined);
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  const flush = async (): Promise<void> => {
    if (!pending.size) return;
    const done = Promise.allSettled([...pending]);
    const stop = new AbortController();
    try {
      // Optional recording cannot hold a native result on unavailable host I/O.
      await Promise.race([done, io.wait(100, stop.signal).catch(() => undefined)]);
    } catch { /* A rejected host clock cannot make optional recording block native execution. */ }
    finally { stop.abort(); }
  };
  return { log, flush };
};
