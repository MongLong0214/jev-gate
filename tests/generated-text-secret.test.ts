import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { buildAdmissionRequest, buildAtomicAdmissionRequest } from '../src/admission.js';
import { buildWorkerRouteRequest, buildAtomicWorkerRouteRequest } from '../src/allocation.js';
import { ISOLATION_COMMIT_INSTRUCTION, ISOLATION_NOTE, OWNED_AGENT_PROFILES } from '../src/agents.js';
import { patchAgentInput, renderAdditionalContext, renderPreToolUseOutput, renderSystemMessage } from '../src/brief.js';
import { dispatchMarker } from '../src/claude-background.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import * as coordinator from '../src/coordinator.js';
import { runHook } from '../src/hook.js';
import { readJob } from '../src/job.js';
import { looksSecret } from '../src/outbound-text.js';
import { composeSingleWorkerPrompt, parseWorkerReply, workerReceipt, workerReceiptReply } from '../src/plan.js';
import { routingContext } from '../src/router-context.ts';
import { offerRoute } from '../src/router-selection.ts';
import { TIERS, type PlannedTask, type Receipt } from '../src/types.js';
import { CodexPolicy, DISPATCH_FAILED } from '../src/codex/policy.js';
import { AGENT_TOOL, codexGuidance } from '../src/codex/profiles.js';
import { CodexRpc } from '../src/codex/rpc.js';
import { routeCodex } from '../src/codex/router.js';
import { buildQuestions, buildState } from '../mods/router/hooks/policy.ts';
import { resolveConfig } from '../mods/router/hooks/config.ts';
import { createRouter, type TurnStepEvent } from '../mods/router/hooks/router.ts';
import { looksSecret as routerLooksSecret } from '../mods/router/hooks/secret.ts';
import { drain, fakeEngine, streamNext } from './router/fake-engine.ts';

it('N2: real plugin text producers pass both screens as whole strings and individual lines', async () => {
  const samples: Array<[string, string]> = [];
  const add = (producer: string, value: unknown): void => {
    if (typeof value === 'string') samples.push([producer, value]);
    else if (value && typeof value === 'object') {
      samples.push([producer, JSON.stringify(value)]);
      for (const [key, child] of Object.entries(value)) add(`${producer}.${key}`, child);
    }
  };
  const id = '12345678-1234-4234-8234-123456789abc', hash = '0123456789abcdef'.repeat(4);
  const path = `/tmp/jev-generated-${id}/src/rows.ts`, request = `Repair ${path}; run npm test and preserve the API.`;
  const brief = composeSingleWorkerPrompt(`Complete the repair in ${path}.`, request);
  add('dispatchMarker', dispatchMarker(id));
  // #289 removed this producer and all planner profiles; old in-flight text can still reach Router.
  add('legacy JEV_TASK', `[JEV_TASK rev=12 id=${id} attempt=2]`);
  add('buildAdmissionRequest', buildAdmissionRequest(request, DEFAULT_CONFIG));
  add('buildAtomicAdmissionRequest', buildAtomicAdmissionRequest(request, DEFAULT_CONFIG));
  const task: PlannedTask = { id, outcome: request, depends_on: [], context: brief, constraints: ['Preserve the API.'],
    deliverables: [path], checks: [], replan_if: [], contract_hash: hash };
  add('buildWorkerRouteRequest', buildWorkerRouteRequest(task, task.constraints, [], brief, 'standard', DEFAULT_CONFIG, null, request));
  add('buildAtomicWorkerRouteRequest', buildAtomicWorkerRouteRequest(task, task.constraints, [], brief, 'standard', DEFAULT_CONFIG, null, request));
  for (const mode of ['auto', 'native'] as const) for (const workerIsolation of ['none', 'worktree'] as const) {
    add('renderSingleGuidance', coordinator.renderSingleGuidance({ mode, workerIsolation, confidence: .97, superseded: true, preferFastWorker: true }));
  }
  for (const tier of TIERS) {
    add('renderRouteNote', coordinator.renderRouteNote(tier));
    add('renderSingleRouteNote', coordinator.renderSingleRouteNote(tier));
  }
  for (const reason of ['dispatch_ineligible', 'task_active', 'attempt_mismatch', 'stale_generation', 'bounds_exhausted'] as const) {
    add('renderDispatchDeny', coordinator.renderDispatchDeny(reason, `dispatch ${id}, rev=12, attempt=2, baseline ${hash}`));
  }
  const receipt: Receipt = { task_id: id, contract_hash: hash, rev: 12, attempt: 2, tool_use_id: `tool-${id}`,
    provenance: 'worker_reported', reply: { status: 'done', summary: 'Repair complete.', changed_files: [path], interfaces: ['parseRow(text: string): Row'],
      checks: [{ check_id: 'npm test', result: 'pass' }], blockers: [] }, verdict: 'accept', verdict_reason: null,
    observed_model: 'claude-sonnet-5-5', root_effort: 'high', recorded_at: '2026-10-21T01:02:03.000Z' };
  add('workerReceiptReply', workerReceiptReply(receipt.reply!));
  add('workerReceipt', workerReceipt(receipt));
  for (const verdict of ['accept', 'incomplete', 'unknown', 'invalid'] as const) {
    add('renderSingleResult', coordinator.renderSingleResult(verdict, 'worker_no_result', { formatHint: 'check #1' }));
    add('renderAdhocResult', coordinator.renderAdhocResult(verdict, 'worker_no_result', 'No verified pass is claimed.'));
    for (const rootFallbackReason of ['attempt_cap', 'accepted'] as const) {
      add('renderSingleResult fallback', coordinator.renderSingleResult(verdict, 'worker_no_result', { rootFallback: true, rootFallbackReason }));
    }
  }
  for (const single of [false, true]) for (const evidence of [false, true]) {
    add('renderWorkerDelivery', coordinator.renderWorkerDelivery({ ...receipt, ...(evidence ? {
      verification: { transcript: 'read', contradicted: [], stale: [], unobserved: ['npm test'] }, evidence_format_only: true,
      worker_worktree: { path: `/tmp/jev-worktrees/${id}`, branch: `jev-worker-${id}`, baseline: hash },
    } as const : {}) }, { single }));
  }
  for (const source of [null, 'omitted', request]) add('composeSingleWorkerPrompt', composeSingleWorkerPrompt(brief, source));
  add('composeSingleWorkerPrompt same source', composeSingleWorkerPrompt(request, request, true, true));
  for (const malformed of ['', '{}', '{"status":"wrong"}', '{"status":"done","summary":12}']) add('parseWorkerReply', parseWorkerReply(malformed));
  add('isolation instructions', [ISOLATION_NOTE, ISOLATION_COMMIT_INSTRUCTION]);
  const prompt = brief + coordinator.renderSingleRouteNote('standard') + `\n\n${ISOLATION_NOTE}` + dispatchMarker(id);
  const input = patchAgentInput({ prompt: brief }, { prompt, isolation: 'worktree', subagent_type: 'jev-gate:worker', model: 'sonnet' });
  add('patchAgentInput', input);
  add('renderPreToolUseOutput update', renderPreToolUseOutput({ kind: 'update', updatedInput: input }));
  add('renderPreToolUseOutput deny', renderPreToolUseOutput({ kind: 'deny', reason: coordinator.renderDispatchDeny('task_active') }));
  add('renderAdditionalContext', renderAdditionalContext('PostToolUse', coordinator.renderWorkerDelivery(receipt)));
  add('renderSystemMessage', renderSystemMessage(coordinator.BACKGROUND_GUIDANCE));
  add('routingContext', routingContext(prompt, coordinator.renderWorkerDelivery(receipt), [request], {
    model: 'claude-sonnet-5-5', input: 25000, read: 20000, write: 5000, ageMs: 100, epoch: hash,
  }));
  add('buildState root', buildState({ scope: 'root', text: prompt, previousReply: coordinator.renderWorkerDelivery(receipt) }));
  add('buildState spawn', buildState({ scope: 'spawn', text: prompt, description: request, subagentType: 'jev-gate:worker' }));
  add('buildQuestions', buildQuestions({ tiers: [...TIERS], efforts: ['low', 'medium', 'high', 'xhigh'] }));
  for (const scope of ['root', 'spawn', 'child'] as const) {
    const offer = offerRoute({ baseline: { model: 'fixture-standard', effort: 'high' }, candidates: TIERS.map((tier, rank) => ({
      id: `fixture-${tier}`, description: `${tier} coding model`, efforts: ['low', 'medium', 'high', 'xhigh'], omitEffort: true, rank,
    })), model: true, effort: true, upgrade: .9, downgrade: .95, scope });
    expect(offer).not.toBeNull(); add(`offerRoute ${scope}`, offer?.questions);
  }
  const resolved = resolveConfig({ enabled: true, allowFable: false });
  if (!resolved.ok) throw Error(resolved.field);
  const router = createRouter(resolved.config, undefined, true), f = fakeEngine({ respond: () => ({ status: 503, text: '{}' }) });
  const model = 'claude-opus-5-5';
  f.engine.dispatchPair = async () => ({ model, effort_edit: { kind: 'set', value: 'high' } });
  f.engine.childContext = async () => ({ messages: 8, coverage: 'available', tools: [{ name: 'Read', state: 'done' }] });
  await router.agentSpawn(f.engine, { tool_use_id: id, prompt: brief, description: request, subagentType: 'jev-gate:worker',
    provider: { plugin: 'jev-gate', tier: 'plugin' }, parentModel: model, fork: false },
    Object.assign(async () => ({ agentId: id, model }), { signal: new AbortController().signal }));
  for (const index of [0, 1]) await drain(router.turnStep(f.engine, { agentId: id, turnId: id, index, model, effort: 'high' }, streamNext<TurnStepEvent>().next));
  expect(f.sent).toHaveLength(1);
  add('Router child request', { state: f.sent[0]!.state, questions: f.sent[0]!.questions });
  router.turnStart({ turnId: `root-${id}`, text: request });
  await drain(router.turnStep(f.engine, { turnId: `root-${id}`, index: 0, model, effort: 'high' }, streamNext<TurnStepEvent>().next));
  expect(f.sent).toHaveLength(2);
  add('Router root request', { state: f.sent[1]!.state, questions: f.sent[1]!.questions });
  const profiles = Object.fromEntries(OWNED_AGENT_PROFILES.map(profile => {
    const text = readFileSync(new URL(`../agents/${profile.file}`, import.meta.url), 'utf8');
    add(`agents/${profile.file}`, text);
    return [profile.name, text.replace(/^---\n[\s\S]*?\n---\n/, '')];
  }));
  add('OWNED_AGENT_PROFILES', OWNED_AGENT_PROFILES);
  add('Codex embedded profiles', profiles);
  add('codexGuidance', codexGuidance(coordinator.renderSingleGuidance({ mode: 'native', confidence: null, superseded: true })));
  add('AGENT_TOOL', AGENT_TOOL); add('DISPATCH_FAILED', DISPATCH_FAILED);
  add('plugins/codex skill', readFileSync(new URL('../plugins/codex/skills/jev-gate/SKILL.md', import.meta.url), 'utf8'));

  // Real host producers with only temporary state and fake native RPC; no CLI, credentials or live worker.
  const root = mkdtempSync('/tmp/jev-generated-text-'), incoming = new PassThrough(), outgoing = new PassThrough();
  const rpc = new CodexRpc(incoming, outgoing);
  try {
    const cfg = join(root, 'config.json');
    writeFileSync(cfg, JSON.stringify({ version: 5, mode: 'native' }));
    const env = { HOME: root, JEV_GATE_CONFIG: cfg, JEV_GATE_STATE_DIR: join(root, 'state'), JEV_GATE_TRACE_DIR: join(root, 'trace'),
      CLAUDE_CODE_FORK_SUBAGENT: '0', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0', JEV_GATE_EXPERIMENT_ADMISSION: 'orchestrated' };
    const hook = await runHook({ env, stdin: (async function* () { yield JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: id, prompt_id: id, prompt: request }); })() });
    expect(hook.kind).toBe('guidance'); add('runHook context', hook.stdout);
    const codexCfg = join(root, 'codex.json');
    writeFileSync(codexCfg, JSON.stringify({ gate: { mode: 'native' }, router: { enabled: false } }));
    const policy = new CodexPolicy(rpc, { ...env, JEV_CODEX_CONFIG: codexCfg, JEV_CODEX_TRACE_DIR: join(root, 'codex-trace') }, undefined, profiles, true);
    const returned: string[] = [];
    outgoing.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        const m = JSON.parse(line), p = m.params;
        if (m.result?.contentItems) for (const item of m.result.contentItems) if (item.text) returned.push(item.text);
        if (p?.developerInstructions) add('Codex thread instructions', p.developerInstructions);
        if (m.method === 'turn/start') add('Codex worker prompt', p.input);
        const result = m.method === 'hooks/list' ? { data: [{ hooks: ['sessionStart', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop'].map(eventName => ({
          eventName, key: eventName, source: 'plugin', pluginId: 'jev-gate@fixture', enabled: true,
        })) }] } : m.method === 'config/read' ? { config: {} }
          : m.method === 'thread/start' ? { model: 'gpt-6.1-sol', cwd: root, sandbox: { type: 'dangerFullAccess' }, thread: { id: `worker-${id}` } }
          : m.method === 'turn/start' ? { turn: { id: `turn-${id}` } } : {};
        if (m.method) incoming.write(JSON.stringify({ id: m.id, result }) + '\n');
      }
    });
    policy.catalog = [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }];
    await rpc.onResponse({ model: 'gpt-6.1-sol', cwd: root, sandbox: { type: 'dangerFullAccess' }, thread: { id } }, 'thread/start', {});
    const parent = policy.sessions.get(id)!; parent.prompt = id; parent.controller = new AbortController(); parent.tokens = 500000;
    add('Codex nativeHook guidance', await policy.nativeHook({ hook_event_name: 'UserPromptSubmit', session_id: id, prompt: request }));
    await rpc.onRequest({ id: 'launch', method: 'item/tool/call', params: { threadId: id, callId: `dispatch-${id}`, tool: 'jev_agent', arguments: {
      subagent_type: 'jev-gate:worker', prompt: request, run_in_background: true,
    } } });
    expect(returned).toHaveLength(1); expect(returned[0]).toContain('Worker started in the background.');
    add('Codex launch receipt', returned[0]);
    add('Codex active context', await policy.nativeHook({ hook_event_name: 'UserPromptSubmit', session_id: id, prompt: 'Report progress.' }));
    rpc.onNotification({ method: 'item/completed', params: { threadId: `worker-${id}`, item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(receipt.reply) } } });
    rpc.onNotification({ method: 'turn/completed', params: { threadId: `worker-${id}`, turn: { id: `turn-${id}`, status: 'completed' } } });
    await vi.waitFor(() => {
      const job = readJob({ JEV_GATE_STATE_DIR: join(root, 'state', 'codex') }, id);
      expect(job.ok && job.value?.current.receipts).toHaveLength(1);
    });
    await rpc.onRequest({ id: 'status', method: 'item/tool/call', params: { threadId: id, tool: 'jev_agent', arguments: { action: 'status', agent_id: `worker-${id}` } } });
    expect(returned).toHaveLength(2); add('Codex result receipt', returned[1]);
    add('Codex delivery context', await policy.nativeHook({ hook_event_name: 'UserPromptSubmit', session_id: id, prompt: 'Explain the result.' }));
    for (const scope of ['root', 'child'] as const) {
      const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
        add(`routeCodex ${scope} request`, JSON.parse(String(init?.body)));
        return new Response('', { status: 503 });
      });
      await routeCodex({ model: 'gpt-6.1-sol', effort: 'medium', task: brief, session: id, prompt: id,
        catalog: [{ model: 'gpt-6.1-sol', supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort })) }],
        config: { ...parent.policy, router: { ...parent.policy.router, enabled: true } }, env: { TYPESAFE_API_KEY: 'fake-local-screen-test' }, fetchImpl,
        ...(scope === 'child' ? { child: { agentId: id, step: 1, context: { messages: 8, coverage: 'available', tools: [{ name: 'Read', state: 'done' }] } } } : {}) });
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  } finally { rpc.close(); incoming.destroy(); outgoing.destroy(); rmSync(root, { recursive: true, force: true }); }

  for (const [producer, text] of samples) for (const [screen, check] of [['core', looksSecret], ['Router', routerLooksSecret]] as const) {
    expect.soft(check(text), `${producer}: ${screen} whole string`).toBe(false);
    for (const [i, line] of text.split('\n').entries()) expect.soft(check(line), `${producer}: ${screen} line ${i + 1}`).toBe(false);
  }
});
