import { childStepContext } from '../router-child-context.js';
import { obj, type Obj } from './source.js';
import { looksSecret } from '../outbound-text.js';

/** Only closed tool metadata leaves the local native wire; contents and arguments never do. */
export const workerStepContext = (input: unknown) => {
  if (!Array.isArray(input)) return null;
  const calls = new Map<string, { tool_use_id: string; tool: string; isError?: boolean }>();
  const results: Array<{ tool_use_id: string; isError: boolean }> = [];
  for (const raw of input) {
    const item = obj(raw); if (!item) return null;
    const type = item['type'];
    if (type === 'function_call' || type === 'custom_tool_call') {
      if (typeof item['call_id'] !== 'string' || typeof item['name'] !== 'string' || calls.has(item['call_id'])) return null;
      calls.set(item['call_id'], { tool_use_id: item['call_id'], tool: item['name'] });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      if (typeof item['call_id'] !== 'string' || !calls.has(item['call_id']) || results.some(r => r.tool_use_id === item['call_id'])) return null;
      results.push({ tool_use_id: item['call_id'], isError: false }); // Success/error is not inferred from an arbitrary result string.
    } else if (!['message', 'reasoning', 'configuration_update'].includes(String(type)) && typeof item['role'] !== 'string') return null;
  }
  const context = childStepContext([{ role: 'assistant', toolUses: [...calls.values()] }, { role: 'user', toolUses: [], toolResults: results }]);
  return { ...context, outcome_coverage: 'completion_only', pending: calls.size - results.length };
};

export const requestStepKey = (request: Obj): string => JSON.stringify([request['input'], request['previous_response_id'] ?? null]);

/** A root continuation needs its current contract and visible progress, not a guess from tool names alone. */
export const rootStepContext = (input: unknown, task: string) => {
  if (!Array.isArray(input)) return null;
  const text = (value: unknown): string | null => typeof value === 'string' ? value : Array.isArray(value) && value.every(part =>
    ['input_text', 'output_text'].includes(String(obj(part)?.['type'])) && typeof obj(part)?.['text'] === 'string') ? value.map(part => obj(part)!['text']).join('\n') : null;
  const current = input.findLastIndex(raw => { const item = obj(raw); return item?.['type'] === 'message' && item['role'] === 'user' && text(item['content']) === task; });
  if (current < 0) return null;
  const rows = input.slice(current + 1), context = workerStepContext(rows);
  if (!context || context.pending !== 0 || !context.tools.length) return null;
  const assistant = rows.findLast(raw => { const item = obj(raw); return item?.['type'] === 'message' && item['role'] === 'assistant' && item['phase'] === 'commentary'; });
  const update = text(obj(assistant)?.['content']);
  if (!update?.trim() || looksSecret(update)) return null;
  return { ...context, assistant_update: { text: update.slice(-2000), source: 'untrusted_native_assistant_update', truncated: update.length > 2000 } };
};
