import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { claudeConfigDir } from './claude-setup.js';
import type { Env } from './config.js';

type Rec = Record<string, unknown>;
const object = (v: unknown): Rec | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null;
const token = (v: unknown): string | null => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) && !/sk-/i.test(v) ? v : null;
const stamp = (v: unknown): string | null => typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
const MAX_BYTES = 1_048_576;
const MAX_AGENTS = 16;
const MAX_TOOLS = 40;

export interface WorkerToolActivity {
  id: string;
  name: string;
  action: 'read' | 'edit' | 'write' | 'search' | 'test' | 'typecheck' | 'build' | 'lint' | 'git' | 'command' | 'tool';
  target: string | null;
  state: 'active' | 'done' | 'error' | 'unconfirmed';
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
}
export interface WorkerActivity {
  sessionId: string;
  agentId: string;
  promptId: string | null;
  callId?: string | null;
  role: 'planner' | 'worker' | 'agent';
  taskId: string | null;
  state: 'active' | 'completed' | 'failed' | 'unknown';
  lastAt: string;
  coverage: 'complete' | 'recent' | 'unavailable';
  tools: WorkerToolActivity[];
  selectedModel: string | null;
  observedModel: string | null;
  selectedEffort: string | null;
  modelRequestAt: string | null;
  modelResponseAt: string | null;
  modelFailureAt: string | null;
  jevRequestAt?: string | null;
  jevResponseAt?: string | null;
}
export interface WorkerActivityView { items: WorkerActivity[]; limited: boolean; total?: number; sig: string }
interface Candidate extends Omit<WorkerActivity, 'tools' | 'coverage' | 'state'> { terminal: 'completed' | 'failed' | null; launched: boolean; pendingTool?: boolean }
type WorkerSummary = Omit<WorkerActivity, 'tools' | 'coverage'>;
export interface WorkerModelCycle { id: string; at: string; model: string | null; tools: string[] }
export interface WorkerHistory { worker: WorkerSummary; models: WorkerModelCycle[]; tools: WorkerToolActivity[]; coverage: WorkerActivity['coverage']; skippedRows: number; total: number; next: number | null }

// This is a local dashboard adapter. It never copies conversation text, command arguments,
// source contents, tool outputs, or thinking into the snapshot or a Jev request.
const target = (input: Rec | null, cwd: unknown): string | null => {
  const value = input?.['file_path'] ?? input?.['path'];
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f]|sk-|api[_-]?key|token|secret|credential|\.env(?:\.|$)/i.test(value)) return null;
  const short = isAbsolute(value) ? typeof cwd === 'string' && isAbsolute(cwd) ? relative(cwd, value) : basename(value) : value;
  return short && short.length <= 200 ? short : null;
};
const action = (name: string, input: Rec | null): WorkerToolActivity['action'] => {
  if (name === 'Read') return 'read';
  if (name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') return 'edit';
  if (name === 'Write') return 'write';
  if (name === 'Grep' || name === 'Glob') return 'search';
  if (name !== 'Bash') return 'tool';
  const command = typeof input?.['command'] === 'string' ? input['command'] : '';
  // Recognize only the initial executable and fixed command words; never display arguments.
  if (/^\s*(?:npx\s+)?(?:vitest|jest|pytest)\b|^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(command)) return 'test';
  if (/^\s*(?:npx\s+)?tsc\b|^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?typecheck\b/.test(command)) return 'typecheck';
  if (/^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(command)) return 'build';
  if (/^\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b|^\s*(?:npx\s+)?eslint\b/.test(command)) return 'lint';
  if (/^\s*(?:rg|grep)\b/.test(command)) return 'search';
  if (/^\s*git\s+(?:status|diff|log|show)\b/.test(command)) return 'git';
  return 'command';
};
const safeDirectory = (path: string): boolean => {
  try {
    // Reject symbolic links at every path component, including an overridden config root.
    let current: string = sep;
    for (const part of path.split(sep).filter(Boolean)) { current = join(current, part); const st = lstatSync(current); if (!st.isDirectory() || st.isSymbolicLink()) return false; }
    return true;
  } catch { return false; }
};

export class ClaudeWorkerActivityReader {
  private readonly paths = new Map<string, string>();
  private readonly cache = new Map<string, { key: string; coverage: WorkerActivity['coverage']; tools: WorkerToolActivity[]; lastAt: string | null }>();
  private candidates: Candidate[] = [];
  private readonly archives = new Map<string, { key: string; models: WorkerModelCycle[]; tools: WorkerToolActivity[]; skippedRows: number; partial: boolean }>();

  /** All trace-observed agents remain discoverable, independent of the live display limit. */
  list(offset: number, now: Date): { items: WorkerSummary[]; total: number; next: number | null } {
    const items = this.candidates.slice(offset, offset + 50).map(c => this.summary(c, now));
    return { items, total: this.candidates.length, next: offset + items.length < this.candidates.length ? offset + items.length : null };
  }

  private summary(c: Candidate, now: Date): WorkerSummary {
    const { terminal, launched, pendingTool, ...base } = c;
    const age = now.getTime() - Date.parse(c.lastAt);
    const pending = c.modelRequestAt && c.modelRequestAt > [c.modelResponseAt ?? '', c.modelFailureAt ?? ''].sort().at(-1)! || c.jevRequestAt && c.jevRequestAt > (c.jevResponseAt ?? '');
    return { ...base, state: terminal ?? ((launched || pending || pendingTool) && age >= 0 && age < 120_000 ? 'active' : 'unknown') };
  }

  private locate(c: Candidate, env: Env): string | null {
    const key = `${c.sessionId}:${c.agentId}`, cached = this.paths.get(key);
    if (cached) return cached;
    try {
      const projects = join(claudeConfigDir(env), 'projects');
      if (!safeDirectory(projects)) return null;
      for (const dir of readdirSync(projects)) {
        const parent = join(projects, dir, c.sessionId, 'subagents');
        if (!safeDirectory(parent)) continue;
        const path = join(parent, `agent-${c.agentId}.jsonl`);
        try { const st = lstatSync(path); if (st.isFile() && !st.isSymbolicLink()) { this.paths.set(key, path); return path; } } catch { /* Next project. */ }
      }
    } catch { /* Native history is unavailable. */ }
    return null;
  }

  /** Explicit local history lookup. Only identities already observed in traces can name a file. */
  async history(sessionId: string, agentId: string, offset: number, env: Env, now: Date, signal?: AbortSignal): Promise<WorkerHistory | null> {
    if (signal?.aborted) return null;
    const c = this.candidates.find(c => c.sessionId === sessionId && c.agentId === agentId);
    if (!c) return null;
    const worker = this.summary(c, now), path = this.locate(c, env);
    const unavailable: WorkerHistory = { worker, models: [], tools: [], coverage: 'unavailable', skippedRows: 0, total: 0, next: null };
    if (!path || !safeDirectory(join(path, '..'))) return unavailable;
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd); if (!st.isFile()) return unavailable;
      const identity = `${path}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
      let archive = this.archives.get(path);
      if (archive?.key !== identity) {
        const models = new Map<string, WorkerModelCycle>();
        const tools = new Map<string, WorkerToolActivity>(), results = new Map<string, { at: string; error: boolean }>();
        let pending = '', skippedRows = 0, dropping = false;
        const parse = (line: string): void => {
          if (!line.trim()) return;
          let r: Rec | null; try { r = object(JSON.parse(line)); } catch { skippedRows++; return; }
          if (!r) return;
          if (token(r['sessionId']) && r['sessionId'] !== sessionId || token(r['agentId']) && r['agentId'] !== agentId) { skippedRows++; return; }
          const at = stamp(r['timestamp']), message = object(r['message']), content = message?.['content'];
          if (!at || !Array.isArray(content)) return;
          if (r['type'] === 'assistant') {
            const id = token(message?.['id']) ?? token(r['uuid']) ?? at;
            const previous = models.get(id);
            const ids = content.flatMap(raw => { const block = object(raw); const tool = block?.['type'] === 'tool_use' ? token(block['id']) : null; return tool ? [tool] : []; });
            models.set(id, { id, at: previous?.at ?? at, model: token(message?.['model']) ?? previous?.model ?? null, tools: [...new Set([...(previous?.tools ?? []), ...ids])] });
          }
          for (const raw of content) {
            const block = object(raw); if (!block) continue;
            if (r['type'] === 'assistant' && block['type'] === 'tool_use') {
              const id = token(block['id']), name = token(block['name']); if (!id || !name || tools.has(id)) continue;
              const input = object(block['input']);
              tools.set(id, { id, name, action: action(name, input), target: target(input, r['cwd']), state: 'unconfirmed', startedAt: at, endedAt: null, durationMs: null });
            } else if (r['type'] === 'user' && block['type'] === 'tool_result') {
              const id = token(block['tool_use_id']); if (id) results.set(id, { at, error: block['is_error'] === true });
            }
          }
        };
        // Yield between bounded reads so a large native transcript cannot stall live SSE updates.
        const decoder = new TextDecoder(), buffer = Buffer.alloc(64 * 1024);
        for (let position = 0; position < st.size;) {
          if (signal?.aborted) return null;
          const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, st.size - position), position); if (!bytes) break;
          position += bytes; pending += decoder.decode(buffer.subarray(0, bytes), { stream: true });
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, newline); pending = pending.slice(newline + 1); if (!dropping) parse(line); dropping = false; }
          // Exceptionally large single rows are explicit partial evidence, never silently reported complete.
          if (pending.length > 8 * 1024 * 1024) { if (!dropping) skippedRows++; pending = ''; dropping = true; }
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        pending += decoder.decode();
        for (const [id, result] of results) { const tool = tools.get(id); if (!tool || result.at < tool.startedAt) { skippedRows++; continue; } tool.endedAt = result.at; tool.state = result.error ? 'error' : 'done'; tool.durationMs = Date.parse(result.at) - Date.parse(tool.startedAt); }
        archive = { key: identity, models: [...models.values()].sort((a, b) => a.at.localeCompare(b.at)), tools: [...tools.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)), skippedRows, partial: Boolean(pending.trim()) || dropping };
        this.archives.set(path, archive);
        if (this.archives.size > 64) this.archives.delete(this.archives.keys().next().value!);
      }
      const tools = archive.tools.slice(offset, offset + 100).map(t => ({ ...t, state: t.endedAt ? t.state : worker.state === 'active' ? 'active' as const : 'unconfirmed' as const }));
      return { worker, models: offset === 0 ? archive.models : archive.models.filter(model => model.tools.some(id => tools.some(tool => tool.id === id))), tools, total: archive.tools.length, next: offset + tools.length < archive.tools.length ? offset + tools.length : null, skippedRows: archive.skippedRows, coverage: archive.partial || archive.skippedRows ? 'recent' : 'complete' };
    } catch { return unavailable; } finally { if (fd !== undefined) closeSync(fd); }
  }

  /** Existing, safely resolved native directories; watching adds no host hooks. */
  directories(): string[] { return [...new Set([...this.paths.values()].map(path => join(path, '..')).filter(safeDirectory))]; }

  read(records: readonly Rec[], env: Env, now: Date): WorkerActivityView {
    const dispatch = new Map<string, Rec>();
    const terminals = new Map<string, Rec>();
    const candidates = new Map<string, Candidate>();
    const callKey = (r: Rec) => `${token(r['session_id'])}:${token(r['tool_use_id'])}`;
    for (const r of records) {
      if (r['host'] === 'codex') continue;
      if (r['phase'] === 'dispatch' || r['phase'] === 'background_dispatch') dispatch.set(callKey(r), r);
      // A parent call can fail while its native background execution remains reserved.
      if (r['phase'] === 'background_terminal' || r['phase'] === 'failure' && r['release_unconfirmed'] !== true) terminals.set(callKey(r), r);
    }
    for (const r of records.filter(r => r['agent_id'] && ['background_launch', 'mod_router', 'claude_router'].includes(String(r['phase']))).sort((a, b) => String(a['written_at'] ?? '').localeCompare(String(b['written_at'] ?? '')))) {
      if (r['host'] === 'codex') continue;
      const sessionId = token(r['session_id']), agentId = token(r['agent_id']), at = stamp(r['written_at']);
      if (!sessionId || !agentId || !at || !['background_launch', 'mod_router', 'claude_router'].includes(String(r['phase']))) continue;
      const key = `${sessionId}:${agentId}`, previous = candidates.get(key), d = dispatch.get(callKey(r));
      const terminal = terminals.get(callKey(r));
      const terminalAt = stamp(terminal?.['written_at']);
      const role = d?.['role'] === 'planner' ? 'planner' : d?.['role'] === 'worker' ? 'worker' : previous?.role ?? 'agent';
      candidates.set(key, { sessionId, agentId, promptId: token(r['execution_prompt_id']) ?? previous?.promptId ?? token(r['prompt_id']),
        callId: token(r['tool_use_id']) ?? previous?.callId ?? null,
        role, taskId: token(d?.['task_id']) ?? previous?.taskId ?? null,
        selectedModel: token(r['requested_model'] ?? r['requested']) ?? previous?.selectedModel ?? null,
        observedModel: token(r['resolved_model'] ?? r['observed']) ?? previous?.observedModel ?? null,
        selectedEffort: 'requested_effort' in r ? token(r['requested_effort']) : previous?.selectedEffort ?? null,
        modelRequestAt: r['event'] === 'model_request' ? at : previous?.modelRequestAt ?? null,
        modelResponseAt: r['event'] === 'child_result' ? at : previous?.modelResponseAt ?? null,
        modelFailureAt: r['event'] === 'model_failure' ? at : previous?.modelFailureAt ?? null,
        jevRequestAt: r['event'] === 'request' && r['scope'] === 'child' ? at : previous?.jevRequestAt ?? null,
        jevResponseAt: r['event'] === 'child_route' ? at : previous?.jevResponseAt ?? null,
        terminal: terminal ? terminal['status'] === 'completed' ? 'completed' : 'failed' : previous?.terminal ?? null,
        launched: r['phase'] === 'background_launch' || previous?.launched === true,
        lastAt: [at, terminalAt ?? '', previous?.lastAt ?? ''].sort().at(-1)! });
    }
    const all = [...candidates.values()];
    // An old launch can still have fresh native work. Read unsettled activity before
    // applying the inactive display cap, including children without a launch trace.
    for (const c of all) {
      if (c.terminal) continue;
      const path = this.locate(c, env), read = path ? this.readFile(`${c.sessionId}:${c.agentId}`, path) : null;
      c.lastAt = [c.lastAt, read?.lastAt ?? ''].sort().at(-1)!;
      c.pendingTool = read?.tools.some(t => !t.endedAt) ?? false;
    }
    all.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
    this.candidates = all;
    // Never evict a trace-observed active agent merely because another agent emitted a newer event.
    const active = all.filter(c => this.summary(c, now).state === 'active');
    const activeKeys = new Set(active.map(c => `${c.sessionId}:${c.agentId}`));
    const selected = [...active, ...all.filter(c => !activeKeys.has(`${c.sessionId}:${c.agentId}`)).slice(0, MAX_AGENTS)];
    const retained = new Set([...selected, ...all.filter(c => !c.terminal)].map(c => `${c.sessionId}:${c.agentId}`));
    for (const key of this.paths.keys()) if (!retained.has(key)) { this.paths.delete(key); this.cache.delete(key); }
    const items = selected.map(c => {
      const key = `${c.sessionId}:${c.agentId}`;
      const path = this.locate(c, env);
      const read = path ? this.readFile(key, path) : null;
      const lastAt = [c.lastAt, read?.lastAt ?? ''].sort().at(-1)!;
      const age = now.getTime() - Date.parse(lastAt), recent = age >= 0 && age < 120_000;
      const pending = c.modelRequestAt && c.modelRequestAt > [c.modelResponseAt ?? '', c.modelFailureAt ?? ''].sort().at(-1)! || c.jevRequestAt && c.jevRequestAt > (c.jevResponseAt ?? '');
      const state: WorkerActivity['state'] = c.terminal ?? (recent && (c.launched || pending || read?.tools.some(t => !t.endedAt)) ? 'active' : 'unknown');
      const tools = (read?.tools ?? []).map(t => ({ ...t, state: t.endedAt ? t.state : state === 'active' ? 'active' as const : 'unconfirmed' as const }));
      const { terminal: _terminal, launched: _launched, pendingTool: _pendingTool, ...base } = c;
      return { ...base, lastAt, state, coverage: read?.coverage ?? 'unavailable' as const, tools };
    });
    const view = { items, limited: all.length > selected.length, total: all.length };
    return { ...view, sig: createHash('sha256').update(JSON.stringify(view)).digest('hex').slice(0, 16) };
  }

  private readFile(key: string, path: string): { coverage: WorkerActivity['coverage']; tools: WorkerToolActivity[]; lastAt: string | null } | null {
    let fd: number | undefined;
    try {
      if (!safeDirectory(join(path, '..'))) return null;
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = fstatSync(fd);
      if (!st.isFile()) return null;
      const identity = `${path}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}`;
      const cached = this.cache.get(key);
      if (cached?.key === identity) return cached;
      const start = Math.max(0, st.size - MAX_BYTES), buffer = Buffer.alloc(Math.min(st.size, MAX_BYTES));
      const bytes = readSync(fd, buffer, 0, buffer.length, start);
      let text = buffer.subarray(0, bytes).toString('utf8');
      if (start) text = text.slice(text.indexOf('\n') + 1);
      const lines = text.split('\n');
      const partial = lines.pop(); // An append in progress is not a malformed or completed tool result.
      const tools = new Map<string, WorkerToolActivity>();
      const results = new Map<string, { at: string; error: boolean }>();
      let lastAt: string | null = null, incomplete = start > 0 || Boolean(partial?.trim());
      for (const line of lines) {
        if (!line.trim()) continue;
        let r: Rec | null;
        try { r = object(JSON.parse(line)); } catch { incomplete = true; continue; }
        if (!r) continue;
        const at = stamp(r['timestamp']);
        if (!at) continue;
        if (token(r['sessionId']) && token(r['sessionId']) !== key.split(':')[0]) { incomplete = true; continue; }
        if (token(r['agentId']) && token(r['agentId']) !== key.split(':')[1]) { incomplete = true; continue; }
        lastAt = [lastAt ?? '', at].sort().at(-1) ?? null;
        const content = object(r['message'])?.['content'];
        if (!Array.isArray(content)) continue;
        for (const raw of content) {
          const block = object(raw);
          if (!block) continue;
          if (r['type'] === 'assistant' && block['type'] === 'tool_use') {
            const id = token(block['id']), name = token(block['name']);
            if (!id || !name || tools.has(id)) continue;
            const input = object(block['input']);
            tools.set(id, { id, name, action: action(name, input), target: target(input, r['cwd']), state: 'unconfirmed', startedAt: at, endedAt: null, durationMs: null });
          } else if (r['type'] === 'user' && block['type'] === 'tool_result') {
            const id = token(block['tool_use_id']);
            if (id) results.set(id, { at, error: block['is_error'] === true });
          }
        }
      }
      for (const [id, result] of results) {
        const tool = tools.get(id);
        if (!tool) { incomplete = true; continue; }
        if (result.at < tool.startedAt) { incomplete = true; continue; }
        tool.endedAt = result.at; tool.state = result.error ? 'error' : 'done';
        tool.durationMs = Date.parse(result.at) - Date.parse(tool.startedAt);
      }
      const ordered = [...tools.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      const result = { key: identity, coverage: incomplete || ordered.length > MAX_TOOLS ? 'recent' as const : 'complete' as const, tools: ordered.slice(-MAX_TOOLS), lastAt };
      this.cache.set(key, result);
      return result;
    } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  }
}
