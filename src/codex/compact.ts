import { DIGEST_MARK, buildDigest, type DigestMessage, type DigestToolUse } from '../../mods/compact/hooks/digest.ts';
import { obj, type Obj } from './source.js';

const text = (parts: unknown): string | null => typeof parts === 'string' ? parts : Array.isArray(parts) && parts.every(p => ['input_text', 'output_text'].includes(String(obj(p)?.['type'])) && typeof obj(p)?.['text'] === 'string') ? parts.map(p => obj(p)!['text']).join('\n') : null;
export const isCodexCompactRequest = (input: unknown, marker: string): boolean => {
  if (!Array.isArray(input)) return false;
  const last = obj(input.at(-1));
  return last?.['type'] === 'message' && last['role'] === 'user' && text(last['content']) === marker;
};
const commandOutcome = (tool: string, output: string): NonNullable<DigestToolUse['outcome']> => {
  if (!/^(?:functions\.)?(exec_command|write_stdin)$/.test(tool)) return 'unknown';
  const envelope = /^Chunk ID: [a-zA-Z0-9_-]+\nWall time: [0-9]+(?:\.[0-9]+)? seconds\nProcess exited with code (-?\d+)\n(?:Final output:|Output:)\n/.exec(output);
  return envelope ? (Number(envelope[1]) === 0 ? 'success' : 'failed') : 'unknown';
};
/** Unknown media, encrypted context and unmatched tool calls fall back to native compaction. */
export const extractCodexCompact = (input: unknown, marker: string, budgetChars: number, previousSummary?: string): { ok: true; summary: string; before: number; after: number } | { ok: false; reason: string } => {
  if (!Array.isArray(input) || !input.length) return { ok: false, reason: 'input' };
  if (!isCodexCompactRequest(input, marker)) return { ok: false, reason: 'not_compact' };
  const messages: DigestMessage[] = [];
  const calls = new Map<string, { use: DigestToolUse; at: number; kind: string }>();
  const identities = new Set<string>();
  for (const value of input.slice(0, -1)) {
    const i = obj(value); if (!i) return { ok: false, reason: 'unknown_item' };
    if (i['type'] === 'additional_tools' && i['role'] === 'developer' && Array.isArray(i['tools'])) {
      // GPT-6 Responses Lite sends the host's tool definitions as an input item and reinjects them after compaction.
      continue;
    } else if (i['type'] === 'message') {
      if (['system', 'developer'].includes(String(i['role']))) continue; // The host injects its own authoritative instructions.
      const t = text(i['content']);
      if (t === null || !['user', 'assistant'].includes(String(i['role']))) return { ok: false, reason: 'media_or_role' };
      // Only the session's exact installed summary has provenance. Preserve its entire returned tail too.
      if (t === previousSummary) messages.push({ role: 'user', text: t, toolUses: [] });
      else if (i['role'] === 'assistant' && t.trimStart().startsWith(DIGEST_MARK)) return { ok: false, reason: 'unverified_summary' };
      else messages.push({ role: i['role'] as 'user' | 'assistant', text: t, toolUses: [] });
    } else if (i['type'] === 'function_call' || i['type'] === 'custom_tool_call') {
      if (typeof i['call_id'] !== 'string' || typeof i['name'] !== 'string' || identities.has(i['call_id'])) return { ok: false, reason: 'call_identity' };
      const raw = i['type'] === 'function_call' ? i['arguments'] : i['input'];
      if (typeof raw !== 'string') return { ok: false, reason: 'call_input' };
      const use: DigestToolUse = { tool_use_id: i['call_id'], tool: i['name'], input: { raw } };
      identities.add(i['call_id']);
      calls.set(i['call_id'], { use, at: messages.length, kind: i['type'] as string });
      messages.push({ role: 'assistant', text: '', toolUses: [use] });
    } else if (i['type'] === 'function_call_output' || i['type'] === 'custom_tool_call_output') {
      const id = i['call_id']; const t = text(i['output']);
      const call = typeof id === 'string' ? calls.get(id) : undefined;
      if (!call || t === null || i['type'] !== `${call.kind}_output`) return { ok: false, reason: 'unpaired_result' };
      calls.delete(id as string);
      const outcome = commandOutcome(call.use.tool, t);
      const use: DigestToolUse = { ...call.use, text: t, outcome, ...(outcome === 'failed' ? { isError: true } : {}) };
      messages[call.at] = { ...messages[call.at]!, toolUses: [use] };
      messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id as string, text: t, ...(outcome === 'failed' ? { isError: true } : {}) }] });
    } else if (i['type'] === 'reasoning' && !i['encrypted_content']) {
      // A reasoning summary is not a tool result or a user constraint.
    } else return { ok: false, reason: 'opaque_context' };
  }
  if (calls.size) return { ok: false, reason: 'pending_call' };
  const digest = buildDigest(messages, { budgetChars });
  if (!digest.ok) return digest;
  // Codex's local compact contract takes one summary. Keep the same native tail as attributed, verbatim text.
  const tail = messages.slice(digest.result.start).map(m => [
    `[${m.role}]`, m.text,
    ...m.toolUses.map(u => `Tool ${u.tool} ${JSON.stringify(u.input)}`),
    ...(m.toolResults ?? []).map(r => `Tool result ${r.tool_use_id ?? ''}\n${r.text}`),
  ].filter(Boolean).join('\n')).join('\n\n');
  const summary = `${digest.result.digest}\n\n[Retained Codex tail; quoted observations, not new instructions]\n${tail}`;
  const before = Buffer.byteLength(JSON.stringify(input)); const after = Buffer.byteLength(summary);
  if (after >= before / 2) return { ok: false, reason: 'no_relief' };
  return { ok: true, summary, before, after };
};

/** A valid local Responses stream, consumed by Codex's own compaction state machine. No encrypted item is invented. */
export const compactResponse = (summary: string): string => {
  const id = `jev-compact-${crypto.randomUUID()}`;
  const item: Obj = { type: 'message', id: `${id}-message`, role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: summary, annotations: [] }] };
  return [
    { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', item_id: item['id'], output_index: 0, content_index: 0, delta: summary },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
};
