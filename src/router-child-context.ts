/** Native conversation shape. Arguments, results, source and thinking are deliberately not routing input. */
export interface ChildMessage {
  role: 'user' | 'assistant';
  toolUses: readonly { tool_use_id: string; tool: string; text?: string; isError?: boolean }[];
  toolResults?: readonly { tool_use_id: string; isError: boolean }[];
}
export interface ChildStepContext {
  messages: number;
  coverage: 'recent' | 'available';
  tools: { name: string; state: 'pending' | 'done' | 'error' }[];
}

/** Only closed outcome labels and validated tool names leave the host conversation adapter. */
export const childStepContext = (rows: readonly ChildMessage[]): ChildStepContext => {
  const results = new Map<string, boolean>();
  for (const row of rows) for (const result of row.toolResults ?? []) results.set(result.tool_use_id, result.isError);
  const tools: ChildStepContext['tools'] = [];
  for (const row of rows) for (const use of row.toolUses) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(use.tool)) continue;
    const answered = results.has(use.tool_use_id) || use.text !== undefined;
    tools.push({ name: use.tool, state: use.isError || results.get(use.tool_use_id) ? 'error' : answered ? 'done' : 'pending' });
  }
  return { messages: rows.length, coverage: rows.length >= 4096 ? 'recent' : 'available', tools: tools.slice(-12) };
};
