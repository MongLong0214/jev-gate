#!/usr/bin/env node
// Fake `claude` CLI for the offline bench regression. It edits files and prints native-shaped stream-json,
// but it is not evidence of OAuth, real model behavior or real Agent execution.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (argv[0] === '--version') {
  process.stdout.write('9.9.9 (fake Claude Code)\n');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  process.stdout.write((process.env.FAKE_CLAUDE_AUTH ?? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'test' })) + '\n');
  process.exit(0);
}
if (!argv.includes('-p')) {
  process.stderr.write('fake claude: only -p is supported\n');
  process.exit(64);
}
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const model = opt('--model') ?? 'sonnet';
const pluginDir = opt('--plugin-dir');
const mode = process.env.JEV_GATE_MODE;
const traceDir = process.env.JEV_GATE_TRACE_DIR;
const cwd = process.cwd();
const prompt = readFileSync(0, 'utf8');
const sid = randomUUID();
const modelId = model === 'fable' ? 'claude-fable-5-1' : model === 'opus' ? 'claude-opus-5' : 'claude-sonnet-5';

out({
  type: 'system',
  subtype: 'init',
  session_id: sid,
  cwd,
  model: modelId,
  tools: ['Read', 'Edit', 'Write', 'Bash', 'Agent'],
  permissionMode: opt('--permission-mode') ?? 'default',
  plugins: pluginDir ? [{ name: 'jev-gate', path: pluginDir }] : [],
  fake: { argv, env: { JEV_GATE_MODE: mode ?? null, JEV_GATE_TRACE_DIR: traceDir ?? null }, prompt },
});

if (process.env.FAKE_CLAUDE_HANG === '1') {
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  setInterval(() => undefined, 1000);
} else {
  const gated = Boolean(pluginDir) && mode === 'auto';
  const delegates = gated && process.env.FAKE_CLAUDE_IGNORE_HINT !== '1';
  const correct = model === 'fable' || gated;
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'answer.mjs'), `export const answer = () => ${correct ? 42 : 43};\n`);
  mkdirSync(join(cwd, 'scratch'), { recursive: true });
  writeFileSync(join(cwd, 'scratch', 'note.txt'), 'new file that .gitignore ignores\n');
  writeFileSync(join(cwd, '.gitignore'), 'scratch/\n');

  const usage = { [modelId]: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 50, cacheCreationInputTokens: 10, costUSD: 0.01, contextWindow: 200000 } };
  let total = 0.01;
  const mainMsg = (content) => out({ type: 'assistant', parent_tool_use_id: null, session_id: sid, message: { id: `msg_${randomUUID()}`, model: modelId, role: 'assistant', content, usage: { input_tokens: 1000, output_tokens: 0 } } });
  if (delegates) {
    const toolId = 'toolu_agent_1';
    mainMsg([{ type: 'tool_use', id: toolId, name: 'Agent', input: { subagent_type: 'jev-gate:opus', description: 'fix answer', prompt, run_in_background: false } }]);
    out({ type: 'user', parent_tool_use_id: toolId, session_id: sid, message: { role: 'user', content: [{ type: 'text', text: prompt }] } });
    out({ type: 'assistant', parent_tool_use_id: toolId, session_id: sid, message: { id: 'msg_child', model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 800, output_tokens: 0 } } });
    out({ type: 'user', parent_tool_use_id: null, session_id: sid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, is_error: false, content: [{ type: 'text', text: 'Changed src/answer.mjs; ran node --test: pass' }] }] } });
    usage['claude-opus-5'] = { inputTokens: 800, outputTokens: 100, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.02, contextWindow: 200000 };
    total += 0.02;
  }
  mainMsg([{ type: 'text', text: 'Done.' }]);
  if (traceDir) {
    const decision = mode === 'auto'
      ? { kind: 'change', roles: { u1: 'goal' }, rawRoute: null, execution: 'delegate', tier: 'opus', agentName: 'jev-gate:opus', reason: 'selected' }
      : { kind: 'change', roles: { u1: 'goal' }, rawRoute: null, execution: 'main', tier: null, agentName: null, reason: 'enrich_only' };
    const trace = {
      version: 3, invocation_id: randomUUID(), event: 'UserPromptSubmit', session_id: sid, cwd, permission_mode: 'acceptEdits', started_at: new Date().toISOString(), mode, config_source: 'defaults',
      durations_ms: { total: 420, jev: 380 }, input: { prompt, blocks: [{ id: 'u1', start: 0, end: prompt.length, text: prompt }] },
      jev: { called: true, status: 200, model: 'jev-1.13.0', usage: { input_tokens: 500, output_tokens: 10 }, request_bytes: 2000, response_bytes: 900, answers: {} },
      decision, error_code: null, output: { kind: 'output', additionalContext: '[Jev Gate: fake]' },
    };
    writeFileSync(join(traceDir, `hook-${trace.invocation_id}.json`), JSON.stringify(trace));
  }
  out({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, duration_api_ms: 1000, num_turns: delegates ? 3 : 1, result: 'Done.', session_id: sid, total_cost_usd: total, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 }, modelUsage: usage, permission_denials: [] });
}
