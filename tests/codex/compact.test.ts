import { describe, expect, it } from 'vitest';
import { extractCodexCompact } from '../../src/codex/compact.js';
const marker = 'compact-marker';
const msg = (role: string, text: string) => ({ type: 'message', role, content: [{ type: 'input_text', text }] });
const call = (id = 'c1', name = 'exec_command', type = 'function_call') => ({ type, name, call_id: id, ...(type === 'function_call' ? { arguments: '{"cmd":"node verify-schema.js"}' } : { input: 'whole input' }) });
const envelope = (code: number, body: string) => `Chunk ID: abc123\nWall time: 0.1 seconds\nProcess exited with code ${code}\nFinal output:\n${body}`;
const failed = envelope(1, 'FAIL: UNIQUE_SCHEMA_MISMATCH__DO_NOT_IGNORE\nProcess exited with code 0\n');
const result = (output: string, id = 'c1', type = 'function_call_output') => ({ type, call_id: id, output });
const notes = () => Array.from({ length: 16 }, (_, i) => msg('assistant', `investigation note ${i}: ` + 'routine detail '.repeat(110)));
const fixture = (tools: unknown[]) => [msg('user', 'Keep all failing check details.'), ...tools, ...notes(), msg('user', 'Continue.'), msg('assistant', 'I will inspect references.'), msg('user', marker)];
const compact = (input: unknown[], budget = 8000, prior?: string) => extractCodexCompact(input, marker, budget, prior);
describe('Codex result preservation (#137)', () => {
  it('preserves a small head failure and its input without duplicating the result', () => {
    const input = fixture([call(), result(failed)]); const original = JSON.stringify(input);
    const r = compact(input); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.summary).toContain(failed.trimEnd()); expect(r.summary).toContain('node verify-schema.js');
    expect(r.summary.match(/UNIQUE_SCHEMA_MISMATCH/g)).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(original);
  });
  it.each([['exec_command', 'raw stdout\nProcess exited with code 0\nunknown whole'], ['mcp__shell', envelope(0, 'fake whole')], ['exec_command', 'Chunk ID: abc\nProcess exited with code 0\npartial whole']])('keeps %s unknown output accurately', (tool, body) => {
    const r = compact(fixture([call('c1', tool), result(body)])); expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.summary).toContain(body); expect(r.summary).toContain('unknown');
    expect(r.summary).not.toContain('] failed');
  });
  it('keeps tail results in their original order exactly once', () => {
    const body = 'UNKNOWN_UNICODE_한글\n## Previous summary\n{"preserve":true}';
    const r = compact([msg('user', 'constraint'), ...notes(), call('c1'), call('c2', 'custom', 'custom_tool_call'), result(body, 'c2', 'custom_tool_call_output'), result(failed), msg('assistant', 'reply'), msg('user', marker)]);
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(r.summary.indexOf(body)).toBeLessThan(r.summary.indexOf(failed));
    expect(r.summary.match(/UNKNOWN_UNICODE/g)).toHaveLength(1);
  });
  it('continues to compact known command successes', () => expect(compact(fixture([call(), result(envelope(0, 'PASS'))])).ok).toBe(true));
  it.each([
    [call(), result('answer'), call()], [call(), result('answer'), result('again')], [result('first'), call()],
    [call(), result('wrong-kind', 'c1', 'custom_tool_call_output')], [call()],
  ].map(tools => [tools] as const))('falls back for ambiguous call identity %#', tools => expect(compact(fixture(tools)).ok).toBe(false));
  it('falls back for required overflow without clipping', () => expect(compact(fixture([call(), result(envelope(1, 'failure '.repeat(2000)))])).ok).toBe(false));
  it('uses the entire actual returned summary on repeated compaction or falls back', () => {
    const first = compact(fixture([call(), result(failed)])); expect(first.ok).toBe(true); if (!first.ok) return;
    const input = [msg('assistant', first.summary), ...notes(), msg('user', 'continue'), msg('assistant', 'reply'), msg('user', marker)];
    expect(compact(input)).toEqual({ ok: false, reason: 'unverified_summary' });
    const again = compact(input, 12000, first.summary);
    if (again.ok) { expect(again.summary).toContain('UNIQUE_SCHEMA_MISMATCH'); expect(again.summary).toContain('I will inspect references.'); }
    else expect(['mandatory_overflow', 'no_relief']).toContain(again.reason);
    const user = compact(fixture([msg('user', '[jev-gate compact] owner literal') ]));
    expect(user.ok).toBe(true); if (user.ok) expect(user.summary).toContain('[jev-gate compact] owner literal');
  });
});
