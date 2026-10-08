import { childStepContext } from '../router-child-context.js';
import { obj, type Obj } from './source.js';

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
