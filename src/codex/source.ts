import type { WorkerObservation } from '../verify.js';

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null;
export const textInput = (v: unknown): string | null => {
  if (!Array.isArray(v) || v.some(i => obj(i)?.['type'] !== 'text' || typeof obj(i)?.['text'] !== 'string')) return null;
  return v.map(i => obj(i)!['text']).join('\n');
};
/** Check acceptance consumes observed terminal commands and edits, never a worker's asserted pass. */
export const codexObservation = (items: readonly Obj[], complete = true, commands: ReadonlyMap<string, string> = new Map()): WorkerObservation => {
  const runs: WorkerObservation['runs'] = [];
  let lastWrite: number | null = null;
  let openWrite = false;
  items.forEach((i, at) => {
    if (i['type'] === 'fileChange') { lastWrite = at; if (i['status'] === 'inProgress') openWrite = true; }
    if (i['type'] === 'commandExecution' && typeof i['command'] === 'string') {
      const original = commands.get(String(i['id']));
      // Native commandExecution wraps the hook's command in a shell. Attribute the original only when the
      // observed full command is that exact shell invocation, including its quoting. No suffix is discarded.
      const quoted = original === undefined ? null : `'${original.replaceAll("'", "'\\''")}'`;
      const wrapper = /^\/[^\s]+\/(?:zsh|bash|sh) -(?:lc|c) (.*)$/s.exec(i['command']);
      const command = original !== undefined && (i['command'] === original || wrapper?.[1] === quoted) ? original : i['command'];
      runs.push({ command, at,
      status: i['status'] === 'completed' && i['exitCode'] === 0 ? 'passed' : i['status'] === 'failed' || typeof i['exitCode'] === 'number' && i['exitCode'] !== 0 ? 'failed' : 'unknown',
      });
    }
  });
  return { runs, lastWrite, ...(openWrite ? { openWrite: true } : {}), truncated: !complete };
};
