#!/usr/bin/env node
// Fake `claude` CLI for the offline bench regression (V4 arms). It edits files and prints native-shaped stream-json and
// V4 hook trace records, but it is not evidence of OAuth, real model behavior or real Agent execution.
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
const fixed = Boolean(process.env.JEV_GATE_EXPERIMENT_ALLOCATION);
const cwd = process.cwd();
const prompt = readFileSync(0, 'utf8');
const sid = randomUUID();
const modelId = model === 'fable' ? 'claude-fable-5-1' : model === 'opus' ? 'claude-opus-5' : 'claude-sonnet-5';
const trace = (phase, body) => { if (!traceDir) return; const id = randomUUID(); writeFileSync(join(traceDir, `${phase}-${id}.json`), JSON.stringify({ ...body, version: 4, phase, invocation_id: id, written_at: new Date().toISOString(), session_id: sid, caller: { agent_id: null, agent_type: null } })); };

out({ type: 'system', subtype: 'init', session_id: sid, cwd, model: modelId, tools: ['Read', 'Edit', 'Write', 'Bash', 'Agent'], permissionMode: opt('--permission-mode') ?? 'default', plugins: pluginDir ? [{ name: 'jev-gate', path: pluginDir }] : [], agents: pluginDir ? ['Explore', 'jev-gate:planner', 'jev-gate:worker'] : ['Explore'] });
if (pluginDir && mode && mode !== 'off') trace('prompt', { tool_use_id: null, mode, injected: true, experimental_allocation: fixed });

if (process.env.FAKE_CLAUDE_HANG === '1') {
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => undefined, 1000);
} else {
  const hierarchy = Boolean(pluginDir) && (mode === 'native' || mode === 'auto');
  const correct = model === 'fable' || hierarchy;
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'answer.mjs'), `export const answer = () => ${correct ? 42 : 43};\n`);
  mkdirSync(join(cwd, 'scratch'), { recursive: true });
  writeFileSync(join(cwd, 'scratch', 'note.txt'), 'new file that .gitignore ignores\n');
  writeFileSync(join(cwd, '.gitignore'), 'scratch/\n');
  writeFileSync(join(cwd, '.env'), 'FAKE_SECRET=should-not-be-copied\n');
  const usage = { [modelId]: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50, cacheCreationInputTokens: 10, costUSD: 0.01, contextWindow: 200000 } };
  let total = 0.01;
  const mainMsg = (content) => out({ type: 'assistant', parent_tool_use_id: null, session_id: sid, message: { id: `msg_${randomUUID()}`, model: modelId, role: 'assistant', content, usage: { input_tokens: 1000, output_tokens: 0 } } });
  if (hierarchy) {
    const toolId = `toolu_${randomUUID().slice(0, 8)}`;
    const pin = mode === 'native' && !fixed;
    const input = { subagent_type: 'jev-gate:worker', description: 'fix answer', prompt, ...(pin ? { model: 'opus' } : {}) };
    const childModel = pin ? 'claude-opus-5' : 'claude-sonnet-5';
    const tiSummary = { subagent_type: 'jev-gate:worker', has_model: pin, model: pin ? 'opus' : null, run_in_background: null, prompt_len: prompt.length, has_hint_marker: false, control_keys: [] };
    mainMsg([{ type: 'tool_use', id: toolId, name: 'Agent', input }]);
    if (mode === 'native') trace('pre_result', { tool_use_id: toolId, mode, tool_input: tiSummary, attempted: false, known_not_sent: true, skip_code: 'mode_native' });
    if (mode === 'auto' && process.env.FAKE_CLAUDE_MISSING_PRE !== '1') {
      trace('pre_intent', { tool_use_id: toolId, mode, role: 'worker', tool_input: tiSummary, request_bytes: 3000, blocks: 1 });
      if (process.env.FAKE_CLAUDE_INTENT_ONLY !== '1') trace('pre_result', { tool_use_id: toolId, mode, role: 'worker', tool_input: tiSummary, attempted: true, http: { status: 200, code: null, duration_ms: 420, request_bytes: 3000 }, jev: { model: 'jev-1.13.0', usage: { input_tokens: 500, output_tokens: 10 }, response_bytes: 800 }, answers: {}, decision: { action: 'patch', tier: 'sonnet', kind: 'implement', reason: null }, patch: { model: 'sonnet', suffix_bytes: 120, output_bytes: 1500, emitted: true } });
    }
    out({ type: 'user', parent_tool_use_id: toolId, session_id: sid, message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
    out({ type: 'assistant', parent_tool_use_id: toolId, session_id: sid, message: { id: 'msg_child', model: childModel, role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 800, output_tokens: 0 } } });
    out({ type: 'user', parent_tool_use_id: null, session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: false, content: [{ type: 'text', text: 'Changed src/answer.mjs' }] }] } });
    const patched = mode === 'auto' && process.env.FAKE_CLAUDE_MISSING_PRE !== '1' && process.env.FAKE_CLAUDE_INTENT_ONLY !== '1';
    trace('post', { tool_use_id: toolId, mode, tool_input: { ...tiSummary, has_model: pin || patched, model: pin ? 'opus' : patched ? 'sonnet' : null, has_hint_marker: patched }, tool_response: { status: 'completed', agentId: 'a1', resolvedModel: childModel, modelsUsed: null, totalDurationMs: 4000, totalToolUseCount: 3, totalTokens: 999, usage: { input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 7, cache_read_input_tokens: 8 } }, duration_ms: 4100 });
    usage[childModel] = { inputTokens: (usage[childModel]?.inputTokens ?? 0) + 800, outputTokens: (usage[childModel]?.outputTokens ?? 0) + 100, cacheReadInputTokens: usage[childModel]?.cacheReadInputTokens ?? 0, cacheCreationInputTokens: usage[childModel]?.cacheCreationInputTokens ?? 0, costUSD: (usage[childModel]?.costUSD ?? 0) + 0.02, contextWindow: 200000 };
    total += 0.02;
  }
  mainMsg([{ type: 'text', text: 'Done.' }]);
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1000, num_turns: hierarchy ? 3 : 1, result: 'Done.', session_id: sid, total_cost_usd: total, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }, modelUsage: usage, permission_denials: [] });
}
