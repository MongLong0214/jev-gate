import { describe, expect, it } from 'vitest';
import { wireSource } from '../../src/codex/wire.js';
import { codexSource } from '../../src/codex/source.js';

const message = (role: string, text: string) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
describe('actual native request source', () => {
  it('keeps stable provenance when native transport ids, phase and content encoding change', () => {
    const previous = wireSource([message('user', 'prior'), { ...message('assistant', 'old answer'), id: 'response-message', phase: 'final_answer' }], 'prior', 'old');
    const current = wireSource([message('developer', 'new hook guidance'), message('user', 'prior'), { ...message('assistant', 'old answer'), id: 'next-input-message', content: [{ type: 'input_text', text: 'old answer' }] }, message('user', 'current')], 'current', 'new');
    const before = codexSource(previous.items.map(({ clientId: _old, ...v }) => v), { sessionId: 's', promptId: 'new', request: 'current', phase: 'prompt' }, 'wire', true);
    const after = codexSource(current.items, { sessionId: 's', promptId: 'new', request: 'current', phase: 'dispatch' }, 'wire', current.complete);
    expect(before.ok && after.ok && before.source.prefixDigest === after.source.prefixDigest).toBe(true);
  });
  it('binds repeated identical prompts to the last native user input', () => {
    const result = wireSource([message('user', 'same'), message('assistant', 'prior'), message('user', 'same')], 'same', 'current');
    expect(result.complete).toBe(true);
    expect(result.items.filter(i => i['clientId'])).toEqual([expect.objectContaining({ clientId: 'current', id: expect.stringContaining('wire-2-') })]);
  });
  it('retains the original tool arguments together with the completed result', () => {
    const call = { type: 'function_call', name: 'exec_command', call_id: 'c', arguments: '{"cmd":"vitest run"}' };
    const result = wireSource([call, { type: 'function_call_output', call_id: 'c', output: 'exit 1' }, message('user', 'task')], 'task', 'p');
    expect(result.complete).toBe(true);
    expect(result.items[0]).toMatchObject({ call, text: 'exit 1', status: 'completed' });
  });
  it.each([{ type: 'reasoning', encrypted_content: 'opaque' }, { type: 'function_call', call_id: 'pending' }, { type: 'message', role: 'user', content: [{ type: 'input_image' }] }, { type: 'function_call_output', call_id: 'orphan', output: 'pass' }])('does not hide incomplete or unsupported source (%#)', extra => expect(wireSource([extra, message('user', 'task')], 'task', 'p').complete).toBe(false));
});
