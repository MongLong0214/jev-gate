#!/usr/bin/env node
// Fake `claude` CLI for the offline bench regression (V5 arms). It edits files and prints native-shaped stream-json and
// V5 hook trace records, but it is not evidence of OAuth, real model behavior or real Agent execution.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (argv[0] === '--version') { process.stdout.write('9.9.9 (fake Claude Code)\n'); process.exit(0); }
if (argv[0] === 'auth' && argv[1] === 'status') {
  if (process.env.FAKE_CLAUDE_AUTH_EXIT) { process.stdout.write((process.env.FAKE_CLAUDE_AUTH ?? 'null') + '\n'); process.exit(Number(process.env.FAKE_CLAUDE_AUTH_EXIT)); }
  process.stdout.write((process.env.FAKE_CLAUDE_AUTH ?? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'test' })) + '\n');
  process.exit(0);
}
if (!argv.includes('-p')) { process.stderr.write('fake claude: only -p is supported\n'); process.exit(64); }
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const model = opt('--model') ?? 'sonnet';
const pluginDir = opt('--plugin-dir');
const mode = process.env.JEV_GATE_MODE;
const traceDir = process.env.JEV_GATE_TRACE_DIR;
const forced = process.env.JEV_GATE_EXPERIMENT_ADMISSION === 'orchestrated';
const cwd = process.cwd();
const prompt = readFileSync(0, 'utf8');
const sid = randomUUID();
const promptId = randomUUID();
const modelId = model === 'fable' ? 'claude-fable-5-1' : model === 'opus' ? 'claude-opus-5' : 'claude-sonnet-5';
const hierarchy = Boolean(pluginDir) && (mode === 'native' || mode === 'auto');
const arm = !hierarchy ? (model === 'fable' ? 'frontier_native' : 'sonnet_native')
  : mode === 'auto' ? 'jev_hierarchy'
  : forced ? (model === 'fable' ? 'frontier_orchestrated' : 'orchestrated_control')
  : 'native_hierarchy';
const orchestrated = arm === 'jev_hierarchy' || forced;

const T0 = Date.now();
const at = (ms) => new Date(T0 + ms).toISOString();
const trace = (phase, body) => {
  if (!traceDir) return;
  const id = randomUUID();
  const { written_at = at(0), ...rest } = body;
  const record = { session_id: sid, prompt_id: promptId, caller: { agent_id: null, agent_type: null }, tool_use_id: null, mode, ...rest, invocation_id: id, phase, version: 5, written_at };
  writeFileSync(join(traceDir, `${phase}-${id}.json`), JSON.stringify(record, null, 2));
};
const jevBody = (inputTokens) => ({ model: 'jev-1.13.0', usage: { input_tokens: inputTokens, output_tokens: 12 }, response_bytes: 800 });
const choice = (value, confidence) => ({ type: 'choice', choice: value, probabilities: { [value]: confidence }, confidence });

out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: modelId, tools: ['Read', 'Edit', 'Write', 'Bash', 'Agent'], permissionMode: opt('--permission-mode') ?? 'default', plugins: pluginDir ? [{ name: 'jev-gate', path: pluginDir }] : [], agents: pluginDir ? ['Explore', 'jev-gate:planner', 'jev-gate:worker', 'jev-gate:worker-fast', 'jev-gate:worker-deep'] : ['Explore'] });

if (process.env.FAKE_CLAUDE_HANG === '1') {
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => undefined, 1000);
} else {
  const correct = model === 'fable' || hierarchy;
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'answer.mjs'), `export const answer = () => ${correct ? 42 : 43};\n`);
  mkdirSync(join(cwd, 'scratch'), { recursive: true });
  writeFileSync(join(cwd, 'scratch', 'note.txt'), 'new file that .gitignore ignores\n');
  writeFileSync(join(cwd, '.gitignore'), 'scratch/\n');
  writeFileSync(join(cwd, '.env'), 'FAKE_SECRET=should-not-be-copied\n');
  const usage = { [modelId]: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50, cacheCreationInputTokens: 10, costUSD: 0.01, contextWindow: 200000 } };
  let total = 0.01;
  const spend = (childModel, cost) => {
    const e = usage[childModel] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, contextWindow: 200000 };
    usage[childModel] = { ...e, inputTokens: e.inputTokens + 800, outputTokens: e.outputTokens + 100, costUSD: e.costUSD + cost };
    total += cost;
  };
  const mainMsg = (content) => out({ type: 'assistant', parent_tool_use_id: null, session_id: sid, message: { id: `msg_${randomUUID()}`, model: modelId, role: 'assistant', content, usage: { input_tokens: 1000, output_tokens: 0 } } });
  const child = (toolId, childModel, text, isError = false) => {
    out({ type: 'assistant', parent_tool_use_id: toolId, session_id: sid, message: { id: 'msg_child', model: childModel, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 800, output_tokens: 0 } } });
    out({ type: 'user', parent_tool_use_id: null, session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: isError, content: [{ type: 'text', text }] }] } });
  };
  const agentCall = (subagentType, description) => {
    const toolId = `toolu_${randomUUID().slice(0, 8)}`;
    mainMsg([{ type: 'tool_use', id: toolId, name: 'Agent', input: { subagent_type: subagentType, description, prompt } }]);
    return toolId;
  };

  // ---- Gate A
  if (arm === 'jev_hierarchy') {
    trace('admission_intent', { prompt_len: prompt.length, prompt_sha256: 'x'.repeat(64), request_bytes: 2000, written_at: at(0) });
    trace('admission_result', {
      prompt_len: prompt.length, prompt_sha256: 'x'.repeat(64), attempted: true,
      http: { status: 200, code: null, duration_ms: 310, request_bytes: 2000 }, jev: jevBody(300),
      answers: { execution: choice('orchestrated', 0.93) }, written_at: at(10),
    });
  } else if (hierarchy) {
    trace('admission_result', { attempted: false, known_not_sent: true, forced, decision: orchestrated ? 'orchestrated' : 'direct', reason: 'mode_native', written_at: at(0) });
  }

  if (hierarchy && !orchestrated) {
    // native_hierarchy: the main session delegates without a plan, and native mode records no allocation decision.
    const id = agentCall('jev-gate:worker', 'fix answer');
    child(id, 'claude-sonnet-5', 'done');
    spend('claude-sonnet-5', 0.02);
    trace('stop', { outcome: 'completed', written_at: at(1000) });
  } else if (orchestrated) {
    // ---- guard: the control arms try the tools the guard declines before they switch to delegation
    if (arm !== 'jev_hierarchy') {
      trace('guard', { tool_name: 'Read', allow: true, denials: 0, written_at: at(100) });
      for (const [i, tool] of ['Edit', 'Bash', 'Write'].entries()) trace('guard', { tool_name: tool, allow: false, denials: i, written_at: at(150 + i) });
    }

    // ---- planner
    const plannerId = agentCall('jev-gate:planner', 'plan the work');
    if (arm === 'jev_hierarchy') {
      trace('pre_intent', { tool_use_id: plannerId, role: 'planner', default_tier: 'deep', request_bytes: 4000, written_at: at(200) });
      trace('pre_result', {
        tool_use_id: plannerId, role: 'planner', default_tier: 'deep', attempted: true,
        http: { status: 200, code: null, duration_ms: 280, request_bytes: 4000 }, jev: jevBody(500),
        answers: { planning_tier: choice('deep', 0.88) }, written_at: at(210),
      });
    }
    child(plannerId, 'claude-opus-5', JSON.stringify({ status: 'ready', tasks: 3 }));
    spend('claude-opus-5', 0.05);
    trace('plan', { tool_use_id: plannerId, status: 'completed', outcome: 'ready', rev: 1, tasks: 3, carried_receipts: 0, written_at: at(5000) });

    // ---- workers: mixed tiers, one incomplete receipt, one advisory rework, one unknown status
    const COST = { 'claude-haiku-5': 0.004, 'claude-sonnet-5': 0.02, 'claude-opus-5': 0.05 };
    const workers = [
      { agent: 'jev-gate:worker-fast', tier: 'fast', task: 't1', base: 'claude-haiku-5', routed: 'claude-haiku-5', route: 'fast', start: 6000, end: 16000, duration: 9000, status: 'completed', verdict: 'accept', advisory: null, effort: null },
      { agent: 'jev-gate:worker', tier: 'standard', task: 't2', base: 'claude-sonnet-5', routed: 'claude-opus-5', route: 'deep', start: 7000, end: 17000, duration: 9500, status: 'completed', verdict: 'incomplete', advisory: null, effort: null },
      { agent: 'jev-gate:worker-deep', tier: 'deep', task: 't3', base: 'claude-opus-5', routed: 'claude-opus-5', route: 'deep', start: 20000, end: 30000, duration: 5000, status: 'completed', verdict: 'accept', advisory: 'rework', effort: 'high' },
      { agent: 'jev-gate:worker-fast', tier: 'fast', task: 't4', base: 'claude-haiku-5', routed: 'claude-haiku-5', route: 'fast', start: 31000, end: 32000, duration: 500, status: 'failed', verdict: 'unknown', advisory: null, effort: null },
    ];
    for (const w of workers) {
      const id = agentCall(w.agent, `task ${w.task}`);
      // Only Jev moves a call off the profile the coordinator chose; the control arms self-route and stay on it.
      const observed = arm === 'jev_hierarchy' ? w.routed : w.base;
      const sendGate = arm === 'jev_hierarchy' && process.env.FAKE_CLAUDE_MISSING_PRE !== '1';
      if (sendGate) {
        trace('pre_intent', { tool_use_id: id, role: 'worker', task_id: w.task, rev: 1, called_tier: w.tier, request_bytes: 3000, written_at: at(w.start) });
        if (process.env.FAKE_CLAUDE_INTENT_ONLY !== '1') {
          trace('pre_result', {
            tool_use_id: id, role: 'worker', task_id: w.task, rev: 1, called_tier: w.tier, attempted: true,
            http: { status: 200, code: null, duration_ms: 240, request_bytes: 3000 }, jev: jevBody(400),
            answers: { route: choice(w.route, 0.9), upgrade_basis: choice('unresolved_contract_reasoning', 0.86) }, written_at: at(w.start + 10),
          });
        }
      }
      child(id, observed, w.status === 'completed' ? JSON.stringify({ status: 'done', summary: w.task }) : 'interrupted', w.status !== 'completed');
      spend(observed, COST[observed]);
      if (arm === 'jev_hierarchy' && w.advisory) {
        trace('result_intent', { tool_use_id: id, task_id: w.task, rev: 1, deterministic: 'accept', request_bytes: 1500, written_at: at(w.end - 5) });
        trace('result_result', {
          tool_use_id: id, task_id: w.task, rev: 1, deterministic: 'accept', attempted: true,
          http: { status: 200, code: null, duration_ms: 190, request_bytes: 1500 }, jev: jevBody(200),
          answers: { result: choice(w.advisory, 0.91) }, written_at: at(w.end - 2),
        });
      }
      trace('post', {
        tool_use_id: id, task_id: w.task, rev: 1, attempt: 1, verdict: w.verdict,
        verdict_reason: w.verdict === 'accept' ? null : `the call reported status ${w.status}`,
        advisory: arm === 'jev_hierarchy' ? w.advisory : null, root_effort: w.effort,
        tool_response: { status: w.status, agentId: `a-${w.task}`, resolvedModel: observed, modelsUsed: [observed], totalDurationMs: w.duration, totalToolUseCount: 3, totalTokens: 999, usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 7, cache_read_input_tokens: 8 } },
        written_at: at(w.end),
      });
    }

    if (arm === 'jev_hierarchy') {
      // A paid allocation whose Agent call never reaches the stream, and a late result from a superseded generation.
      trace('pre_result', {
        tool_use_id: 'toolu_orphanpaid', role: 'worker', task_id: 't5', rev: 1, called_tier: 'standard', attempted: true,
        http: { status: 200, code: null, duration_ms: 200, request_bytes: 3000 }, jev: jevBody(120),
        answers: { route: choice('standard', 0.84), upgrade_basis: choice('no_specific_basis', 0.8) }, written_at: at(33000),
      });
      trace('post', { tool_use_id: 'toolu_lateresult', matched: false, orphaned: true, tool_response: { status: 'completed', resolvedModel: 'claude-sonnet-5', totalDurationMs: 1000 }, written_at: at(34000) });
    }
    trace('stop', { outcome: 'incomplete', written_at: at(35000) });
  }

  mainMsg([{ type: 'text', text: 'Done.' }]);
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1000, num_turns: hierarchy ? 3 : 1, result: 'Done.', session_id: sid, total_cost_usd: total, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }, modelUsage: usage, permission_denials: [] });
}
