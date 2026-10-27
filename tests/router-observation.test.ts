import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { normalizeUsage } from '../src/cost.js';
import { routerObservation } from '../src/router-observation.js';
import { readRouterObservation, reconcileRouterResult, transcriptOf } from '../src/claude-router-observation.js';
import { setRecording } from '../src/recording.js';

const model = 'claude-opus-5-5', since = Date.parse('2026-10-20T00:00:00Z');
const raw = { model, input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 10 };
const rows = (effort: unknown = 'low', creation: unknown = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 }) => [
  { type: 'api-request', id: 'request-1', sessionId: 'session', timestamp: new Date(since).toISOString(), params: { model, output_config: { effort } }, tail: 'PRIVATE TASK TEXT' },
  { type: 'assistant', requestRef: 'request-1', sessionId: 'session', message: { model, usage: { ...raw, cache_creation: creation }, content: 'PRIVATE ANSWER' } },
];
const lines = (rs: unknown[]) => rs.map(r => JSON.stringify(r)).join('\n') + '\n';
let temp: string;
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });
const exec = promisify(execFile);
let bundleDir: string;
beforeAll(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'jev-router-observation-cli-'));
  execFileSync(process.execPath, ['scripts/build-claude-router.mjs', join(bundleDir, 'observe.mjs')]);
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

describe('Router transcript evidence', () => {
  it.each(['low', 'medium', 'high', 'xhigh', 'max', 16000])('reads applied effort and TTL from the exact linked request: %s', effort => {
    const result = routerObservation(lines(rows(effort)), 'session', '', since, raw);
    expect(result).toMatchObject({ effort, request: 'request-1', model, usage: { write5m: 0, write1h: 20, coverage: 'complete' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('keeps absent effort and TTL absent, independently', () => {
    expect(routerObservation(lines(rows(null, null)), 'session', '', since, raw)).toMatchObject({ effort: null, usage: { write5m: null, write1h: null } });
  });
  it.each(['stale', 'session', 'agent', 'reference', 'model', 'counters', 'ambiguous'])('does not reuse unrelated evidence: %s', kind => {
    const rs: any[] = rows();
    if (kind === 'stale') rs[0].timestamp = new Date(since - 1).toISOString();
    if (kind === 'session') rs[1].sessionId = 'other';
    if (kind === 'agent') rs[1].agentId = 'child';
    if (kind === 'reference') rs[1].requestRef = 'other';
    if (kind === 'model') rs[0].params.model = 'claude-sonnet-5-5';
    if (kind === 'counters') rs[1].message.usage.output_tokens++;
    if (kind === 'ambiguous') rs.push({ ...rs[0], id: 'request-2' }, { ...rs[1], requestRef: 'request-2' });
    expect(routerObservation(lines(rs), 'session', '', since, raw)).toBeNull();
  });
  it('excludes requests started after the response completed', () => {
    const evidence: any[] = rows();
    evidence[0].timestamp = new Date(since + 101).toISOString();
    expect(routerObservation(lines(evidence), 'session', '', since, raw, since + 100)).toBeNull();
    expect(routerObservation(lines([...rows(), ...evidence.map((r, i) => ({ ...r, ...(i ? { requestRef: 'request-2' } : { id: 'request-2' }) }))]), 'session', '', since, raw, since + 100)?.request).toBe('request-1');
  });
  it('reads root and child tails, skips malformed lines and rejects symlinks', () => {
    temp = mkdtempSync(join(tmpdir(), 'jev-router-observation-'));
    const path = join(temp, 'session.jsonl');
    writeFileSync(path, 'malformed\n' + lines(rows()));
    expect(readRouterObservation(path, 'session', '', since, raw)?.effort).toBe('low');
    const dir = join(temp, 'session', 'subagents'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-child.jsonl'), lines(rows().map(r => ({ ...r, agentId: 'child' }))));
    expect(readRouterObservation(path, 'session', 'child', since, raw)?.effort).toBe('low');
    const link = join(temp, 'linked.jsonl'); symlinkSync(path, link);
    expect(readRouterObservation(link, 'session', '', since, raw)).toBeNull();
    expect(readRouterObservation(path, 'session', '../escape', since, raw)).toBeNull();
    writeFileSync(path, lines(rows()) + 'x'.repeat(1024 * 1024));
    expect(readRouterObservation(path, 'session', '', since, raw)).toBeNull();
  });
  it('finds the main transcript by session id under the host config directory', () => {
    temp = mkdtempSync(join(tmpdir(), 'jev-router-transcript-'));
    const env = { CLAUDE_CONFIG_DIR: temp }, id = '27b57a54-62ad-4851-89ec-31ccef1abbf3';
    expect(transcriptOf(id, env)).toBeNull();
    mkdirSync(join(temp, 'projects', '-Users-a-repo'), { recursive: true }); mkdirSync(join(temp, 'projects', '-Users-a-other'));
    const path = join(temp, 'projects', '-Users-a-repo', `${id}.jsonl`); writeFileSync(path, '');
    expect(transcriptOf(id, env)).toBe(path);
    expect(transcriptOf(id, { HOME: temp })).toBeNull();
    expect(transcriptOf('../projects', env)).toBeNull();
    writeFileSync(join(temp, 'projects', '-Users-a-other', `${id}.jsonl`), '');
    expect(transcriptOf(id, env)).toBeNull();
  });
  it.each(['root', 'child', 'new_file'])('links %s evidence flushed after the old 300 ms window through the real helper process', async kind => {
    temp = mkdtempSync(join(tmpdir(), 'jev-router-delayed-'));
    const project = join(temp, 'projects', 'repo'); mkdirSync(project, { recursive: true });
    const path = join(project, 'session.jsonl'), agent = kind === 'child' ? 'child' : '';
    const evidence = rows('xhigh').map(r => ({ ...r, ...(agent ? { agentId: agent } : {}) }));
    const file = agent ? join(project, 'session', 'subagents', 'agent-child.jsonl') : path;
    if (kind !== 'new_file') {
      writeFileSync(path, ''); mkdirSync(join(project, 'session', 'subagents'), { recursive: true });
      writeFileSync(file, lines(evidence.slice(0, 1)));
    }
    const timer = setTimeout(() => writeFileSync(file, lines(evidence)), kind === 'new_file' ? 1100 : 800);
    try {
      const { stdout } = await exec(process.execPath, [join(bundleDir, 'observe.mjs'), 'session', agent, String(since), JSON.stringify(raw)], { env: { ...process.env, CLAUDE_CONFIG_DIR: temp }, timeout: 2500 });
      expect(JSON.parse(stdout)).toMatchObject({ request: 'request-1', effort: 'xhigh', usage: { write1h: 20 } });
      expect(stdout).not.toContain('PRIVATE');
    } finally { clearTimeout(timer); }
  });
  it.each(['absent', 'ambiguous', 'past_deadline'])('bounds the helper process and keeps %s evidence unknown', async kind => {
    temp = mkdtempSync(join(tmpdir(), 'jev-router-unknown-'));
    const project = join(temp, 'projects', 'repo'); mkdirSync(project, { recursive: true });
    const path = join(project, 'session.jsonl'), evidence = rows();
    if (kind === 'ambiguous') writeFileSync(path, lines([...evidence, { ...evidence[0], id: 'request-2' }, { ...evidence[1], requestRef: 'request-2' }]));
    const timer = kind === 'past_deadline' ? setTimeout(() => writeFileSync(path, lines(evidence)), 2200) : undefined;
    try {
      const { stdout } = await exec(process.execPath, [join(bundleDir, 'observe.mjs'), 'session', '', String(since), JSON.stringify(raw)], { env: { ...process.env, CLAUDE_CONFIG_DIR: temp }, timeout: 2000 });
      expect(JSON.parse(stdout)).toBeNull();
    } finally { clearTimeout(timer); }
  });
  it.each(['root', 'child'])('reconciles %s evidence flushed only after the hook process returns, without another request', async kind => {
    temp = mkdtempSync(join(tmpdir(), 'jev-router-deferred-'));
    const project = join(temp, 'projects', 'repo'), trace = join(temp, 'trace');
    mkdirSync(project, { recursive: true }); mkdirSync(trace);
    const agent = kind === 'child' ? 'child' : '';
    const path = join(project, 'session.jsonl'); writeFileSync(path, '');
    const file = agent ? join(project, 'session', 'subagents', 'agent-child.jsonl') : path;
    if (agent) mkdirSync(join(project, 'session', 'subagents'), { recursive: true });
    const evidence = rows('xhigh').map(r => ({ ...r, ...(agent ? { agentId: agent } : {}) }));
    const record = join(trace, 'mod_router-12345678-1234-1234-1234-123456789012.json');
    const original = { phase: 'mod_router', event: agent ? 'child_result' : 'root_result', session_id: 'session', agent_id: agent || null,
      invocation_id: '12345678-1234-1234-1234-123456789012', recording_id: 'recording', written_at: new Date().toISOString(),
      turn: 'original-turn', index: 0, requested: model, observed: model, requested_effort: 'low', observed_effort: 'unknown',
      effort_evidence: 'unobserved', request_ref: null, accounting: normalizeUsage('claude', raw),
      observation_since: since, observation_until: since + 1000 };
    writeFileSync(record, JSON.stringify(original));
    const { stdout } = await exec(process.execPath, [join(bundleDir, 'observe.mjs'), '--defer', record], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: temp, XDG_CONFIG_HOME: join(temp, 'config'), JEV_GATE_TRACE_DIR: trace }, timeout: 2000,
    });
    expect(JSON.parse(stdout)).toEqual({ started: true });
    expect(JSON.parse(readFileSync(record, 'utf8')).request_ref).toBeNull();
    // A synchronous wait cannot see these bytes: the caller releases them after its subprocess has exited.
    await new Promise(resolve => setTimeout(resolve, 2200));
    writeFileSync(file, lines(evidence));
    const deadline = Date.now() + 3000;
    while (JSON.parse(readFileSync(record, 'utf8')).request_ref === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const result = JSON.parse(readFileSync(record, 'utf8'));
    expect(result).toMatchObject({ ...original, observed_effort: 'xhigh', effort_evidence: 'transcript_api_request', request_ref: 'request-1',
      accounting: { ...original.accounting, write5m: 0, write1h: 20 }, observation_status: 'resolved' });
    expect(result.observation_reconciled_at).toBeTypeOf('string');
    expect(readdirSync(trace)).toEqual([record.split('/').at(-1)]);
    expect(statSync(record).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each(['absent', 'ambiguous', 'future', 'changed'])('keeps deferred %s evidence unknown without duplicating or overwriting records', async kind => {
    temp = mkdtempSync(join(tmpdir(), 'jev-router-deferred-unknown-'));
    const project = join(temp, 'projects', 'repo'), trace = join(temp, 'trace');
    mkdirSync(project, { recursive: true }); mkdirSync(trace);
    const path = join(project, 'session.jsonl'), record = join(trace, 'mod_router-12345678-1234-1234-1234-123456789012.json');
    const original = { phase: 'mod_router', event: 'root_result', session_id: 'session', invocation_id: '12345678-1234-1234-1234-123456789012',
      observed: model, observed_effort: 'unknown', request_ref: null, accounting: normalizeUsage('claude', raw), observation_since: since, observation_until: since + 100 };
    writeFileSync(record, JSON.stringify(original));
    const evidence: any[] = rows();
    if (kind === 'ambiguous') evidence.push({ ...evidence[0], id: 'request-2' }, { ...evidence[1], requestRef: 'request-2' });
    if (kind === 'future') evidence[0].timestamp = new Date(since + 101).toISOString();
    if (kind !== 'absent' && kind !== 'changed') writeFileSync(path, lines(evidence));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: temp, XDG_CONFIG_HOME: join(temp, 'config'), JEV_GATE_TRACE_DIR: trace };
    const pending = reconcileRouterResult(record, env, 150);
    if (kind === 'changed') writeFileSync(record, JSON.stringify({ ...original, external_update: true }));
    await pending;
    const result = JSON.parse(readFileSync(record, 'utf8'));
    expect(result.request_ref).toBeNull();
    expect(result.observed_effort).toBe('unknown');
    if (kind === 'changed') expect(result).toEqual({ ...original, external_update: true });
    else expect(result.observation_status).toBe('unavailable');
    expect(readdirSync(trace)).toEqual([record.split('/').at(-1)]);
  });
  it('stops reconciliation if recording is turned off while evidence is pending', async () => {
    temp = mkdtempSync(join(tmpdir(), 'jev-router-deferred-off-'));
    const project = join(temp, 'projects', 'repo'), trace = join(temp, 'trace');
    mkdirSync(project, { recursive: true }); mkdirSync(trace);
    const record = join(trace, 'mod_router-12345678-1234-1234-1234-123456789012.json');
    const original = { phase: 'mod_router', event: 'root_result', session_id: 'session', invocation_id: '12345678-1234-1234-1234-123456789012',
      observed: model, observed_effort: 'unknown', request_ref: null, accounting: normalizeUsage('claude', raw), observation_since: since, observation_until: since + 100 };
    writeFileSync(record, JSON.stringify(original));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: temp, XDG_CONFIG_HOME: join(temp, 'config'), JEV_GATE_TRACE_DIR: trace };
    const pending = reconcileRouterResult(record, env, 200);
    setRecording(env, false);
    writeFileSync(join(project, 'session.jsonl'), lines(rows()));
    await pending;
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual(original);
  });

});
