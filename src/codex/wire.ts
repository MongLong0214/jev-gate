import { createHash } from 'node:crypto';
import { obj, type Obj } from './source.js';

const text = (v: unknown): string | null => typeof v === 'string' ? v : Array.isArray(v) && v.every(p => ['input_text', 'output_text'].includes(String(obj(p)?.['type'])) && typeof obj(p)?.['text'] === 'string') ? v.map(p => obj(p)!['text']).join('\n') : null;
/** Only the complete plaintext input actually sent by Codex can be a Lean source. Opaque/incremental context stays native. */
export const wireSource = (input: unknown, task: string, prompt: string): { items: Obj[]; complete: boolean } => {
  if (!Array.isArray(input) || Buffer.byteLength(JSON.stringify(input)) > 8 * 1024 * 1024) return { items: [], complete: false };
  const items: Obj[] = []; const pending = new Map<string, Obj>(); let own = false;
  const current = input.findLastIndex(v => { const item = obj(v); return item?.['type'] === 'message' && item['role'] === 'user' && text(item['content']) === task; });
  for (let at = 0; at < input.length; at++) {
    const item = obj(input[at]); if (!item) return { items: [], complete: false };
    // Native serialization changes message ids, content types and phase fields between responses.
    // Bind the prefix to the source facts, not those transport details or injected developer messages.
    const identify = (facts: unknown): string => `wire-${items.length}-${createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 20)}`;
    if (item['type'] === 'additional_tools' && item['role'] === 'developer') continue;
    if (item['type'] === 'message') {
      const body = text(item['content']); if (body === null) return { items: [], complete: false };
      const id = identify({ role: item['role'], text: body });
      if (item['role'] === 'user') { const submitted = at === current; own ||= submitted; items.push({ id, type: 'userMessage', content: [{ type: 'text', text: body }], ...(submitted ? { clientId: prompt } : {}) }); }
      else if (item['role'] === 'assistant') items.push({ id, type: 'agentMessage', text: body, ...(typeof item['phase'] === 'string' ? { phase: item['phase'] } : {}) });
      else if (!['developer', 'system'].includes(String(item['role']))) return { items: [], complete: false };
    } else if (item['type'] === 'function_call' || item['type'] === 'custom_tool_call') {
      if (typeof item['call_id'] !== 'string' || pending.has(item['call_id'])) return { items: [], complete: false };
      pending.set(item['call_id'], item);
    } else if (item['type'] === 'function_call_output' || item['type'] === 'custom_tool_call_output') {
      if (typeof item['call_id'] !== 'string' || !pending.has(item['call_id']) || text(item['output']) === null) return { items: [], complete: false };
      const rawCall = pending.get(item['call_id'])!;
      const call = { type: rawCall['type'], call_id: rawCall['call_id'], name: rawCall['name'], ...(rawCall['namespace'] ? { namespace: rawCall['namespace'] } : {}), ...(rawCall['type'] === 'function_call' ? { arguments: rawCall['arguments'] } : { input: rawCall['input'] }) };
      const facts = { call, text: text(item['output']) };
      items.push({ id: identify(facts), type: 'functionCallOutput', callId: item['call_id'], ...facts, status: 'completed' });
      pending.delete(item['call_id']);
    } else if (item['type'] !== 'reasoning' || item['encrypted_content']) return { items: [], complete: false };
  }
  return { items, complete: own && pending.size === 0 };
};
