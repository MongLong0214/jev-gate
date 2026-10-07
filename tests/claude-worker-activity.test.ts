import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeWorkerActivityReader } from '../src/claude-worker-activity.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
const start = '2026-10-07T05:27:20.000Z', end = '2026-10-07T05:27:21.000Z';
const now = new Date('2026-10-07T05:27:22.000Z');
const dispatch = { host: 'claude', phase: 'dispatch', session_id: 'session', tool_use_id: 'parent', role: 'worker', task_id: 't1', written_at: start };
const launch = { host: 'claude', phase: 'background_launch', session_id: 'session', agent_id: 'agent', tool_use_id: 'parent', execution_prompt_id: 'prompt', requested_model: 'claude-opus-5-5', written_at: start };
const row = (type: string, content: unknown[], at = start) => ({ type, agentId: 'agent', sessionId: 'session', cwd: '/project', timestamp: at, message: { content } });
function fixture(rows: unknown[]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jev-worker-activity-'))); roots.push(home);
  const dir = join(home, '.claude/projects/project/session/subagents'); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'agent-agent.jsonl'); writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { home, path, dir, env: { HOME: home }, reader: new ClaudeWorkerActivityReader() };
}
describe('local Claude worker activity', () => {
  it('tracks a child Jev request and an ordinary child tool, and preserves omitted effort', () => {
    const f = fixture([row('assistant', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'src/app.ts' } }])]);
    const records = [{ phase: 'mod_router', session_id: 'session', agent_id: 'agent', event: 'request', scope: 'child', index: 1, turn: 'child', written_at: start }];
    expect(f.reader.read(records, f.env, now).items[0]).toMatchObject({ state: 'active', jevRequestAt: start, jevResponseAt: null });
    records.push({ ...records[0]!, event: 'child_route', written_at: end });
    const result = f.reader.read([...records, { ...records[0], event: 'model_request', requested: 'claude-haiku-4-5', requested_effort: null, written_at: end }, { ...records[0], event: 'child_result', written_at: end }], f.env, now).items[0];
    expect(result).toMatchObject({ state: 'active', selectedModel: 'claude-haiku-4-5', selectedEffort: null, jevResponseAt: end, tools: [{ state: 'active' }] });
  });
  it('pairs actual tools and results, separates errors and excludes payloads and secrets', () => {
    const f = fixture([
      row('user', [{ type: 'text', text: 'SECRET PROMPT' }]),
      row('assistant', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/project/src/app.ts', secret: 'SECRET INPUT' } }, { type: 'thinking', thinking: 'SECRET THOUGHT' }]),
      row('user', [{ type: 'tool_result', tool_use_id: 'read', content: 'SECRET SOURCE', is_error: false }], end),
      row('assistant', [{ type: 'tool_use', id: 'test', name: 'Bash', input: { command: 'npm test --token sk-SECRET', description: 'SECRET DESCRIPTION' } }], end),
      row('user', [{ type: 'tool_result', tool_use_id: 'test', content: 'SECRET OUTPUT', is_error: true }], end),
    ]);
    const view = f.reader.read([launch, dispatch], f.env, now);
    expect(view.items[0]).toMatchObject({ role: 'worker', taskId: 't1', state: 'active', selectedModel: 'claude-opus-5-5', coverage: 'complete' });
    expect(view.items[0]?.tools).toEqual([
      expect.objectContaining({ id: 'read', action: 'read', target: 'src/app.ts', state: 'done', durationMs: 1000 }),
      expect.objectContaining({ id: 'test', action: 'test', target: null, state: 'error' }),
    ]);
    expect(JSON.stringify(view)).not.toMatch(/SECRET|npm test|sk-/);
  });
  it('updates when only the transcript is appended and does not treat an incomplete append as success', () => {
    const f = fixture([row('assistant', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '.env' } }])]);
    const first = f.reader.read([dispatch, launch], f.env, now);
    expect(first.items[0]?.tools[0]).toMatchObject({ target: null, state: 'active' });
    appendFileSync(f.path, '{"type":"user"');
    expect(f.reader.read([dispatch, launch], f.env, now).items[0]?.tools[0]?.state).toBe('active');
    appendFileSync(f.path, '\n' + JSON.stringify(row('user', [{ type: 'tool_result', tool_use_id: 'read', is_error: false }], end)) + '\n');
    const next = f.reader.read([dispatch, launch], f.env, now);
    expect(next.sig).not.toBe(first.sig); expect(next.items[0]?.tools[0]?.state).toBe('done');
    expect(next.items[0]?.coverage).toBe('recent');
  });
  it('uses recorded termination rather than a completed tool or elapsed time', () => {
    const f = fixture([row('assistant', [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }])]);
    expect(f.reader.read([dispatch, launch], f.env, new Date('2026-10-07T06:00:00Z')).items[0]?.state).toBe('unknown');
    const result = f.reader.read([dispatch, launch, { phase: 'background_terminal', session_id: 'session', tool_use_id: 'parent', status: 'completed', written_at: end }], f.env, now);
    expect(result.items[0]).toMatchObject({ state: 'completed', tools: [expect.objectContaining({ state: 'unconfirmed' })] });
  });
  it('keeps model request failures separate from received responses', () => {
    const f = fixture([]);
    const view = f.reader.read([dispatch, launch,
      { ...launch, phase: 'mod_router', event: 'model_request', requested_effort: 'high' },
      { ...launch, phase: 'mod_router', event: 'model_failure', written_at: end }], f.env, now);
    expect(view.items[0]).toMatchObject({ modelRequestAt: start, modelResponseAt: null, modelFailureAt: end, observedModel: null, selectedEffort: 'high' });
  });
  it('does not correlate another session and exposes only safely resolved watch directories', () => {
    const f = fixture([{ ...row('assistant', [{ type: 'tool_use', id: 'wrong', name: 'Read', input: {} }]), sessionId: 'other' }]);
    expect(f.reader.directories()).toEqual([]);
    expect(f.reader.read([dispatch, launch], f.env, now).items[0]).toMatchObject({ coverage: 'recent', tools: [] });
    expect(f.reader.directories()).toEqual([f.dir]);
    f.reader.read([], f.env, now); expect(f.reader.directories()).toEqual([]);
  });
  it.each(['file', 'directory', 'missing'])('reports unavailable records for a %s without following links', kind => {
    const f = fixture([]);
    if (kind === 'directory') { rmSync(f.dir, { recursive: true }); symlinkSync('/Users', f.dir); }
    else { rmSync(f.path); if (kind === 'file') symlinkSync('/etc/passwd', f.path); }
    expect(f.reader.read([dispatch, launch], f.env, now).items[0]).toMatchObject({ coverage: 'unavailable', tools: [] });
  });
  it('bounds large transcripts, marks partial coverage and never reads Codex agents as Claude', () => {
    const f = fixture([row('user', [{ type: 'text', text: 'x'.repeat(1_100_000) }]), row('assistant', [{ type: 'tool_use', id: 'tool', name: 'Write', input: { file_path: '/project/a.ts' } }], end)]);
    expect(f.reader.read([dispatch, launch], f.env, now).items[0]).toMatchObject({ coverage: 'recent', tools: [expect.objectContaining({ action: 'write' })] });
    expect(f.reader.read([{ ...launch, host: 'codex' }], f.env, now).items).toEqual([]);
  });
  it('offers full metadata history beyond both the live byte and tool limits, with stable chronological pages', async () => {
    const first = row('assistant', [{ type: 'tool_use', id: 'early', name: 'Read', input: { file_path: '/project/첫번째.ts' } }]);
    const rows = [first, row('user', [{ type: 'tool_result', tool_use_id: 'early', content: 'SECRET '.repeat(160000) }], end)];
    for (let i = 0; i < 120; i++) rows.push(row('assistant', [{ type: 'tool_use', id: 'tool'+i, name: 'Read', input: {} }], end), row('user', [{ type: 'tool_result', tool_use_id: 'tool'+i, is_error: i === 119 }], end));
    const f = fixture(rows);
    expect(f.reader.read([dispatch, launch], f.env, now).items[0]?.tools).toHaveLength(40);
    const firstPage = await f.reader.history('session', 'agent', 0, f.env, now);
    expect(firstPage).toMatchObject({ coverage: 'complete', total: 121, next: 100, skippedRows: 0 });
    expect(firstPage?.tools[0]).toMatchObject({ id: 'early', state: 'done', target: '첫번째.ts' });
    const next = await f.reader.history('session', 'agent', 100, f.env, now);
    expect(next?.tools).toHaveLength(21); expect(next?.next).toBeNull(); expect(next?.tools.at(-1)?.state).toBe('error');
    expect(JSON.stringify([firstPage, next])).not.toContain('SECRET');
    appendFileSync(f.path, JSON.stringify(row('assistant', [{ type: 'tool_use', id: 'new', name: 'Write', input: {} }], end))+'\n');
    expect((await f.reader.history('session', 'agent', 100, f.env, now))?.total).toBe(122);
  });
  it('lists agents outside the live limit without probing arbitrary identities or following a history symlink', async () => {
    const f = fixture([]);
    const records = Array.from({ length: 65 }, (_, i) => ({ ...launch, agent_id: 'agent'+i }));
    records.push(launch);const live=f.reader.read(records, f.env, now);expect(live.items).toHaveLength(66);expect(live.limited).toBe(false);
    expect(f.reader.list(0, now)).toMatchObject({ total: 66, next: 50 });
    expect(f.reader.list(50, now).items).toHaveLength(16);
    expect(await f.reader.history('../other', 'agent', 0, f.env, now)).toBeNull();
    rmSync(f.path); symlinkSync('/etc/passwd', f.path);
    expect(await f.reader.history('session', 'agent', 0, f.env, now)).toMatchObject({ coverage: 'unavailable', tools: [] });
  });
  it('preserves each native model response across tools and deduplicates streamed blocks without copying payloads', async () => {
    const response=(id:string,model:string,content:unknown[],at=start)=>({...row('assistant',content,at),message:{id,model,content}});
    const f=fixture([response('reply1','claude-opus-5-5',[{type:'thinking',thinking:'SECRET THOUGHT'}]),response('reply1','claude-opus-5-5',[{type:'tool_use',id:'read',name:'Read',input:{file_path:'src/app.ts'}}],end),response('reply2','claude-sonnet-5',[{type:'text',text:'SECRET RESPONSE'}],end)]);
    f.reader.read([dispatch,launch],f.env,now);
    const history=await f.reader.history('session','agent',0,f.env,now);
    expect(history?.models).toEqual([{id:'reply1',at:start,model:'claude-opus-5-5',tools:['read']},{id:'reply2',at:end,model:'claude-sonnet-5',tools:[]}]);
    expect(JSON.stringify(history)).not.toContain('SECRET');expect(history?.worker.callId).toBe('parent');
  });
  it('reports malformed and unfinished history as partial evidence and can cancel a scan', async () => {
    const f = fixture([row('assistant', [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }])]);
    appendFileSync(f.path, '{invalid}\n{"unfinished"'); f.reader.read([dispatch, launch], f.env, now);
    expect(await f.reader.history('session', 'agent', 0, f.env, now)).toMatchObject({ coverage: 'recent', skippedRows: 1, total: 1 });
    appendFileSync(f.path, '\n'); const controller = new AbortController(); controller.abort();
    expect(await f.reader.history('session', 'agent', 0, f.env, now, controller.signal)).toBeNull();
  });
});
