import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { activityChecks } from '../../src/doctor-activity.js';
import { loadActivity } from '../../src/activity.js';
import { CodexRpc } from '../../src/codex/rpc.js';
import { CodexPolicy } from '../../src/codex/policy.js';
import type { Obj } from '../../src/codex/source.js';
import { routedExecution } from '../../src/codex/execution-efficiency.js';
import { startCodexSession } from '../../src/codex/launch.js';
const dir = mkdtempSync(join(tmpdir(), 'router-integration-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// Documented roles make A -> B an upgrade. Unknown prices do not veto either direction.
const catalog = [
  { model: 'fixture-A', description: 'Fast and affordable model for easier tasks.', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
  { model: 'fixture-B', description: 'Latest workhorse model for coding and everyday work.', supportedReasoningEfforts: ['low', 'high', 'max'].map(reasoningEffort => ({ reasoningEffort })) },
];
const config = join(dir, 'policy.json');
const saveConfig = (router: Obj = {}) => writeFileSync(config, JSON.stringify({ gate: { mode: 'off' }, router: { timeoutMs: 2000, ...router } }));
const answers = (req: Obj, model: string, effort: string) => Object.fromEntries(Object.entries(req['questions'] as Record<string, {type:string;criteria:Record<string,string>|string[]}>).map(([k,q]) => {
  // Keeping is the fixture root's own role: its baseline is fixture-A.
  const pick = k === 'model' ? model : k === 'capability' ? ({ 'gpt-6-luna': 'mechanical', 'gpt-6.1-sol': 'complex', 'gpt-6.1-terra': 'routine', 'fixture-A': 'mechanical', 'fixture-B': 'complex', __keep__: 'mechanical' } as Record<string, string>)[model]! : k === 'control' ? 'task_clear' : 'ordinary';
  const prefix = ({ none: 'No reasoning', low: 'Light', medium: 'Ordinary', high: 'Strong', xhigh: 'Exceptional', max: 'Maximum', ultra: 'Exhaustive' } as Record<string, string>)[effort]!;
  return [k, q.type === 'choice' ? {type:'choice',choice:pick,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(v=>[v,v===pick?1:0]))} :
    {type:'score',probabilities:Object.fromEntries((q.criteria as string[]).map((v,i)=>[i,v.startsWith(prefix) ? 1 : 0]))}];
}));
const fixture = async (external: boolean, model: string, effort: string, wait?: Promise<void>) => {
  saveConfig(); const sent: Obj[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)); sent.push(req); if (wait) await wait;
    return new Response(JSON.stringify({ model:req.model, answers:answers(req,model,effort) }), {headers:{'content-type':'application/json'}});
  });
  const rpc = new CodexRpc(new PassThrough(), new PassThrough());
  const forward = vi.spyOn(rpc, 'forward').mockImplementation(() => {});
  const emitted = vi.spyOn(rpc, 'emit').mockImplementation(() => {});
  const policy = new CodexPolicy(rpc, {JEV_CODEX_CONFIG:config,TYPESAFE_API_KEY:'fixture-key',JEV_CODEX_TRACE_DIR:join(dir,'trace'),JEV_GATE_STATE_DIR:join(dir,'state')}, fetchImpl as typeof fetch);
  policy.catalog = catalog; policy.catalogComplete = true;
  if (external) {
    await policy.externalHook({hook_event_name:'SessionStart',session_id:'root',cwd:dir,model:'fixture-A'});
    await policy.externalHook({hook_event_name:'UserPromptSubmit',session_id:'root',turn_id:'prompt',prompt:'Implement the fixture.'});
  } else await rpc.onResponse({model:'fixture-A',reasoningEffort:'high',cwd:dir,thread:{id:'root'}},'thread/start',{});
  const request = {model:'fixture-A',reasoning:{effort:'high',summary:'auto'},input:[{role:'user',content:'Implement the fixture.'}],tools:[{type:'function',name:'original'}],metadata:{original:true}};
  const start = {id:1,method:'turn/start',params:{threadId:'root',clientUserMessageId:'prompt',model:'fixture-A',effort:'high',input:[{type:'text',text:'Implement the fixture.'}],collaborationMode:{mode:'default',settings:{model:'fixture-A',reasoning_effort:'high',developer_instructions:'preserve'}}}};
  return {rpc,policy,forward,emitted,fetchImpl,sent,request,start};
};
const ownedFixture = async (wait?: Promise<void>) => {
  const f = await fixture(false, 'gpt-6.1-sol', 'low', wait);
  f.policy.catalog = [
    { model: 'gpt-6.1-sol', description: 'Latest workhorse model for coding and everyday work.', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
    { model: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
  ];
  const parent = f.policy.sessions.get('root')!, signal = new AbortController();
  const child = { ...parent, id: 'owned-child', prompt: 'parent-prompt', role: 'jev-gate:worker', parent: 'root',
    dispatch: { parent, prompt: 'parent-prompt', tool: 'dispatch', input: { prompt: 'Keep the contract. Investigate, edit and verify.' }, signal: signal.signal, worktree: null, startedAt: Date.now(), attempted: true } };
  f.policy.sessions.set(child.id, child);
  const first = { ...f.request, model: 'gpt-6-luna' };
  await f.policy.externalRequest(child.id, first, signal.signal);
  const next = { ...first, input: [...first.input, { type: 'function_call', call_id: 'exact-tool', name: 'exec_command', arguments: '{}' }, { type: 'function_call_output', call_id: 'exact-tool', output: 'ok' }] };
  return { ...f, child, signal, next };
};
const nativeBillingFixture = async (wait?: Promise<void>) => {
  const f = await fixture(true, 'gpt-6-luna', 'low', wait);
  f.policy.catalog = [
    { model: 'gpt-6.1-sol', description: 'Latest workhorse model for coding and everyday work.', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
    { model: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
  ];
  return { ...f, request: { ...f.request, model: 'gpt-6.1-sol' } };
};
const rootContinuationFixture = async (wait?: Promise<void>) => {
  const f = await nativeBillingFixture(), signal = new AbortController();
  f.fetchImpl.mockImplementation(async (_url, init) => {
    const req = JSON.parse(String(init?.body)); f.sent.push(req);
    if (f.sent.length > 1 && wait) await wait;
    return new Response(JSON.stringify({ model: req.model, answers: answers(req, f.sent.length === 1 ? 'gpt-6-luna' : 'gpt-6.1-sol', 'low') }), { headers: { 'content-type': 'application/json' } });
  });
  const first = { ...f.request, input: [{ type: 'message', role: 'user', content: 'Implement the fixture.' }] };
  await f.policy.externalRequest('root', first, signal.signal, 'codex-tui', 'chatgpt');
  const next = { ...first, input: [...first.input,
    { type: 'reasoning', id: 'native-reasoning', encrypted_content: 'opaque-reasoning-canary', summary: [] },
    { type: 'message', role: 'assistant', phase: 'commentary', content: 'A conflicting invariant now requires redesigning the algorithm.' },
    { type: 'function_call', call_id: 'check', name: 'exec_command', arguments: 'private-arguments-canary' },
    { type: 'function_call_output', call_id: 'check', output: 'private-results-canary' }] };
  return { ...f, first, next, signal };
};
describe('native Codex model routing', () => {
  it.each(['fixture-A', 'gpt-6.1-terra', 'gpt-6-luna'])('submits pre-applied %s and guidance through HTTP (#399)', async target => {
    const f = await fixture(false, target, 'low'), root = mkdtempSync(join(tmpdir(), 'managed-guidance-'));
    const baseline = target === 'fixture-A' ? target : 'gpt-6.1-sol';
    const available = target === 'fixture-A' ? catalog : [baseline, 'gpt-6.1-terra', 'gpt-6-luna'].map(model => ({ model,
      supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) }));
    const forwarded: Obj[] = [];
    const upstream = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += String(chunk); forwarded.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'local-response', status: 'completed', model: target, output: [], usage: { input_tokens: 42, output_tokens: 3 } }));
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
    writeFileSync(join(root, 'codex'), `#!${process.execPath}\nimport{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='model/list'?{data:[],nextCursor:null}:{}})+'\\n')});\n`, { mode: 0o755 });
    const trace = join(root, 'trace');
    const gateway = await startCodexSession({ cwd: root, fetchImpl: f.fetchImpl as typeof fetch, connection: { token: 'g'.repeat(64), port: 0 }, env: {
      HOME: root, PATH: root, TYPESAFE_API_KEY: 'fixture-key', JEV_CODEX_CONFIG: config, JEV_CODEX_TRACE_DIR: trace, JEV_GATE_STATE_DIR: join(root, 'state'), JEV_CODEX_UPSTREAM: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    } });
    try {
      gateway.policy.catalog = available; gateway.policy.catalogComplete = true;
      await gateway.rpc.onResponse({ model: baseline, reasoningEffort: 'high', cwd: root, thread: { id: 'root' } }, 'thread/start', {});
      const forward = vi.spyOn(gateway.rpc, 'forward').mockImplementation(() => {});
      const start = { ...f.start, params: { ...f.start.params, model: baseline, collaborationMode: { mode: 'default', settings: { model: baseline, reasoning_effort: 'high' } } } };
      await gateway.policy.client(start);
      expect(forward.mock.calls[0]?.[0]).toMatchObject({ params: { model: target, effort: 'low', collaborationMode: { settings: { model: target, reasoning_effort: 'low' } } } });
      gateway.rpc.onNotification({ method: 'thread/settings/updated', params: { threadId: 'root', threadSettings: { model: target, effort: 'low' } } });
      const native = { ...f.request, model: target, reasoning: { effort: 'low' } };
      const response = await fetch(gateway.url.replace('ws:', 'http:') + '/responses', { method: 'POST', headers: { 'x-jev-gate-session': gateway.token, 'session-id': 'root' }, body: JSON.stringify(native) });
      expect(response.status).toBe(200); await response.text();
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]).toEqual({ ...native, input: [...native.input, expect.objectContaining({ role: 'developer' })] });
      expect(JSON.stringify(forwarded[0])).toContain('Jev routed execution');
      const rows = readdirSync(trace).map(name => JSON.parse(readFileSync(join(trace, name), 'utf8')));
      expect(rows).toContainEqual(expect.objectContaining({ phase: 'codex_model_request', submitted_model: target, submitted_effort: 'low', input_change: expect.objectContaining({ execution_guidance_added: true }) }));
      expect(f.fetchImpl).toHaveBeenCalledOnce();
    } finally { f.rpc.close(); await gateway.close(); upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r())); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([['fixture-A', 'low', true], ['fixture-B', 'high', true], ['fixture-A', 'high', false]])('carries managed %s/%s routing to execution preparation', async (model, effort, expected) => {
    const f = await fixture(false, model as string, effort as string);
    try {
      await f.policy.client(f.start);
      const params = f.forward.mock.calls[0]![0].params as Obj;
      // Native App Server publishes the applied turn settings before sending HTTP.
      f.rpc.onNotification({ method: 'thread/settings/updated', params: { threadId: 'root', threadSettings: { model: params.model, effort: params.effort } } });
      const native = { ...f.request, model: params.model, reasoning: { ...f.request.reasoning, effort: params.effort } };
      const result = await f.policy.externalRequest('root', native, new AbortController().signal);
      expect(result.request).toBe(native); expect(result.preRouted).toBe(expected);
      const submitted = routedExecution(native, result.request, result.preRouted);
      expect((submitted.input as Obj[]).slice(0, native.input.length)).toEqual(native.input);
      expect(JSON.stringify(submitted).includes('Jev routed execution')).toBe(expected);
      expect(f.fetchImpl).toHaveBeenCalledOnce(); // The wire stage must not classify again.
    } finally { f.rpc.close(); }
  });

  it.each(['abort', 'terminal', 'prompt', 'settings', 'config', 'manual', 'disabled', 'catalog', 'native-update'])('does not use a managed route after %s', async change => {
    const f = await fixture(false, 'fixture-A', 'low');
    try {
      await f.policy.client(f.start);
      const session = f.policy.sessions.get('root')!, signal = new AbortController();
      let native: Obj = { ...f.request, reasoning: { effort: 'low' } };
      if (change === 'abort') signal.abort();
      if (change === 'terminal') session.terminal = true;
      if (change === 'prompt') session.prompt = 'new-prompt';
      if (change === 'settings') await f.rpc.onResponse({}, 'thread/settings/update', { threadId: 'root', effort: 'low' });
      if (change === 'config') saveConfig({ enabled: false });
      if (change === 'manual') native = { ...native, reasoning: { effort: 'high' } };
      if (change === 'disabled') session.eligible = false;
      if (change === 'catalog') delete session.route;
      if (change === 'native-update') native = { ...native, input: [{ type: 'configuration_update', reasoning: { effort: 'high' } }] };
      const result = await f.policy.externalRequest('root', native, signal.signal);
      expect(result.preRouted ?? false).toBe(false); expect(result.request).toBe(native);
    } finally { f.rpc.close(); }
  });

  it('clears a previous managed route when the next turn cannot be routed', async () => {
    const f = await fixture(false, 'fixture-A', 'low');
    try {
      await f.policy.client(f.start);
      await f.policy.client({ ...f.start, params: { ...f.start.params, clientUserMessageId: 'next', input: [{ type: 'image', imageUrl: 'native-image' }] } });
      const native = { ...f.request, reasoning: { effort: 'low' } };
      expect((await f.policy.externalRequest('root', native, new AbortController().signal)).preRouted).toBe(false);
    } finally { f.rpc.close(); }
  });
  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])('routes Terra with account-supported %s through native turn settings', async effort => {
    const f = await fixture(false, 'gpt-6.1-terra', effort);
    f.policy.catalog = [catalog[0]!, {
      model: 'gpt-6.1-terra', description: 'GPT-6.1 Terra Codex model.', defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort })),
    }];
    try {
      await f.policy.client(f.start);
      expect(f.forward).toHaveBeenCalledOnce();
      expect(f.forward.mock.calls[0]?.[0]).toMatchObject({ method: 'turn/start', params: {
        model: 'gpt-6.1-terra', effort,
        collaborationMode: { settings: { model: 'gpt-6.1-terra', reasoning_effort: effort, developer_instructions: 'preserve' } },
      } });
      expect(f.policy.sessions.size).toBe(1);
    } finally { f.rpc.close(); }
  });
  it.each(['none', 'low', 'medium', 'high', 'xhigh', 'max'])('routes Terra with advertised API effort %s and excludes host-only ultra', async effort => {
    const f = await fixture(true, 'gpt-6.1-terra', effort);
    f.policy.catalog = [catalog[0]!, {
      model: 'gpt-6.1-terra', description: 'GPT-6.1 Terra Codex model.', defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(reasoningEffort => ({ reasoningEffort })),
    }];
    try {
      const result = await f.policy.externalRequest('root', f.request, new AbortController().signal, 'codex-tui', 'chatgpt');
      expect(result.request).toEqual({ ...f.request, model: 'gpt-6.1-terra', reasoning: { ...f.request.reasoning, effort } });
      const questions = Object.values(f.sent[0]?.questions as Record<string, { type: string; criteria: unknown }>);
      expect(JSON.stringify(questions.filter(q => q.type === 'score'))).not.toContain('Exhaustive host');
      expect(f.fetchImpl).toHaveBeenCalledOnce();
    } finally { f.rpc.close(); }
  });
  it.each([
    'Chunk ID: native-failure\nWall time: 0.2 seconds\nProcess exited with code 1\nOutput:\nPRIVATE_FAILURE_OUTPUT',
    'Wall time: 0.2000 seconds\nProcess exited with code 1\nOriginal token count: 100000\nOutput:\nPRIVATE_FAILURE_OUTPUT',
    [{ type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' }, { type: 'input_text', text: 'PRIVATE_FAILURE_OUTPUT' }],
  ])('carries native tool failure evidence into the next judgment without exporting result text (%#)', async output => {
    const f = await rootContinuationFixture();
    const failed = { ...f.next, input: f.next.input.map(item => item.type === 'function_call_output' ? {
      ...item, output,
    } : item) };
    try {
      await f.policy.externalRequest('root', failed, f.signal.signal, 'codex-tui', 'chatgpt');
      expect(f.sent[1]?.['state']).toMatchObject({ execution: { context: {
        tools: [{ name: 'exec_command', state: 'error' }], outcome_coverage: 'native_status', pending: 0,
      } } });
      expect(JSON.stringify(f.sent)).not.toContain('PRIVATE_FAILURE_OUTPUT');
      expect(JSON.stringify(f.sent)).not.toContain('private-arguments-canary');
      const questions = f.sent[1]?.['questions'] as Record<string, { type: string; instructions: string }>;
      for (const question of Object.values(questions).filter(q => q.type === 'score')) {
        expect(question.instructions).toContain('minimizes total tokens');
        expect(question.instructions).toContain('Lower effort can consume MORE total tokens');
      }
      // Retrying an identical inference must not pay for a second judgment.
      await f.policy.externalRequest('root', failed, f.signal.signal, 'codex-tui', 'chatgpt');
      expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    } finally { f.rpc.close(); }
  });
  it.each(['PRIVATE_FAILURE_OUTPUT', 'example: Process exited with code 1',
    'Chunk ID: fake\nWall time: 0.2 seconds\nProcess exited with code 1\nnot a native output envelope'])('does not invent failure evidence from %s', async output => {
    const f = await rootContinuationFixture();
    const next = { ...f.next, input: f.next.input.map(item => item.type === 'function_call_output' ? { ...item, output } : item) };
    try {
      await f.policy.externalRequest('root', next, f.signal.signal, 'codex-tui', 'chatgpt');
      expect(f.sent[1]?.['state']).toMatchObject({ execution: { context: {
        tools: [{ name: 'exec_command', state: 'done' }], outcome_coverage: 'completion_only',
      } } });
      expect(JSON.stringify(f.sent)).not.toContain(output);
    } finally { f.rpc.close(); }
  });
  it.each(['inference', 'native'] as const)('passes the native billing family to %s Compact and isolates its decisions', async path => {
    const f = await fixture(true, 'fixture-B', 'max');
    const request = { ...f.request, input: [...f.request.input, ...Array.from({ length: 10 }, (_, i) => [
      { type: 'function_call', call_id: `unique-${i}`, name: 'exec_command', arguments: 'Read completed obsolete color survey.' },
      { type: 'function_call_output', call_id: `unique-${i}`, output: Array.from({ length: 90 }, (_, j) => `Archived sample ${i}:${j}: completed unrelated color survey without a current dependency.\n`).join('') },
    ]).flat()] };
    f.fetchImpl.mockImplementation(async (_url, init) => {
      const req = JSON.parse(String(init?.body));
      return Response.json({ model: req.model, answers: Object.fromEntries(Object.keys(req.questions).map(id => [id,
        { type: 'choice', choice: 'remove', confidence: .99, probabilities: { keep: .005, remove: .99, unclear: .005 } },
      ])) });
    });
    const signal = new AbortController().signal;
    try {
      expect((await f.policy.compactRequest('root', request, signal, path, 'unknown')).request).toBe(request);
      expect(f.fetchImpl).not.toHaveBeenCalled();
      const selected = await f.policy.compactRequest('root', request, signal, path, 'chatgpt');
      expect(selected.receipt?.applied).toBe(true); expect(f.fetchImpl).toHaveBeenCalledOnce();
      expect((await f.policy.compactRequest('root', request, signal, path, 'chatgpt')).request).toEqual(selected.request);
      expect(f.fetchImpl).toHaveBeenCalledOnce();
      expect((await f.policy.compactRequest('root', request, signal, path, 'api')).request).toBe(request);
      expect(f.fetchImpl).toHaveBeenCalledOnce();
    } finally { f.rpc.close(); }
  });

  it('reassesses a root tool continuation without replacing its contract or repeating a retry assessment', async () => {
    const f = await nativeBillingFixture(), signal = new AbortController().signal;
    f.fetchImpl.mockImplementation(async (_url, init) => {
      const req = JSON.parse(String(init?.body)); f.sent.push(req);
      const model = f.sent.length === 2 ? 'gpt-6-luna' : 'gpt-6.1-sol';
      return new Response(JSON.stringify({ model: req.model, answers: answers(req, model, 'low') }), { headers: { 'content-type': 'application/json' } });
    });
    const first = { ...f.request, input: [{ type: 'message', role: 'user', content: 'Implement the fixture.' }] };
    expect((await f.policy.externalRequest('root', first, signal, 'codex-tui', 'chatgpt')).request.model).toBe('gpt-6.1-sol');
    const next = { ...first, input: [...first.input,
      { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'The algorithm is implemented. Next, list the fixture files.' }] },
      { type: 'function_call', call_id: 'files', name: 'exec_command', arguments: 'private-arguments-canary' },
      { type: 'function_call_output', call_id: 'files', output: 'private-results-canary' }] };
    const selected = (await f.policy.externalRequest('root', next, signal, 'codex-tui', 'chatgpt')).request;
    expect(selected).toEqual({ ...next, model: 'gpt-6-luna', reasoning: { ...next.reasoning, effort: 'low' } });
    expect(selected.input).toBe(next.input); expect(selected.tools).toBe(next.tools);
    expect(f.policy.observeRequest('root', selected)).toMatchObject({ index: 1, scope: 'root', model: 'gpt-6-luna' });
    expect((await f.policy.externalRequest('root', next, signal, 'codex-tui', 'chatgpt')).request).toEqual(selected);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.sent[1]?.state).toMatchObject({ task: { text: 'Implement the fixture.' }, execution: { scope: 'root', step_index: 1,
      context: { outcome_coverage: 'completion_only', assistant_update: { text: 'The algorithm is implemented. Next, list the fixture files.' } } } });
    expect(JSON.stringify(f.sent[1])).not.toContain('private-arguments-canary'); expect(JSON.stringify(f.sent[1])).not.toContain('private-results-canary');
    expect(JSON.stringify(f.sent[1]?.questions)).toContain('NEXT inference');
    const hard = { ...next, input: [...next.input,
      { type: 'message', role: 'assistant', phase: 'commentary', content: 'A conflicting invariant requires redesigning the algorithm.' },
      { type: 'function_call', call_id: 'check', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'check', output: 'failure details stay local' }] };
    expect((await f.policy.externalRequest('root', hard, signal, 'codex-tui', 'chatgpt')).request.model).toBe('gpt-6.1-sol');
    expect(f.fetchImpl).toHaveBeenCalledTimes(3); f.rpc.close();
  });
  it('shares a pending continuation and preserves opaque history, native fields and submission attribution', async () => {
    let release!: () => void; const f = await rootContinuationFixture(new Promise<void>(resolve => { release = resolve; }));
    const one = f.policy.externalRequest('root', f.next, f.signal.signal, 'codex-tui', 'chatgpt');
    const two = f.policy.externalRequest('root', f.next, f.signal.signal, 'codex-tui', 'chatgpt');
    await vi.waitFor(() => expect(f.sent).toHaveLength(2)); release();
    const selected = (await one).request;
    expect(selected).toEqual({ ...f.next, reasoning: { ...f.next.reasoning, effort: 'low' } });
    expect((await two).request).toEqual(selected); expect(selected.input).toBe(f.next.input);
    const binding = f.policy.observeRequest('root', selected)!;
    expect(binding).toMatchObject({ index: 1, scope: 'root' });
    const rows = readdirSync(join(dir, 'trace')).map(file => JSON.parse(readFileSync(join(dir, 'trace', file), 'utf8')));
    expect(rows).toContainEqual(expect.objectContaining({ phase: 'codex_route_applied', request_id: binding.requestId, index: 1, applied: true }));
    for (const canary of ['opaque-reasoning-canary', 'private-arguments-canary', 'private-results-canary']) expect(JSON.stringify(f.sent)).not.toContain(canary);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2); f.rpc.close();
  });
  it('binds Router decisions to the actual submitted request after Compact rewrites older tool evidence', async () => {
    const f = await nativeBillingFixture(), signal = new AbortController().signal;
    const older = Array.from({ length: 8 }, (_, i) => [
      { type: 'function_call', call_id: `old-${i}`, name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: `old-${i}`, output: 'Archived exact fixture record.\n'.repeat(800) },
    ]).flat();
    const first = { ...f.request, input: [...older, { type: 'message', role: 'user', content: 'Implement the fixture.' }] };
    const next = { ...first, input: [...first.input,
      { type: 'message', role: 'assistant', phase: 'commentary', content: 'The implementation is ready; next list the fixture files.' },
      { type: 'function_call', call_id: 'current', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'current', output: 'current evidence' }] };
    for (const [index, request] of [first, next].entries()) {
      const selected = (await f.policy.externalRequest('root', request, signal, 'codex-tui', 'chatgpt')).request;
      const compacted = await f.policy.compactRequest('root', selected, signal, 'inference');
      expect(compacted.receipt?.applied).toBe(true); expect(compacted.request.input).not.toEqual(selected.input);
      const binding = f.policy.observeRequest('root', compacted.request, 'chatgpt', selected)!;
      expect(binding).toMatchObject({ index, model: 'gpt-6-luna', effort: 'low' });
      const rows = readdirSync(join(dir, 'trace')).map(file => JSON.parse(readFileSync(join(dir, 'trace', file), 'utf8')));
      expect(rows).toContainEqual(expect.objectContaining({ phase: 'codex_route_applied', request_id: binding.requestId, index, applied: true }));
    }
    f.rpc.close();
  });
  it.each(['config', 'catalog', 'settings', 'manual'] as const)('rejects a pending continuation and its retry when %s changes', async kind => {
    let release!: () => void; const f = await rootContinuationFixture(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.policy.externalRequest('root', f.next, f.signal.signal, 'codex-tui', 'chatgpt');
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    if (kind === 'config') saveConfig({ enabled: false });
    if (kind === 'catalog') f.policy.catalog = f.policy.catalog.map(m => m.model === 'gpt-6.1-sol' ? { ...m, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] } : m);
    if (kind === 'settings') await f.rpc.onResponse({}, 'thread/settings/update', { threadId: 'root', model: 'gpt-6.1-sol', effort: 'high' });
    const changed = kind === 'manual' ? { ...f.next, model: 'manual-model' } : f.next;
    const retry = kind === 'manual' ? f.policy.externalRequest('root', changed, f.signal.signal, 'codex-tui', 'chatgpt') : null;
    release(); expect((await pending).request).toEqual(f.next);
    if (retry) expect((await retry).request).toEqual(changed);
    expect((await f.policy.externalRequest('root', changed, f.signal.signal, 'codex-tui', 'chatgpt')).request).toEqual(changed);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2); f.rpc.close();
  });
  it.each(['prompt', 'interrupt', 'compact'] as const)('never applies a continuation after its %s generation ends', async kind => {
    let release!: () => void; const f = await rootContinuationFixture(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.policy.externalRequest('root', f.next, f.signal.signal, 'codex-tui', 'chatgpt');
    const rejected = expect(pending).rejects.toThrow('interrupted policy');
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    await f.policy.externalHook({ hook_event_name: kind === 'prompt' ? 'UserPromptSubmit' : kind === 'compact' ? 'PostCompact' : 'Interrupt', session_id: 'root', turn_id: 'replacement', prompt: 'A new task.' });
    release(); await rejected; expect(f.fetchImpl).toHaveBeenCalledTimes(2); f.rpc.close();
  });
  it.each(['no_progress', 'secret', 'orphan', 'incremental', 'unknown'] as const)('keeps the whole-contract decision without another paid assessment for %s context', async kind => {
    const f = await rootContinuationFixture();
    const input: Obj[] = f.next.input.map(item => item.type === 'message' && item.role === 'assistant' ? { ...item, content: kind === 'secret' ? 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789' : kind === 'no_progress' ? '' : item.content, phase: kind === 'no_progress' ? 'analysis' : 'commentary' } : item);
    if (kind === 'orphan') input.push({ type: 'function_call_output', call_id: 'unknown', output: 'private' });
    if (kind === 'unknown') input.push({ type: 'unknown_native_item' });
    const request = { ...f.next, input, ...(kind === 'incremental' ? { previous_response_id: 'native-response' } : {}) };
    expect((await f.policy.externalRequest('root', request, f.signal.signal, 'codex-tui', 'chatgpt')).request).toEqual({ ...request, model: 'gpt-6-luna', reasoning: { ...request.reasoning, effort: 'low' } });
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it('does not carry a next-inference patch into an unobservable later step or reassess after the bound', async () => {
    const f = await rootContinuationFixture();
    await f.policy.externalRequest('root', f.next, f.signal.signal, 'codex-tui', 'chatgpt');
    const next = { ...f.first, input: [...f.first.input, { type: 'reasoning', encrypted_content: 'opaque-only-next' }] };
    expect((await f.policy.externalRequest('root', next, f.signal.signal, 'codex-tui', 'chatgpt')).request.model).toBe('gpt-6-luna');
    const steps = f.policy.sessions.get('root')!.rootRoutes!, last = [...steps.values()].at(-1)!;
    while (steps.size < 128) steps.set(`bound-${steps.size}`, { ...last, index: steps.size });
    const overflow = { ...f.next, input: [...f.next.input, { type: 'message', role: 'assistant', phase: 'commentary', content: 'Next bounded step.' }] };
    expect((await f.policy.externalRequest('root', overflow, f.signal.signal, 'codex-tui', 'chatgpt')).request).toBe(overflow);
    const binding = f.policy.observeRequest('root', overflow)!;
    const rows = readdirSync(join(dir, 'trace')).map(file => JSON.parse(readFileSync(join(dir, 'trace', file), 'utf8')));
    expect(rows.filter(row => row.phase === 'codex_route_applied' && row.request_id === binding.requestId)).toHaveLength(0);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2); f.rpc.close();
  });
  it.each(['chatgpt', 'api', 'unknown'] as const)('preserves the native input and does not veto an eligible pair for %s billing', async billing => {
    const f = await nativeBillingFixture();
    const expected = 'gpt-6-luna';
    for (let i = 0; i < 3; i++) {
      const request = i === 0 ? f.request : { ...f.request, input: [...f.request.input, { type: 'function_call', call_id: 'exact-tool', name: 'original', arguments: '{}' }, { type: 'function_call_output', call_id: 'exact-tool', output: 'ok' }] };
      const selected = (await f.policy.externalRequest('root', request, new AbortController().signal, 'codex-tui', billing)).request;
      expect(selected).toEqual({ ...request, model: expected, reasoning: { ...request.reasoning, effort: 'low' } });
      expect(selected.input).toBe(request.input); expect(selected.tools).toBe(request.tools);
    }
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    const rows = readdirSync(join(dir, 'trace')).map(file => JSON.parse(readFileSync(join(dir, 'trace', file), 'utf8')));
    expect(rows).toContainEqual(expect.objectContaining({ phase: 'codex_router_result', selected_model: expected,
      cost_reason: 'diagnostic_only', cost: expect.objectContaining({ authorization: 'diagnostic_only', basis: billing === 'chatgpt' ? 'codex_credit_rate_comparison' : billing === 'api' ? 'api_list_estimate' : 'unknown' }) }));
    f.rpc.close();
  });
  it.each(['billing', 'tier', 'cache'] as const)('reuses a cached native pair after diagnostic %s changes without another paid assessment', async change => {
    const f = await nativeBillingFixture(), signal = new AbortController().signal;
    expect((await f.policy.externalRequest('root', f.request, signal, 'codex-tui', 'chatgpt')).request.model).toBe('gpt-6-luna');
    const changed = change === 'tier' ? { ...f.request, service_tier: 'ultrafast' } : change === 'cache' ? { ...f.request, prompt_cache_retention: '24h' } : f.request;
    expect((await f.policy.externalRequest('root', changed, signal, 'codex-tui', change === 'billing' ? 'api' : 'chatgpt')).request).toEqual({ ...changed, model: 'gpt-6-luna', reasoning: { ...changed.reasoning, effort: 'low' } });
    expect((await f.policy.externalRequest('root', f.request, signal, 'codex-tui', 'chatgpt')).request.model).toBe('gpt-6-luna');
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it('keeps an in-flight decision when diagnostic billing changes, and reassesses only on a new prompt', async () => {
    let release!: () => void; const f = await nativeBillingFixture(new Promise<void>(resolve => { release = resolve; }));
    const signal = new AbortController().signal;
    const first = f.policy.externalRequest('root', f.request, signal, 'codex-tui', 'chatgpt');
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    const changed = f.policy.externalRequest('root', f.request, signal, 'codex-tui', 'api'); release();
    expect((await first).request.model).toBe('gpt-6-luna'); expect((await changed).request.model).toBe('gpt-6-luna');
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    await f.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: 'root', turn_id: 'new-billing-prompt', prompt: 'Add two numbers.' });
    expect((await f.policy.externalRequest('root', f.request, signal, 'codex-tui', 'chatgpt')).request.model).toBe('gpt-6-luna');
    expect(f.fetchImpl).toHaveBeenCalledTimes(2); f.rpc.close();
  });
  it.each(['root', 'child'] as const)('reuses a pending %s continuation across diagnostic changes and retries', async scope => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const f = scope === 'root' ? await rootContinuationFixture(wait) : await ownedFixture(wait);
    const id = 'child' in f ? f.child.id : 'root';
    const before = f.sent.length;
    try {
      const pending = f.policy.externalRequest(id, f.next, f.signal.signal, 'codex-tui', 'chatgpt');
      await vi.waitFor(() => expect(f.sent).toHaveLength(before + 1));
      const changed = { ...f.next, service_tier: 'ultrafast', prompt_cache_retention: '24h' };
      const retry = f.policy.externalRequest(id, changed, f.signal.signal, 'codex-tui', 'unknown');
      release();
      expect((await pending).request.reasoning).toMatchObject({ effort: 'low' });
      expect((await retry).request).toMatchObject({ service_tier: 'ultrafast', prompt_cache_retention: '24h', reasoning: { effort: 'low' } });
      expect((await f.policy.externalRequest(id, f.next, f.signal.signal, 'codex-tui', 'chatgpt')).request.reasoning).toMatchObject({ effort: 'low' });
      expect(f.fetchImpl).toHaveBeenCalledTimes(before + 1);
    } finally { release(); f.rpc.close(); }
  });
  it('does not bypass an explicit native execution pin for the cheaper credit rate', async () => {
    const f = await nativeBillingFixture();
    expect((await f.policy.externalRequest('root', f.request, new AbortController().signal, 'codex_exec', 'chatgpt')).request).toEqual(f.request);
    expect(f.fetchImpl).not.toHaveBeenCalled(); f.rpc.close();
  });
});
describe('original Codex root execution boundaries', () => {
  it('routes effort after encrypted native reasoning without changing the model or encrypted history', async () => {
    const f = await ownedFixture();
    const request = { ...f.next, input: [{ type: 'reasoning', id: 'native-reasoning', encrypted_content: 'opaque-provider-bytes', summary: [] }, ...f.next.input] };
    const routed = (await f.policy.externalRequest(f.child.id, request, f.signal.signal)).request;
    expect(routed.model).toBe(request.model); expect(routed.reasoning).toMatchObject({ effort: 'low' }); expect(routed.input).toBe(request.input);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.sent[0]?.questions).not.toHaveProperty('model');
    expect(JSON.stringify(f.sent[0])).not.toContain('opaque-provider-bytes'); f.rpc.close();
  });
  it('records the worker step limit and never attributes its native request to the previous route', async () => {
    const f = await ownedFixture(); const selected = (await f.policy.externalRequest(f.child.id, f.next, f.signal.signal)).request;
    f.policy.observeRequest(f.child.id, selected);
    const steps = f.child.stepRoutes!; const previous = [...steps.values()].at(-1)!;
    while (steps.size < 128) steps.set(`bounded-${steps.size}`, { ...previous, index: steps.size });
    const request = { ...f.next, input: [...f.next.input, { role: 'user', content: 'Next bounded step' }] };
    expect((await f.policy.externalRequest(f.child.id, request, f.signal.signal)).request).toBe(request);
    const submitted = f.policy.observeRequest(f.child.id, request)!;
    const rows = readdirSync(join(dir, 'trace')).map(file => JSON.parse(readFileSync(join(dir, 'trace', file), 'utf8')));
    expect(rows.filter(r => r.phase === 'codex_route_applied' && r.request_id === submitted.requestId)).toHaveLength(0);
    expect(rows).toContainEqual(expect.objectContaining({ phase: 'codex_router_skipped', reason: 'child_step_limit', known_not_sent: true }));
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it.each(['config', 'settings', 'settings_notification'] as const)('preserves a worker request when %s changes during assessment', async kind => {
    let release!: () => void;
    const f = await ownedFixture(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.policy.externalRequest(f.child.id, f.next, f.signal.signal);
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    if (kind === 'config') saveConfig({ enabled: false });
    else if (kind === 'settings_notification') f.rpc.onNotification({ method: 'thread/settings/updated', params: { threadId: f.child.id, threadSettings: { model: 'gpt-6-luna', effort: 'high' } } });
    else await f.rpc.onResponse({}, 'thread/settings/update', { threadId: f.child.id, model: 'gpt-6-luna', effort: 'high' });
    release();
    expect((await pending).request).toEqual(f.next);
    expect((await f.policy.externalRequest(f.child.id, f.next, f.signal.signal)).request).toEqual(f.next);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it.each(['removed', 'effort', 'previous_generation', 'config', 'settings', 'settings_notification'] as const)('preserves a cached worker retry after %s invalidates its pair', async kind => {
    const f = await ownedFixture();
    expect((await f.policy.externalRequest(f.child.id, f.next, f.signal.signal)).request.model).toBe('gpt-6.1-sol');
    if (kind === 'config') saveConfig({ model: false });
    else if (kind === 'settings_notification') f.rpc.onNotification({ method: 'thread/settings/updated', params: { threadId: f.child.id, threadSettings: { model: 'gpt-6-luna', effort: 'high' } } });
    else if (kind === 'settings') await f.rpc.onResponse({}, 'thread/settings/update', { threadId: f.child.id, model: 'gpt-6-luna', effort: 'high' });
    else if (kind === 'removed') f.policy.catalog = f.policy.catalog.filter(m => m.model !== 'gpt-6.1-sol');
    else f.policy.catalog = f.policy.catalog.map(m => m.model !== 'gpt-6.1-sol' ? m : kind === 'effort' ? { ...m, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] } : { ...m, description: 'Previous generation model.' });
    expect((await f.policy.externalRequest(f.child.id, f.next, f.signal.signal)).request).toEqual(f.next);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it.each(['root', 'child'] as const)('does not attribute a preserved %s native update to its earlier route', async scope => {
    const child = scope === 'child' ? await ownedFixture() : null;
    const f = child ?? await fixture(true, 'fixture-B', 'max');
    const id = child?.child.id ?? 'root', request = child?.next ?? f.request;
    const selected = (await f.policy.externalRequest(id, request, new AbortController().signal)).request;
    f.policy.observeRequest(id, selected);
    const native = { ...selected, input: [...request.input, { type: 'configuration_update', reasoning: { effort: 'high' } }] };
    expect((await f.policy.externalRequest(id, native, new AbortController().signal)).request).toBe(native);
    const submitted = f.policy.observeRequest(id, native)!;
    const records = readdirSync(join(dir, 'trace')).map(file => JSON.parse(readFileSync(join(dir, 'trace', file), 'utf8')));
    expect(records.filter(r => r.phase === 'codex_route_applied' && r.request_id === submitted.requestId)).toHaveLength(0);
    expect(records).toContainEqual(expect.objectContaining({ phase: 'codex_model_request', request_id: submitted.requestId, submitted_model: selected.model }));
    f.rpc.close();
  });
  it('preserves native effort update positions and does not treat the reported top-level effort as effective', async () => {
    const f = await fixture(true, 'fixture-B', 'max');
    const request = { ...f.request, input: [{ type: 'configuration_update', reasoning: { effort: 'low' } }, ...f.request.input] };
    expect((await f.policy.externalRequest('root', request, new AbortController().signal)).request).toBe(request);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    f.rpc.close();
  });
  it('records exact late and unbound consumption without overwriting a newer request cache', async () => {
    const f = await fixture(true, 'fixture-B', 'max');
    const before = f.policy.observeRequest('root', f.request)!;
    const current = f.policy.observeRequest('root', f.request)!;
    const response = { id: 'native-response', model: 'fixture-A', status: 'completed', output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 10 }, output_tokens: 5 } };
    f.policy.observeUsage('root', response, current);
    expect(f.policy.sessions.get('root')?.cache?.read).toBe(80);
    f.policy.observeUsage('root', { ...response, usage: { ...response.usage, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 10 } } }, before);
    expect(f.policy.sessions.get('root')?.cache?.read).toBe(80);
    f.policy.sessions.delete('root'); f.policy.observeUsage('root', response, before); f.policy.observeUsage('root', response);
    const records = readdirSync(join(dir, 'trace')).map(file => JSON.parse(readFileSync(join(dir, 'trace', file), 'utf8'))).filter(r => r.phase === 'codex_router_response');
    expect(records.filter(r => r.request_id === before.requestId)).toHaveLength(2);
    expect(records).toContainEqual(expect.objectContaining({ request_id: null, prompt_id: null, scope: 'unknown', reason: 'request_identity_unknown', usage: expect.objectContaining({ read: 80 }) }));
    f.rpc.close();
  });
  it('keeps only the latest complete matching request shape, records safe diagnostics, and resets at native compaction', async () => {
    const f = await fixture(true, 'fixture-B', 'max');
    try {
      const first = f.policy.observeRequest('root', f.request, 'chatgpt', undefined, { native: f.request, guidance: false })!;
      const next = f.policy.observeRequest('root', { ...f.request, input: [...f.request.input, { role: 'user', content: 'private-input-canary' }] }, 'chatgpt')!;
      const response = { id: 'cache-fixture', model: 'fixture-A', status: 'completed', output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 5 },
        prompt_cache_diagnostics: { type: 'cache_miss', reason: 'input_changed', cache_missed_tokens: 80, raw_prompt: 'private-input-canary' } };
      f.policy.observeUsage('root', response, first);
      const session = f.policy.sessions.get('root')!;
      expect(session.cacheInput).toBeUndefined(); // Late response cannot replace the current binding.
      f.policy.observeUsage('root', { ...response, status: 'incomplete' }, next);
      expect(session.cacheInput).toBeUndefined();
      f.policy.observeUsage('root', { ...response, usage: {} }, next);
      expect(session.cacheInput).toBeUndefined();
      f.policy.observeUsage('root', response, next);
      expect(session.cacheInput?.shape).toEqual(next.cacheInput);
      expect(JSON.stringify(session.cacheInput)).not.toContain('private-input-canary');
      const rows = readdirSync(join(dir, 'trace')).map(file => JSON.parse(readFileSync(join(dir, 'trace', file), 'utf8')));
      expect(rows).toContainEqual(expect.objectContaining({ phase: 'codex_router_response', request_id: next.requestId, usage: expect.objectContaining({ read: 0, output: 5 }), cache_diagnostics: { type: 'cache_miss', reason: 'input_changed', cache_missed_tokens: 80 } }));
      expect(rows).toContainEqual(expect.objectContaining({ phase: 'codex_model_request', request_id: first.requestId, context_epoch: first.epoch, input_change: expect.objectContaining({ first_changed_item: null, compact_applied: false, execution_guidance_added: false }) }));
      expect(JSON.stringify(rows)).not.toContain('private-input-canary');
      session.compact = { key: 'old', calls: 0, decisions: new Map(), selections: new Map(), cutoff: 2 };
      await f.policy.externalHook({ hook_event_name: 'PostCompact', session_id: 'root' });
      expect(session.cacheInput).toBeUndefined(); expect(session.compact).toBeUndefined();
      expect(session.epoch).not.toBe(first.epoch);
    } finally { f.rpc.close(); }
  });
  it.each(['account/updated', 'account/login/completed'])('retires old comparison context and late responses on %s', async method => {
    const f = await fixture(true, 'fixture-B', 'max');
    try {
      vi.spyOn(f.rpc, 'request').mockResolvedValue({ data: catalog, nextCursor: null });
      const submitted = f.policy.observeRequest('root', f.request, 'chatgpt')!;
      const response = { model: 'fixture-A', status: 'completed', usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 } } };
      f.policy.observeUsage('root', response, submitted);
      const session = f.policy.sessions.get('root')!;
      expect(session.cacheInput).toBeDefined();
      session.compact = { key: 'old-account', calls: 0, decisions: new Map(), selections: new Map() };
      f.rpc.onNotification({ method, params: {} });
      expect(session.epoch).not.toBe(submitted.epoch);
      expect(session.cacheInput).toBeUndefined(); expect(session.compact).toBeUndefined(); expect(session.cache).toBeUndefined();
      f.policy.observeUsage('root', response, submitted);
      expect(session.cacheInput).toBeUndefined(); expect(session.route).toBeUndefined();
    } finally { f.rpc.close(); }
  });
  it('routes each owned worker NEXT step once after a closed native tool pair, retaining the original contract', async () => {
    const f = await fixture(false, 'gpt-6.1-sol', 'low');
    f.policy.catalog = [
      { model: 'gpt-6.1-sol', description: 'Latest workhorse model for coding and everyday work.', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
      { model: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.', supportedReasoningEfforts: ['low', 'high'].map(reasoningEffort => ({ reasoningEffort })) },
    ];
    const parent = f.policy.sessions.get('root')!;
    const signal = new AbortController();
    const child = { ...parent, id: 'owned-child', prompt: 'parent-prompt', role: 'jev-gate:worker', parent: 'root',
      dispatch: { parent, prompt: 'parent-prompt', tool: 'dispatch', input: { prompt: 'Keep this complete contract. Investigate, edit and verify.' }, signal: signal.signal, worktree: null, startedAt: Date.now(), attempted: true } };
    f.policy.sessions.set(child.id, child);
    const first = { ...f.request, model: 'gpt-6-luna' };
    expect((await f.policy.externalRequest(child.id, first, signal.signal)).request).toEqual(first);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    const next = { ...first, input: [...first.input, { type: 'function_call', call_id: 'exact-tool', name: 'exec_command', arguments: 'PRIVATE_ARGUMENT' }, { type: 'function_call_output', call_id: 'exact-tool', output: 'PRIVATE_RESULT' }] };
    const selected = (await f.policy.externalRequest(child.id, next, signal.signal)).request;
    expect(selected).toMatchObject({ model: 'gpt-6.1-sol', reasoning: { effort: 'low', summary: 'auto' }, metadata: { original: true } });
    expect(selected.input).toEqual(next.input);
    await f.policy.externalRequest(child.id, next, signal.signal);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.sent[0])).toContain('NEXT inference');
    expect(JSON.stringify(f.sent[0])).toContain('Keep this complete contract');
    expect(JSON.stringify(f.sent[0])).not.toMatch(/PRIVATE_ARGUMENT|PRIVATE_RESULT/);
    const third = { ...next, input: [...next.input, { role: 'user', content: 'A new native suffix.' }] };
    await f.policy.externalRequest(child.id, third, signal.signal);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    // A retry/late submission of step 1 must not take step 2's identity or rewind the counter.
    const retried = (await f.policy.externalRequest(child.id, next, signal.signal)).request;
    expect(f.policy.observeRequest(child.id, retried)?.index).toBe(1);
    expect(f.policy.observeRequest(child.id, third)?.index).toBe(2);
    const fourth = { ...third, input: [...third.input, { role: 'user', content: 'Another exact native suffix.' }] };
    const last = (await f.policy.externalRequest(child.id, fourth, signal.signal)).request;
    expect(f.policy.observeRequest(child.id, last)?.index).toBe(3);
    signal.abort();
    expect((await f.policy.externalRequest(child.id, third, signal.signal)).request).toEqual(third);
    f.rpc.close();
  });
  it('drops a stored target that the live catalog now marks as a previous generation', async () => {
    const f = await fixture(true, 'fixture-B', 'max');
    expect((await f.policy.externalRequest('root', f.request, new AbortController().signal)).request.model).toBe('fixture-B');
    f.policy.catalog = catalog.map(m => m.model === 'fixture-B' ? { ...m, description: 'Previous generation workhorse model.' } : m);
    expect((await f.policy.externalRequest('root', f.request, new AbortController().signal)).request).toEqual(f.request);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it.each([false, true].flatMap(external => ['default', 'echo'].map(mode => [external, mode] as const)))('reassesses three turns in one native root external=%s baseline=%s', async (external, mode) => {
    const f = await fixture(external, 'fixture-B', 'max'); let phase = 0;
    f.fetchImpl.mockImplementation(async (_url, init) => {
      const req = JSON.parse(String(init?.body)); f.sent.push(req);
      return new Response(JSON.stringify({ model: req.model, answers: answers(req, phase < 2 ? 'fixture-B' : 'fixture-A', phase < 2 ? 'max' : 'high') }), { headers: { 'content-type': 'application/json' } });
    });
    for (phase = 0; phase < 3; phase++) {
      const baseline = phase === 0 || mode === 'default' ? 'fixture-A' : 'fixture-B';
      const effort = phase === 0 || mode === 'default' ? 'high' : 'max';
      const routedModel = phase < 2 ? 'fixture-B' : 'fixture-A';
      if (external) {
        await f.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: 'root', turn_id: `turn-${phase}`, prompt: 'Continue the clear fixture.' });
        for (let step = 0; step < 2; step++) {
          const routed = await f.policy.externalRequest('root', { ...f.request, model: baseline, reasoning: { ...f.request.reasoning, effort } }, new AbortController().signal);
          expect(routed.request.model).toBe(routedModel);
          expect(routed.request.reasoning).toMatchObject({ effort: phase < 2 ? 'max' : 'high' });
          const binding = f.policy.observeRequest('root', routed.request);
          f.policy.observeUsage('root', { status: 'completed', model: routed.request.model, output: [] }, binding);
        }
      } else {
        await f.policy.client({ ...f.start, id: phase + 1, params: { ...f.start.params, clientUserMessageId: `turn-${phase}`, model: baseline, effort, collaborationMode: { ...f.start.params.collaborationMode, settings: { ...f.start.params.collaborationMode.settings, model: baseline, reasoning_effort: effort } } } });
        expect(f.forward.mock.calls[phase]?.[0]).toMatchObject({ params: { threadId: 'root', model: routedModel, effort: phase < 2 ? 'max' : 'high' } });
      }
      expect(f.sent).toHaveLength(phase + 1); expect(f.policy.sessions.size).toBe(1);
    }
    f.rpc.close();
  });
  it('passes real prior response cache counts into the next decision without locking its model', async () => {
    const f = await fixture(true, 'fixture-B', 'max');
    const first = await f.policy.externalRequest('root', f.request, new AbortController().signal);
    const binding = f.policy.observeRequest('root', first.request);
    f.policy.observeUsage('root', { status: 'completed', model: 'fixture-B', output: [], usage: { input_tokens: 42_000, input_tokens_details: { cached_tokens: 40_000, cache_write_tokens: 1000 } } }, binding);
    await f.policy.externalHook({ hook_event_name: 'UserPromptSubmit', session_id: 'root', turn_id: 'new-prompt', prompt: 'Diagnose and fix the next failure.' });
    const second = await f.policy.externalRequest('root', f.request, new AbortController().signal);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]?.['state']).toMatchObject({ execution: { cache: { source: 'provider_response_usage', previous_model: 'fixture-B', input_tokens: 1000, cache_read_tokens: 40_000, cache_write_tokens: 1000, cross_model_reuse_proven: false, current_fit_proven: false } } });
    expect(second.request.model).toBe('fixture-B'); expect(f.policy.sessions.size).toBe(1); f.rpc.close();
  });
  it.each([false,true].flatMap(external => [['__keep__','high'],['__keep__','low'],['fixture-B','high'],['fixture-B','max']].map(([model,effort])=>[external,model!,effort!] as const)))('same root keep/effort/model/both external=%s %s/%s',async(external,model,effort)=>{
    const f = await fixture(external,model,effort);
    const wantedModel = model === '__keep__' ? 'fixture-A' : model;
    if (external) {
      for (let i=0;i<2;i++) {
        const r = await f.policy.externalRequest('root',f.request,new AbortController().signal);
        expect(r.request).toEqual({...f.request,model:wantedModel,reasoning:{...f.request.reasoning,effort}});
        const binding = f.policy.observeRequest('root',r.request);
        f.policy.observeUsage('root',{status:'completed',model:wantedModel,output:[]},binding);
      }
    } else {
      await f.policy.client(f.start);
      expect(f.forward).toHaveBeenCalledOnce();
      const outbound = f.forward.mock.calls[0]![0];
      expect(outbound).toMatchObject({method:'turn/start',params:{threadId:'root',model:wantedModel,effort,collaborationMode:{settings:{model:wantedModel,reasoning_effort:effort,developer_instructions:'preserve'}}}});
    }
    expect(f.policy.sessions.size).toBe(1); expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it.each([['codex_exec',false],['codex-tui',true],[undefined,true]] as const)('a %s root keeps its own model and effort only for codex exec, whatever Jev answers',async(originator,routed)=>{
    // Jev would move fixture-A/high to fixture-B/max; the request names fixture-A as a -m run or a config default would.
    const f = await fixture(true,'fixture-B','max');
    for (let i=0;i<2;i++) {
      const r = await f.policy.externalRequest('root',f.request,new AbortController().signal,originator);
      expect(r.request).toEqual(routed ? {...f.request,model:'fixture-B',reasoning:{...f.request.reasoning,effort:'max'}} : f.request);
    }
    expect(f.fetchImpl).toHaveBeenCalledTimes(routed ? 1 : 0);
    const rows = readdirSync(join(dir,'trace')).map(file => JSON.parse(readFileSync(join(dir,'trace',file),'utf8')));
    if (!routed) expect(rows).toContainEqual(expect.objectContaining({phase:'codex_router_skipped',session_id:'root',reason:'pinned',known_not_sent:true}));
    f.rpc.close();
  });
  it.each(['gpt-6-sol','fixture-A'])('a codex exec root pinned to %s keeps it on every request, superseded or the configured model',async model=>{
    // gpt-6.1-sol supersedes gpt-6-sol; fixture-A is the session's configured model. Jev would move either to fixture-B/max.
    const f = await fixture(true,'fixture-B','max');
    f.policy.catalog = [...catalog,...['gpt-6.1-sol','gpt-6-sol'].map(id => ({ model: id, description: 'Workhorse model for coding.', supportedReasoningEfforts: ['high','xhigh'].map(reasoningEffort => ({ reasoningEffort })) }))];
    const request = {...f.request,model};
    for (let i=0;i<2;i++) expect((await f.policy.externalRequest('root',request,new AbortController().signal,'codex_exec')).request).toEqual(request);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    const rows = readdirSync(join(dir,'trace')).map(file => JSON.parse(readFileSync(join(dir,'trace',file),'utf8')));
    expect(rows).not.toContainEqual(expect.objectContaining({superseded_baseline:expect.objectContaining({from:model})}));
    f.rpc.close();
  });
  it('shares pending assessment across concurrent external requests and keeps manual C',async()=>{
    let release!:()=>void; const wait = new Promise<void>(r=>{release=r;}); const f = await fixture(true,'fixture-B','max',wait);
    const one = f.policy.externalRequest('root',f.request,new AbortController().signal);
    const two = f.policy.externalRequest('root',f.request,new AbortController().signal);
    await vi.waitFor(()=>expect(f.sent).toHaveLength(1)); release();
    expect((await one).request.model).toBe('fixture-B'); expect((await two).request.model).toBe('fixture-B');
    const manual = {...f.request,model:'fixture-C'};
    expect((await f.policy.externalRequest('root',manual,new AbortController().signal)).request).toEqual(manual);
    expect((await f.policy.externalRequest('root',manual,new AbortController().signal)).request).toEqual(manual);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it('does not submit or duplicate a managed turn cancelled during preparation',async()=>{
    let release!:()=>void; const f = await fixture(false,'fixture-B','max',new Promise<void>(r=>{release=r;}));
    const run = f.policy.client(f.start); await vi.waitFor(()=>expect(f.sent).toHaveLength(1));
    await f.policy.client({...f.start,id:2}); expect(f.fetchImpl).toHaveBeenCalledOnce(); expect(f.forward).not.toHaveBeenCalled();
    await f.policy.client({id:3,method:'turn/interrupt',params:{threadId:'root'}}); release(); await run;
    expect(f.forward.mock.calls.map(c=>c[0].method)).toEqual(['turn/interrupt']);
    expect(f.emitted.mock.calls.map(c=>c[0].id)).toEqual([2,1]); f.rpc.close();
  });
  it('drops unsent choices when loaded config changes, with no second assessment',async()=>{
    let release!:()=>void; const f = await fixture(true,'fixture-B','max',new Promise<void>(r=>{release=r;}));
    const run = f.policy.externalRequest('root',f.request,new AbortController().signal); await vi.waitFor(()=>expect(f.sent).toHaveLength(1));
    saveConfig({enabled:false}); release(); expect((await run).request).toEqual(f.request);
    expect((await f.policy.externalRequest('root',f.request,new AbortController().signal)).request).toEqual(f.request);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it('uses the actual completed reply and recent human constraints identically in both adapters',async()=>{
    const states:unknown[]=[];
    for (const external of [false,true]) {
      const f = await fixture(external,'__keep__','high'); const session=f.policy.sessions.get('root')!;
      session.completedReply='Actual completed answer.';
      if (external) { await f.policy.externalHook({hook_event_name:'UserPromptSubmit',session_id:'root',turn_id:'next',prompt:'Continue that work.'});
        session.recentRequests=['Keep the API unchanged.']; await f.policy.externalRequest('root',{...f.request,input:[{role:'user',content:'Continue that work.'}]},new AbortController().signal);
      } else { session.items=[{type:'userMessage',content:[{type:'text',text:'Keep the API unchanged.'}]}]; await f.policy.client({...f.start,params:{...f.start.params,input:[{type:'text',text:'Continue that work.'}]}}); }
      states.push(f.sent[0]!.state); f.rpc.close();
    }
    expect(states[0]).toEqual(states[1]); expect(states[0]).toMatchObject({task:{text:'Continue that work.',previous_reply:'Actual completed answer.',recent_requests:[{text:'Keep the API unchanged.'}]}});
  });
});

describe('catalog refresh and native pair fields',()=>{
  it('retains partial paginated metadata and excludes only conflicting or malformed entries',async()=>{
    const f=await fixture(false,'__keep__','high');
    const sixth={model:'fixture-F',description:'sixth coding model',supportedReasoningEfforts:[{reasoningEffort:'max',description:'highest'}],capabilities:{coding:true}};
    const listed=[...catalog,...['C','D','E'].map(n=>({...catalog[0]!,model:`fixture-${n}`})),sixth];
    const pages=[{data:listed,nextCursor:'next'},{data:[{...catalog[0]!,supportedReasoningEfforts:[{reasoningEffort:'low'}]},{model:'broken',supportedReasoningEfforts:null},{...sixth,model:'specialist',hidden:true}],nextCursor:'bad'}];
    const request=vi.spyOn(f.rpc,'request').mockImplementation(async()=>{const page=pages.shift();if(!page)throw new Error('pagination failed');return page;});
    await f.policy.initialize();
    expect(request).toHaveBeenCalledTimes(3); expect(f.policy.catalogComplete).toBe(false);
    expect(f.policy.catalog.map(m=>m.model)).toEqual(['fixture-B','fixture-C','fixture-D','fixture-E','fixture-F','specialist']);
    expect(f.policy.catalog.find(m=>m.model==='fixture-F')).toEqual(sixth);
    expect(f.policy.catalogExcluded).toMatchObject({duplicate_conflict:1,malformed:1}); f.rpc.close();
  });
  it('invalidates stale unsent catalog choices without replaying an assessment',async()=>{
    let release!:()=>void; const f=await fixture(true,'fixture-B','max',new Promise<void>(r=>{release=r;}));
    const run=f.policy.externalRequest('root',f.request,new AbortController().signal);await vi.waitFor(()=>expect(f.sent).toHaveLength(1));
    vi.spyOn(f.rpc,'request').mockResolvedValue({data:[catalog[0]],nextCursor:null}); await f.policy.initialize(); release();
    expect((await run).request).toEqual(f.request);expect((await f.policy.externalRequest('root',f.request,new AbortController().signal)).request).toEqual(f.request);
    expect(f.fetchImpl).toHaveBeenCalledOnce(); f.rpc.close();
  });
  it.each(['none','omit'] as const)('applies %s without deleting other reasoning fields',async(kind)=>{
    const f=await fixture(true,'fixture-B','max');f.policy.catalog=[catalog[0]!,{...catalog[1]!,supportedReasoningEfforts:kind==='none'?[{reasoningEffort:'none'}]:[]}];
    const r=await f.policy.externalRequest('root',f.request,new AbortController().signal);
    expect(r.request).toEqual({...f.request,model:'fixture-B',reasoning:kind==='none'?{effort:'none',summary:'auto'}:{summary:'auto'}});f.rpc.close();
  });
  it.each([['model',false,'__keep__','low','fixture-A','low'],['effort',false,'fixture-B','max','fixture-B','high']] as const)('keeps the %s dimension independent at the original root',async(dimension,value,selected,scored,model,effort)=>{
    const f=await fixture(true,selected,scored);saveConfig({[dimension]:value});
    const r=await f.policy.externalRequest('root',f.request,new AbortController().signal);
    expect(r.request).toEqual({...f.request,model,reasoning:{...f.request.reasoning,effort}});expect(f.policy.sessions.size).toBe(1);f.rpc.close();
  });
});

it('a confirmed manual settings change during managed assessment wins in both native fields',async()=>{
  let release!:()=>void; const f=await fixture(false,'fixture-B','max',new Promise<void>(r=>{release=r;}));
  const run=f.policy.client(f.start);await vi.waitFor(()=>expect(f.sent).toHaveLength(1));
  await f.rpc.onResponse({},'thread/settings/update',{threadId:'root',model:'fixture-C',effort:'low'});release();await run;
  expect(f.forward).toHaveBeenCalledOnce();expect(f.forward.mock.calls[0]![0]).toMatchObject({params:{model:'fixture-C',effort:'low',collaborationMode:{settings:{model:'fixture-C',reasoning_effort:'low'}}}});
  expect(f.fetchImpl).toHaveBeenCalledOnce();f.rpc.close();
});


it.each(['failure', 'missing', 'partial', 'invalid', 'complete', 'mismatch', 'child'] as const)('D4: Codex real %s provider records reach activity', async kind => {
  const trace = join(dir, 'trace');
  let before = new Set<string>(); try { before = new Set(readdirSync(trace)); } catch { /* first producer */ }
  const child = kind === 'child' ? await ownedFixture() : null;
  const f = child ?? await fixture(true, 'fixture-B', 'low');
  try {
    const id = child?.child.id ?? 'root';
    const source = child?.next ?? f.request;
    const selected = (await f.policy.externalRequest(id, source, new AbortController().signal)).request;
    const submitted = f.policy.observeRequest(id, selected)!;
    if (kind === 'failure') f.policy.observeRequestFailure(id, submitted);
    else if (kind !== 'missing') f.policy.observeUsage(id, { id: 'response-canary', model: kind === 'mismatch' ? 'another-model' : submitted.model,
      usage: { input_tokens: 20, ...(kind !== 'partial' ? { output_tokens: kind === 'invalid' ? -1 : 10 } : {}), input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } }, submitted);
    const records = readdirSync(trace).filter(file => !before.has(file)).map(file => JSON.parse(readFileSync(join(trace, file), 'utf8')) as Obj);
    const checks = activityChecks({ traces: { codex: { records, unreadable: 0 } }, now: Date.now(), installed: null, recording: true, keyPresent: true, codexOwner: null, liveness: null });
    const cost = checks.find(c => c.message.startsWith('router_cost:'))!;
    expect(cost.metrics).toMatchObject({ fired: 1, applied: 1, effect: null });
    expect(cost.message).toContain(['failure', 'missing', 'partial', 'invalid'].includes(kind) ? '1 requests with incomplete usage; 1 sessions excluded' : '0 requests with incomplete usage');
    if (kind !== 'failure' && kind !== 'missing') expect(checks.find(c => c.message.startsWith('router_applied:'))).toMatchObject({ level: kind === 'mismatch' ? 'fail' : 'ok', message: expect.stringContaining('1 requests with an observed model') });
    if (kind === 'child') expect(checks.find(c => c.message.startsWith('child_effect:'))?.message).toContain('1 child steps sent to Jev, 1 changed the effort');
    const isolated = mkdtempSync(join(dir, 'activity-'));
    records.forEach((r, i) => writeFileSync(join(isolated, `r${i}.json`), JSON.stringify(r)));
    const dashboard = loadActivity({ traceDir: isolated, host: 'codex', env: { HOME: join(isolated, 'home'), XDG_CONFIG_HOME: join(isolated, 'config') } });
    expect(dashboard.activity24h.codex.find(c => c.feature === 'router')?.metrics).toEqual(cost.metrics);
  } finally { f.policy.close(); f.rpc.close(); }
});
