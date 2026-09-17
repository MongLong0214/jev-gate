import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { splitLossless } from './blocks.js';
import { NEUTRAL_REMINDER, renderAdditionalContext } from './brief.js';
import { loadConfig, type Env } from './config.js';
import { buildJevRequest, callJev, decide } from './jev.js';
import type { ErrorCode, GateDecision, HookInput, JevUsage, PromptBlock } from './types.js';
import { NATIVE_FALLBACK_DECISION } from './types.js';

export const MAX_STDIN_BYTES = 256 * 1024;
export const MAX_PROMPT_BYTES = 64 * 1024;

export interface TraceFs {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, data: string): Promise<void>;
}

export interface HookDeps {
  stdin: AsyncIterable<Uint8Array | string>;
  env: Env;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  traceFs?: TraceFs;
}

export type HookResult =
  | { kind: 'skip'; code: ErrorCode | null; stdout: null }
  | { kind: 'output' | 'fallback'; code: ErrorCode | null; stdout: string };

export interface TraceRecord {
  version: 3;
  invocation_id: string;
  event: 'UserPromptSubmit';
  session_id: string | null;
  cwd: string | null;
  permission_mode: string | null;
  started_at: string;
  mode: string | null;
  config_source: string | null;
  durations_ms: { total: number; jev: number | null };
  input: { prompt: string; blocks: PromptBlock[] } | null;
  jev: {
    called: boolean;
    status: number | null;
    model: string | null;
    usage: JevUsage | null;
    request_bytes: number | null;
    response_bytes: number | null;
    answers: Record<string, unknown> | null;
  };
  decision: GateDecision;
  error_code: ErrorCode | null;
  output: { kind: HookResult['kind']; additionalContext: string | null };
}

const defaultTraceFs: TraceFs = {
  mkdir: async (p) => {
    await mkdir(p, { recursive: true });
  },
  writeFile: async (p, d) => {
    await writeFile(p, d, { encoding: 'utf8', flag: 'wx' });
  },
};

export const formatOutput = (additionalContext: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } });

const readAll = async (stdin: AsyncIterable<Uint8Array | string>): Promise<{ text: string } | { code: ErrorCode }> => {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stdin) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
      total += buf.byteLength;
      if (total > MAX_STDIN_BYTES) return { code: 'stdin_too_large' };
      chunks.push(buf);
    }
  } catch {
    return { code: 'stdin_read_failed' };
  }
  return { text: Buffer.concat(chunks).toString('utf8') };
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const parseInput = (text: string): HookInput | { code: ErrorCode } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { code: 'stdin_invalid_json' };
  }
  if (!isRecord(parsed) || typeof parsed['hook_event_name'] !== 'string') return { code: 'stdin_invalid_json' };
  const str = (k: string): string | undefined => (typeof parsed[k] === 'string' ? (parsed[k] as string) : undefined);
  const out: HookInput = { hook_event_name: parsed['hook_event_name'] as string };
  for (const k of ['prompt', 'session_id', 'cwd', 'transcript_path', 'permission_mode', 'agent_id', 'agent_type'] as const) {
    const v = str(k);
    if (v !== undefined) out[k] = v;
  }
  return out;
};

const isSlashCommand = (prompt: string): boolean => prompt.trimStart().startsWith('/');

/**
 * readHookInput → loadConfig → splitLossless → evaluateWithJev → renderAdditionalContext → writeHookOutput.
 * Never blocks the prompt: unsupported input is silent, any failure after a valid prompt yields the neutral reminder.
 */
export const runHook = async (deps: HookDeps): Promise<HookResult> => {
  const startedAt = new Date();
  const t0 = performance.now();
  const traceFs = deps.traceFs ?? defaultTraceFs;
  const traceDir = deps.env['JEV_GATE_TRACE_DIR'];
  const trace: TraceRecord = {
    version: 3,
    invocation_id: randomUUID(),
    event: 'UserPromptSubmit',
    session_id: null,
    cwd: null,
    permission_mode: null,
    started_at: startedAt.toISOString(),
    mode: null,
    config_source: null,
    durations_ms: { total: 0, jev: null },
    input: null,
    jev: { called: false, status: null, model: null, usage: null, request_bytes: null, response_bytes: null, answers: null },
    decision: NATIVE_FALLBACK_DECISION,
    error_code: null,
    output: { kind: 'skip', additionalContext: null },
  };
  const fallback = (code: ErrorCode): HookResult => ({ kind: 'fallback', code, stdout: formatOutput(NEUTRAL_REMINDER) });
  const skip = (code: ErrorCode | null = null): HookResult => ({ kind: 'skip', code, stdout: null });

  const finish = async (result: HookResult): Promise<HookResult> => {
    trace.durations_ms.total = Math.round(performance.now() - t0);
    trace.error_code = result.code;
    trace.output = { kind: result.kind, additionalContext: result.kind === 'skip' ? null : JSON.parse(result.stdout).hookSpecificOutput.additionalContext };
    if (!traceDir || result.kind === 'skip') return result;
    try {
      await traceFs.writeFile(join(traceDir, `hook-${trace.invocation_id}.json`), JSON.stringify(trace, null, 2));
      return result;
    } catch {
      const degraded = fallback('trace_write_failed');
      return degraded;
    }
  };

  const read = await readAll(deps.stdin);
  if ('code' in read) return skip(read.code);
  const input = parseInput(read.text);
  if ('code' in input) return skip(input.code);
  if (input.hook_event_name !== 'UserPromptSubmit') return skip();
  if (input.agent_id) return skip();
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) return skip();
  if (isSlashCommand(prompt)) return skip();
  trace.session_id = input.session_id ?? null;
  trace.cwd = input.cwd ?? null;
  trace.permission_mode = input.permission_mode ?? null;

  if (traceDir) {
    try {
      await traceFs.mkdir(traceDir);
    } catch {
      return fallback('trace_dir_unwritable');
    }
  }
  const loaded = loadConfig(deps.env);
  trace.config_source = loaded.source;
  if (!loaded.ok) return finish(fallback('config_invalid'));
  const config = loaded.config;
  trace.mode = config.mode;
  if (config.mode === 'off') return skip();
  if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) return finish(fallback('prompt_too_large'));
  const apiKey = deps.env['TYPESAFE_API_KEY'];
  if (!apiKey) return finish(fallback('key_missing'));

  const blocks = splitLossless(prompt);
  trace.input = { prompt, blocks };
  const mode = config.mode;
  const request = buildJevRequest(blocks, config, mode);
  const outcome = await callJev(request, { apiKey, deadlineMs: config.requestDeadlineMs, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.signal ? { signal: deps.signal } : {}) });
  trace.jev.called = true;
  trace.jev.status = outcome.status;
  trace.jev.request_bytes = outcome.requestBytes;
  trace.durations_ms.jev = outcome.durationMs;
  if (!outcome.ok) return finish(fallback(outcome.code));
  trace.jev.model = outcome.response.model;
  trace.jev.usage = outcome.response.usage;
  trace.jev.response_bytes = outcome.response.bytes;
  trace.jev.answers = outcome.response.answers;

  const decided = decide(outcome.response.answers, blocks, config, mode);
  trace.decision = decided.decision;
  if (decided.code) return finish(fallback(decided.code));
  const context = renderAdditionalContext(decided.decision, blocks, config);
  if (context === null) return finish(fallback('brief_too_large'));
  return finish({ kind: 'output', code: null, stdout: formatOutput(context) });
};

const isMainModule = (): boolean => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMainModule()) {
  runHook({ stdin: process.stdin, env: process.env })
    .then((result) => {
      if (result.stdout !== null) process.stdout.write(result.stdout + '\n');
      if (result.code) process.stderr.write(`jev-gate: ${result.code}\n`);
      process.exitCode = 0;
    })
    .catch(() => {
      process.stdout.write(formatOutput(NEUTRAL_REMINDER) + '\n');
      process.stderr.write('jev-gate: internal\n');
      process.exitCode = 0;
    });
}
