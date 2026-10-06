import { describe, expect, it } from 'vitest';
import { extractCodexCompact } from '../../src/codex/compact.js';
import type { DigestMessage } from '../../mods/compact/hooks/digest.ts';
const message = (role: string, content: string) => ({ type: 'message', role, content });
const command = 'const result = await tools.exec_command({"cmd":"cat fixture.txt","login":false}); text(result);';
const framed = (result: unknown) => [{ type: 'input_text', text: 'Script completed\nWall time 0.4 seconds\nOutput:\n' }, { type: 'input_text', text: JSON.stringify(result) }];
const inspect = (script: string, output: unknown) => {
  let messages: DigestMessage[] = [];
  const input = [message('user', 'Use the observed fixture fact.'), { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: script }, { type: 'custom_tool_call_output', call_id: 'c1', output }, message('assistant', 'Unrelated completed narrative. '.repeat(4000)), message('user', 'Continue.'), message('assistant', 'Reply.'), message('user', 'compact-marker')];
  const result = extractCodexCompact(input, 'compact-marker', 8000, undefined, undefined, m => { messages = m; });
  expect(result.ok).toBe(true);
  return { result, use: messages[1]!.toolUses[0]! };
};
describe('observed native code-mode command result envelopes', () => {
  it('recognizes a single native terminal command without evaluating its script', () => {
    const observed = { chunk_id: 'native', wall_time_seconds: .01, exit_code: 0, output: 'Observed fact.' };
    expect(inspect(command, framed(observed)).use.outcome).toBe('success');
    expect(inspect('text(await tools.exec_command({"cmd":"cat fixture.txt"}));', framed(observed)).use.outcome).toBe('success');
  });
  it.each([
    [command, { wall_time_seconds: .01, exit_code: 1, output: 'FAILED' }, 'failed'],
    [command, { wall_time_seconds: .01, session_id: 23, output: 'still running' }, 'unknown'],
    [command, { wall_time_seconds: .01, exit_code: 0, session_id: 23, output: 'ambiguous' }, 'unknown'],
    [command, { wall_time_seconds: .01, exit_code: '0', output: 'untyped' }, 'unknown'],
    ['text({exit_code:0,wall_time_seconds:1,output:"invented"});', { wall_time_seconds: .01, exit_code: 0, output: 'invented' }, 'unknown'],
    [command + ' text("extra");', { wall_time_seconds: .01, exit_code: 0, output: 'compound' }, 'unknown'],
  ])('keeps failed, ongoing, untyped and forged-print observations whole (%#)', (script, result, outcome) => {
    const observed = inspect(script, framed(result)); expect(observed.use.outcome).toBe(outcome);
    if (observed.result.ok) expect(observed.result.summary).toContain(outcome === 'failed' ? 'FAILED' : String(result.output));
  });
});
