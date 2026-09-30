import { createHash } from 'node:crypto';
import { looksSecret, resolveReferences, MAX_OPTIONAL_GROUPS, SOURCE_MAX_BYTES, type LeanSourceBinding, type LeanSourceOutcome } from '../lean-source.js';
import type { WorkerObservation } from '../verify.js';

export type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null;
export const textInput = (v: unknown): string | null => {
  if (!Array.isArray(v) || v.some(i => obj(i)?.['type'] !== 'text' || typeof obj(i)?.['text'] !== 'string')) return null;
  return v.map(i => obj(i)!['text']).join('\n');
};
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** App Server items, not an invented Claude transcript. User input and completed observations stay distinct. */
export const codexSource = (items: readonly Obj[], binding: LeanSourceBinding, epoch: string, complete: boolean): LeanSourceOutcome => {
  const fail = (reason: 'source_incomplete' | 'source_unsupported' | 'source_identity_mismatch' | 'source_bounded'): LeanSourceOutcome =>
    ({ ok: false, reason, detail: 'Codex source cannot be carried completely', bytesRead: 0, durationMs: 0 });
  if (!complete) return fail('source_incomplete');
  const bytes = Buffer.byteLength(JSON.stringify(items));
  if (bytes > SOURCE_MAX_BYTES) return fail('source_bounded');
  const own = items.findIndex(i => i['type'] === 'userMessage' && i['clientId'] === binding.promptId);
  if (binding.phase === 'dispatch' && own < 0) return fail('source_identity_mismatch');
  if (own >= 0 && textInput(items[own]!['content']) !== binding.request) return fail('source_identity_mismatch');
  const prefix = own < 0 ? items : items.slice(0, own);
  const drafts: Array<{ origin: 'human' | 'assistant_tool' | 'observation' | 'compact_summary'; text: string; sourceRefs: string[]; mandatory: boolean }> = [];
  for (const i of prefix) {
    const type = i['type'];
    const id = typeof i['id'] === 'string' ? i['id'] : null;
    if (!id) return fail('source_identity_mismatch');
    if (type === 'userMessage') {
      const text = textInput(i['content']);
      if (text === null) return fail('source_unsupported');
      drafts.push({ origin: 'human', text, sourceRefs: [id], mandatory: true });
    } else if (type === 'agentMessage' && typeof i['text'] === 'string') {
      drafts.push({ origin: 'assistant_tool', text: i['text'], sourceRefs: [id], mandatory: false });
    } else if (type === 'jevCompact' && typeof i['text'] === 'string') {
      drafts.push({ origin: 'compact_summary', text: i['text'], sourceRefs: [id], mandatory: true });
    } else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'functionCallOutput', 'webSearch'].includes(String(type))) {
      // A pending tool is not a completed fact and cannot be silently omitted from a fresh executor's context.
      if (i['status'] === 'inProgress') return fail('source_incomplete');
      drafts.push({ origin: 'observation', text: JSON.stringify(i), sourceRefs: [id], mandatory: false });
    } else if (type === 'contextCompaction') return fail('source_unsupported');
    else if (!['reasoning', 'plan', 'hookPrompt'].includes(String(type))) return fail('source_unsupported');
  }
  const refs = resolveReferences([binding.request, ...drafts.filter(g => g.mandatory).map(g => g.text)], drafts.filter(g => !g.mandatory));
  const promoted = drafts.map(g => refs.has(g) ? { ...g, mandatory: true } : g);
  let secret = 0;
  const safe = promoted.filter(g => g.mandatory || !looksSecret(g.text) || (secret++, false));
  const window = Math.max(0, safe.filter(g => !g.mandatory).length - MAX_OPTIONAL_GROUPS);
  let seen = 0, mandatory = 0, optional = 0;
  const groups = safe.filter(g => g.mandatory || seen++ >= window).map(g => ({ ...g, id: g.mandatory ? `m${++mandatory}` : `g${++optional}` }));
  const unassessed = secret + window;
  return { ok: true, source: {
    request: binding.request, groups, epoch, prefixDigest: sha(JSON.stringify(prefix)),
    newerHumanText: own >= 0 && items.slice(own + 1).some(i => i['type'] === 'userMessage'), requestRecorded: own >= 0,
    coverage: unassessed ? 'partial' : 'complete', unassessed, excluded: { secret, window, unattributed: 0 },
    hostContext: prefix.filter(i => i['type'] === 'hookPrompt').length, abandoned: 0, bytesRead: bytes, durationMs: 0,
  } };
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
