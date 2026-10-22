import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { routerObservation } from '../src/router-observation.js';
import { readRouterObservation, transcriptOf } from '../src/claude-router-observation.js';

const model = 'claude-opus-5-5', since = Date.parse('2026-10-20T00:00:00Z');
const raw = { model, input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 10 };
const rows = (effort: unknown = 'low', creation: unknown = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 }) => [
  { type: 'api-request', id: 'request-1', sessionId: 'session', timestamp: new Date(since).toISOString(), params: { model, output_config: { effort } }, tail: 'PRIVATE TASK TEXT' },
  { type: 'assistant', requestRef: 'request-1', sessionId: 'session', message: { model, usage: { ...raw, cache_creation: creation }, content: 'PRIVATE ANSWER' } },
];
const lines = (rs: unknown[]) => rs.map(r => JSON.stringify(r)).join('\n') + '\n';
let temp: string;
afterEach(() => { if (temp) rmSync(temp, { recursive: true, force: true }); });

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
});
