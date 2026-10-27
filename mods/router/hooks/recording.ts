
type Component = 'router' | 'compact';
const absolute = (path: string): boolean => path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);

/** Metadata emitted by the Mods. Never given prompts, keys or model output. */
export interface RecorderIO {
  paths(): Promise<{ home: string | undefined; state: string | undefined; config: string | undefined; trace: string | undefined; session: string }>;
  stat(path: string): Promise<{ isLink: boolean; kind: string; size: number }>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}
/** One host process shares its recording outcome across Router and Compact callbacks. */
export const createRecordingState = () => ({ id: crypto.randomUUID(), pending: new Set<Promise<void>>(), attempted: 0, written: 0, failed: false });
export type RecordingState = ReturnType<typeof createRecordingState>;

export const createRecorder = (io: RecorderIO, state: RecordingState = createRecordingState()) => {
  const pending = state.pending;
  const records: Array<{ path: string; fields: Record<string, unknown> }> = [];
  const track = (task: Promise<void>): void => {
    pending.add(task); void task.finally(() => pending.delete(task));
  };
  let context: Promise<{ dir: string; settings: string; session: string } | null> | undefined;
  const load = () => context ??= (async () => {
    try {
      const { home, state, config, trace, session } = await io.paths();
      if (!home || !absolute(home)) throw new Error('recording home unavailable');
      const dir = trace ?? `${state || `${home}/.local/state`}/jev-gate/claude/traces`;
      const settings = `${config || `${home}/.config`}/jev-gate/auth/recording.json`;
      if (!absolute(dir) || !absolute(settings)) throw new Error('recording path unavailable');
      // Integrated initialization makes this directory private. Never follow a redirected recording root.
      const stat = await io.stat(dir);
      if (stat.isLink || stat.kind !== 'dir') throw new Error('recording directory unavailable');
      return { dir, settings, session };
    } catch { state.failed = true; return null; }
  })();
  const enabled = async (c: { settings: string }): Promise<boolean> => {
    if (!await io.exists(c.settings)) return true;
    const stat = await io.stat(c.settings);
    if (stat.isLink || stat.kind !== 'file' || stat.size > 16 * 1024) throw new Error('invalid recording settings');
    const setting = JSON.parse(await io.read(c.settings)) as { version?: unknown; enabled?: unknown };
    return setting.version === 1 && setting.enabled === true;
  };
  const log = (line: string): void => {
    const match = /^jev-(router|compact) (\{.*\})$/.exec(line);
    if (!match) return;
    let fields: Record<string, unknown>;
    try { fields = JSON.parse(match[2]!); } catch { return; }
    const component = match[1] as Component;
    const at = new Date().toISOString(); const id = crypto.randomUUID(); const name = `mod_${component}-${id}`;
    state.attempted++;
    const task = (async () => {
      const c = await load();
      if (c) {
        if (!await enabled(c)) throw new Error('recording unavailable');
        await io.write(`${c.dir}/${name}.json`, JSON.stringify({
          ...fields, host: 'claude', session_id: c.session, phase: `mod_${component}`, version: 5, loss_marker: true, recording_id: state.id, invocation_id: id, written_at: at,
        }));
        state.written++;
        records.push({ path: `${c.dir}/${name}.json`, fields });
      }
    })().catch(() => { state.failed = true; });
    track(task);
  };
  /** The command hook uses this marker even while metadata recording is off. */
  const touch = (): void => {
    track((async () => {
      const c = await load();
      if (c && /^[\w-]{1,128}$/.test(c.session)) await io.write(`${c.dir}/compact_asked-${c.session}.asked`, JSON.stringify({ at: Date.now() }));
    })().catch(() => { state.failed = true; }));
  };
  const bounded = async (done: Promise<unknown>): Promise<void> => {
    const stop = new AbortController(); let settled = false;
    try {
      // Optional recording cannot hold a native result on unavailable host I/O.
      await Promise.race([done.finally(() => { settled = true; }), io.wait(100, stop.signal)]);
    } catch { state.failed = true; }
    finally { stop.abort(); if (!settled) state.failed = true; }
  };
  const flush = async (): Promise<void> => {
    if (pending.size) await bounded(Promise.allSettled([...pending]));
  };
  /** Failure is sticky even if the filesystem recovers before session.end. */
  const finish = async (): Promise<void> => {
    await flush();
    await bounded((async () => {
      const c = await load();
      if (!c || !await enabled(c)) return;
      await io.write(`${c.dir}/mod_recording-${state.id}.json`, JSON.stringify({
        host: 'claude', session_id: c.session, phase: 'mod_recording', version: 5, recording_id: state.id,
        invocation_id: state.id, written_at: new Date().toISOString(), attempted: state.attempted, written: state.written,
        complete: !state.failed && pending.size === 0 && state.attempted === state.written,
      }));
    })());
  };
  return { log, touch, flush, finish, records };
};
