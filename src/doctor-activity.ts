import { existsSync, statSync } from 'node:fs';
import { factsOf, sameModel } from './claude-models.js';
import { codexConnectionOwnerPath } from './codex-paths.js';
import type { Env } from './config.js';
import { readPrivateJson } from './credentials.js';
import { normalizeUsage, usageCost, type TokenUsage } from './cost.js';
import { dashboardSources } from './dashboard.js';
import { ownerAlive } from './dashboard-launch.js';
import type { DoctorLevel } from './doctor.js';
import { readTraceRecords, type TraceRead } from './explain.js';
import type { Host } from './host-support.js';
import { LIVENESS_WINDOW, type LivenessState } from './liveness.js';
import { providerPrice } from './provider-prices.js';
import { OWNED_AGENT_NAMES } from './types.js';

/**
 * #279: doctor's activity group judges what each feature did in the last 24 h of trace records -- fired, applied,
 * effect, regression -- instead of checking install files alone. Pure over its input so fixtures can drive every
 * level; the readers below are the only part that touches the disk. No inference, no network, no transcripts.
 */

type Rec = Record<string, unknown>;
export interface ActivityCheck { level: DoctorLevel; message: string; action: string | null }
/** Read from the Codex connection owner record: its root and pid only, never its token; `since` is when it was written. */
export interface CodexOwner { root: string; rootExists: boolean; pidAlive: boolean; since: number }
export interface ActivityInput {
  traces: Partial<Record<Host, TraceRead>>; now: number; installed: string | null; recording: boolean; keyPresent: boolean;
  codexOwner: CodexOwner | null; liveness: LivenessState | null;
}

const DAY_MS = 86_400_000;
const HOOK_MS = 2 * 3_600_000;
/** A compaction's PostCompact lands 30-40 s after its PreCompact (2026-10 classic path); a younger pre is in flight. */
const COMPACT_GRACE_MS = 10 * 60_000;
/** A switched request's own new content (prompt, tool results) is a cache write on Opus too; only the rest was readable. */
const NEW_CONTENT = 5000;

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sub = (r: Rec, k: string): Rec => (isRecord(r[k]) ? r[k] as Rec : {});
const at = (r: Rec): number => Date.parse(str(r['written_at']) ?? '');
const usd = (n: number): string => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;
const rate = (n: number, of: number): string => of ? `${(100 * n / of).toFixed(1)}%` : 'n/a';
const tally = (values: string[]): string => Object.entries(values.reduce<Record<string, number>>((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
const percentile = (sorted: number[], p: number): number | null => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1]! : null;
const familyOf = (model: unknown): string | null => typeof model === 'string' ? factsOf(model)?.family ?? null : null;
const short = (id: unknown): string => String(id).slice(0, 8);
const group = (map: Map<string, Rec[]>, key: string, r: Rec): void => { (map.get(key) ?? map.set(key, []).get(key)!).push(r); };

export const activityChecks = (input: ActivityInput): ActivityCheck[] => {
  const out: ActivityCheck[] = [];
  const say = (level: DoctorLevel, message: string, action: string): void => { out.push({ level, message, action: level === 'fail' || level === 'warn' ? action : null }); };
  const inWindow = (r: Rec): boolean => at(r) > input.now - DAY_MS && at(r) <= input.now;
  const byHost = { claude: (input.traces.claude?.records ?? []).filter(inWindow), codex: (input.traces.codex?.records ?? []).filter(inWindow) };
  const rs = [...byHost.claude, ...byHost.codex].sort((a, b) => (str(a['written_at']) ?? '').localeCompare(str(b['written_at']) ?? ''));
  const unreadable = (input.traces.claude?.unreadable ?? 0) + (input.traces.codex?.unreadable ?? 0);
  // Without records doctor cannot tell a working feature from a broken one, so it never answers "ok" here.
  if (!input.recording || !rs.length) {
    say('warn', `activity: 추적 불가 (untrackable) -- ${input.recording ? 'no trace records in the last 24 h' : 'local recording is off'}${unreadable ? `; ${unreadable} unreadable trace files` : ''}; no feature can be judged working`,
      input.recording ? 'Use a session with Jev Gate loaded, then rerun doctor; check the trace directory path and its permissions.' : 'Turn recording on (`recording on`); doctor judges features only from local records.');
    return out;
  }
  const phase = (name: string): Rec[] => rs.filter(r => r['phase'] === name);
  const router = (...events: string[]): Rec[] => rs.filter(r => r['phase'] === 'mod_router' && events.includes(String(r['event'])));

  if (input.installed) {
    const latest = new Map<string, string>();
    for (const r of rs) if (at(r) > input.now - HOOK_MS && str(r['hook_version']) && str(r['session_id'])) latest.set(r['session_id'] as string, r['hook_version'] as string);
    const stale = [...latest].filter(([, v]) => v !== input.installed);
    say(!latest.size ? 'info' : stale.length ? 'warn' : 'ok', `hook_version: ${latest.size} sessions recorded in the last 2 h, ${stale.length} on a hook other than installed v${input.installed}${stale.length ? ` (${stale.map(([s, v]) => `${short(s)} v${v}`).join(', ')})` : ''}`,
      'Restart the named sessions (exit and resume) so they load the installed hooks.');
  }

  const admissions = phase('admission_result'), calls = admissions.filter(r => r['attempted'] === true);
  const orchestrated = admissions.filter(r => sub(r, 'decision')['shape'] === 'orchestrated').length;
  const errorOf = (r: Rec): string | null => sub(r, 'decision')['reason'] === 'admission_invalid' || sub(r, 'http')['code'] === 'response_invalid' ? 'invalid' : sub(r, 'http')['code'] === 'timeout' ? 'timeout' : str(sub(r, 'http')['code']) ? 'http' : null;
  const errors = calls.map(errorOf).filter((e): e is string => e !== null);
  const latency = calls.map(r => num(sub(r, 'http')['duration_ms'])).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const ring = input.liveness?.recent ?? [], ringCalls = ring.filter(e => e.attempted).length, never = ring.length >= LIVENESS_WINDOW && ringCalls === 0;
  const gateAFail = calls.length >= 20 && errors.length / calls.length > 0.1, gateAIdle = calls.length >= 50 && orchestrated === 0;
  say(gateAFail ? 'fail' : gateAIdle || never ? 'warn' : admissions.length ? 'ok' : 'info',
    `gate_a: ${admissions.length} decisions, ${calls.length} Jev calls, ${orchestrated} orchestrated; errors ${errors.length} (${rate(errors.length, calls.length)}${errors.length ? `: ${tally(errors)}` : ''}); latency p50 ${percentile(latency, 0.5) ?? '-'} ms / p90 ${percentile(latency, 0.9) ?? '-'} ms; reasons ${tally(admissions.map(r => str(sub(r, 'decision')['reason']) ?? 'none'))}; liveness ${ringCalls}/${ring.length} recent auto-mode decisions called Jev`,
    gateAFail ? 'Check Jev reachability and the API key; failed calls keep every prompt direct.' : never ? 'Gate A never calls Jev: check mode=auto, the effective depth floor and the API key in configuration.' : 'Gate A pays a Jev call and its latency on every prompt but orchestrated nothing; review the admission policy, or set Gate mode off.');

  const routes = phase('pre_result').filter(r => r['role'] === 'worker'), retiered = routes.filter(r => str(r['called_tier']) && str(sub(r, 'decision')['tier']) && sub(r, 'decision')['tier'] !== r['called_tier']).length;
  say(routes.length >= 5 && !retiered ? 'warn' : routes.length ? 'ok' : 'info', `gate_b: ${routes.length} routing decisions, ${retiered} changed the called tier; reasons ${tally(routes.map(r => str(sub(r, 'decision')['reason']) ?? 'none'))}`,
    'Gate B calls Jev on every owned dispatch and changed no tier; review the routing policy.');

  const posts = phase('post'), owned = posts.filter(r => OWNED_AGENT_NAMES.includes(str(r['subagent_type']) ?? '') && str(r['verdict']));
  const unchecked = owned.filter(r => r['verdict'] === 'accept' && Object.values(sub(r, 'reported_checks')).every(n => n === 0)).length;
  const rejected = owned.filter(r => r['verdict'] !== 'accept');
  say(rejected.length || unchecked ? 'warn' : owned.length ? 'ok' : 'info',
    `worker: ${owned.length} Gate worker results -- ${owned.length ? tally(owned.map(r => String(r['verdict']))) : 'none'}${unchecked ? `; ${unchecked} accepted with no checks run` : ''}${rejected.length ? `; ${[...new Set(rejected.map(r => str(r['verdict_reason']) ?? 'no reason'))].map(v => `"${v}"`).join('; ')}` : ''}; ${posts.length - owned.length} native Agent calls (예약 외 호출, not worker acceptances)`,
    'Open the named workers in the dashboard; an unverified or unchecked result was not proven done.');

  const terminals = phase('background_terminal'), failed = terminals.filter(r => r['status'] === 'failed').length;
  say(failed ? 'warn' : terminals.length ? 'ok' : 'info', `background: ${terminals.length} background workers ended${terminals.length ? ` (${tally(terminals.map(r => String(r['status'])))}; reasons ${tally(terminals.map(r => str(r['verdict_reason']) ?? 'none'))})` : ''}`,
    'Open the failed background workers in the dashboard; user-stopped tasks are recorded as cancelled.');

  const results = router('root_result', 'child_result'), compared = results.filter(r => familyOf(r['requested']) && familyOf(r['observed']));
  const mismatched = compared.filter(r => familyOf(r['requested']) !== familyOf(r['observed']));
  say(mismatched.length ? 'fail' : compared.length ? 'ok' : 'info', `router_applied: ${compared.length} routed requests with an observed model, ${mismatched.length} answered by another model family${mismatched.length ? ` (${tally(mismatched.map(r => `${familyOf(r['requested'])}->${familyOf(r['observed'])}`))})` : ''}`,
    'The host answered with a model the Router did not request; check the model restrictions and the host version.');

  // A root turn's routing ends only with a recorded reason; a later unrouted step without one is the #279 mid-turn release.
  const turns = new Map<string, Rec[]>();
  for (const r of rs) if (r['phase'] === 'mod_router' && str(r['turn']) && !str(r['agent_id']) && (r['scope'] === undefined || r['scope'] === 'root')) group(turns, `${String(r['session_id'])}:${String(r['turn'])}`, r);
  let patched = 0; const released: string[] = [];
  for (const [key, steps] of turns) {
    const decision = steps.find(r => r['event'] === 'root' && Object.keys(sub(r, 'patch')).length);
    if (!decision) continue;
    patched++;
    const ended = (p: Rec): boolean => steps.some(r => (r['event'] === 'root_stop' || r['event'] === 'context_reset') && (num(r['index']) ?? 0) <= (num(p['index']) ?? 0) || (r['event'] === 'turn_end' || r['event'] === 'budget_timeout') && at(r) <= at(p));
    if (steps.some(p => p['event'] === 'prepared' && p['routed'] === false && (num(p['index']) ?? 0) > 0 && at(p) >= at(decision) && !ended(p))) released.push(key.split(':')[1]!);
  }
  say(released.length ? 'fail' : patched ? 'ok' : 'info', `router_released: ${released.length} of ${patched} patched root turns went unrouted mid-turn with no root_stop, context_reset or turn_end record${released.length ? ` (turns ${released.map(short).join(', ')})` : ''}`,
    'The rest of these turns ran on the native model and effort; update Jev Gate once a fix ships and rerun doctor.');

  // A switch is a root request the Router patched (its `prepared` step routed) onto another family than its turn's
  // recorded baseline, priced against that baseline reading what the switch wrote; minus the baseline's rewrite on the
  // way back. Unrelated native requests neither save nor cost the Router anything.
  // The baseline would have read that prefix only while its cache was still alive, so a gap past the TTL costs the switch nothing.
  const step = (r: Rec, ...more: string[]): string => [r['session_id'], r['turn'], ...more.map(k => r[k])].map(String).join(':');
  const routedSteps = new Set(router('prepared').filter(r => r['routed'] === true && r['scope'] === 'root' && !str(r['agent_id'])).map(r => step(r, 'index')));
  const decisions = new Map(router('root').filter(r => str(sub(r, 'patch')['model'])).map(r => [step(r), r]));
  const sessions = new Map<string, Rec[]>();
  for (const r of router('root_result')) group(sessions, String(r['session_id']), r);
  const usage = (r: Rec): TokenUsage => {
    const u = sub(r, 'usage'), t = normalizeUsage('claude', { input_tokens: u['input'], cache_read_input_tokens: u['cache_read'], cache_creation_input_tokens: u['cache_creation'], output_tokens: u['output'] });
    const coverage = sub(r, 'accounting')['coverage'];
    return coverage === 'partial' || coverage === 'invalid' ? { ...t, coverage } : t;
  };
  // Missing return usage can hide a rewrite after a known saving. Exclude that session's whole comparison,
  // rather than crediting the earlier switch while silently dropping its unknown cost.
  const incomplete = new Map([...sessions].map(([id, rows]) => [id, rows.filter(r => usage(r).coverage !== 'complete').length] as const).filter(([, n]) => n));
  const unknown = [...incomplete.values()].reduce((sum, n) => sum + n, 0);
  const net = (ttl: 'write5m' | 'write1h') => {
    const reach = ttl === 'write5m' ? 5 * 60_000 : 60 * 60_000;
    let spend = 0, saved = 0, rewrite = 0, switched = 0, switches = 0;
    for (const [id, rows] of sessions) {
      if (incomplete.has(id)) continue;
      // `back` is the baseline family the previous request switched away from, while that request was a switch.
      let prev: string | null = null, back: string | null = null, prevAt = NaN;
      for (const r of rows) {
        const warm = at(r) - prevAt <= reach;
        prevAt = at(r);
        const model = str(r['observed']), family = familyOf(model), t = usage(r);
        const price = (m: string | null, v: TokenUsage) => {
          const p = m ? providerPrice('claude', m, v.input! + v.read! + v.write!) : null, w = p?.write ?? p?.[ttl];
          const cost = usageCost(v, p && w !== undefined ? { ...p, write: w } : null);
          return p && w !== undefined && cost.usd !== null ? { p, w, usd: cost.usd } : null;
        };
        const actual = family === 'opus' || family === 'sonnet' || family === 'haiku' ? price(model, t) : null;
        if (!actual) { prev = back = null; continue; }
        spend += actual.usd;
        const decision = routedSteps.has(step(r, 'index')) ? decisions.get(step(r)) ?? {} : {}, target = str(sub(decision, 'patch')['model']);
        const applied = target && model && sameModel(target, str(r['requested']) ?? '') && sameModel(target, str(sub(r, 'applied')['model']) ?? '') && sameModel(target, model);
        const from = applied ? str(sub(decision, 'from')['model']) : null, fromFamily = familyOf(from);
        if (fromFamily && fromFamily !== family) {
          switched++; if (prev !== family) switches++;
          const counter = price(from, prev === fromFamily && warm ? { ...t, read: t.read! + Math.max(0, t.write! - NEW_CONTENT), write: Math.min(t.write!, NEW_CONTENT) } : t);
          if (counter) saved += counter.usd - actual.usd;
          back = fromFamily;
        } else {
          if (back === family && warm) rewrite += Math.max(0, t.write! - NEW_CONTENT) * (actual.w - actual.p.read) / 1e6;
          back = null;
        }
        prev = family;
      }
    }
    return { spend, net: saved - rewrite, switched, switches };
  };
  const short5 = net('write5m'), long1 = net('write1h');
  say(unknown ? 'warn' : !short5.switched ? sessions.size ? 'ok' : 'info' : short5.net < 0 && long1.net < 0 ? 'fail' : short5.net < 0 !== long1.net < 0 ? 'warn' : 'ok',
    unknown ? `router_cost: unknown/untracked -- ${unknown} root requests with incomplete usage; ${incomplete.size} sessions excluded from savings and losses` : !short5.switched ? `router_cost: no routed root model switch among ${router('root_result').length} root requests` : `router_cost: ${short5.switched} routed root requests off their turn's baseline model over ${short5.switches} switches; net ${usd(short5.net)} at 5m / ${usd(long1.net)} at 1h write prices (${rate(short5.net, short5.spend)} / ${rate(long1.net, long1.spend)} of root spend $${short5.spend.toFixed(2)} / $${long1.spend.toFixed(2)})`,
    unknown ? 'Usage counters or accounting coverage are incomplete; record complete usage before judging root model switching costs.' : short5.net < 0 && long1.net < 0 ? 'Root model switching cost more than it saved at either cache TTL; report it with this line before relying on root model routing.' : 'The sign depends on the cache TTL the host used; the records do not say which.');

  const routedSpawns = new Set(rs.filter(r => r['phase'] === 'mod_router' && String(r['event']).startsWith('spawn')).map(r => str(r['tool_use_id'])).filter(Boolean));
  const unrouted = posts.filter(r => !str(sub(r, 'caller')['agent_id']) && !OWNED_AGENT_NAMES.includes(str(r['subagent_type']) ?? '') && !routedSpawns.has(str(r['tool_use_id'])));
  // After its first step an unregistered child is remembered as native, so its later steps say `native_child`.
  const children = new Set(router('child_route').filter(r => r['skipped'] === 'child_unregistered').map(r => r['agent_id'])), unregistered = router('child_route').filter(r => children.has(r['agent_id']));
  say(unrouted.length || children.size ? 'warn' : posts.length || router('child_route').length ? 'ok' : 'info', `spawn_coverage: ${unrouted.length} root Agent calls with neither a Router spawn record nor a Gate-owned type${unrouted.length ? ` (${tally(unrouted.map(r => String(r['subagent_type'])))})` : ''}; ${children.size} unregistered children ran ${unregistered.length} unrouted steps`,
    'These subagents (e.g. forked skills) ran on the native model and effort outside routing; update Jev Gate once spawn coverage ships.');

  const sent = router('child_route').filter(r => r['sent'] === true), moved = sent.filter(r => str(sub(r, 'patch')['effort']) && sub(r, 'patch')['effort'] !== sub(r, 'from')['effort']).length;
  say(sent.length >= 50 && moved / sent.length < 0.05 ? 'warn' : sent.length ? 'ok' : 'info', `child_effect: ${sent.length} child steps sent to Jev, ${moved} changed the effort (${rate(moved, sent.length)})`,
    'Each child step pays a Jev call and its latency for almost no change; review per-step child routing.');

  if (input.traces.claude) {
    // Each compaction is its own session's records from its pre up to that session's next pre; a restore or post elsewhere is not its.
    const compacts = byHost.claude.filter(r => r['phase'] === 'mod_compact'), started: Rec[] = [], missing: Rec[] = [], unrestored: Rec[] = [];
    for (const [i, r] of compacts.entries()) {
      if (r['stage'] !== 'pre' || 'deferred' in r) continue;
      started.push(r);
      const later = compacts.slice(i + 1).filter(n => n['session_id'] === r['session_id']), end = later.findIndex(n => n['stage'] === 'pre' && !('deferred' in n));
      const own = end < 0 ? later : later.slice(0, end), posted = own.some(n => n['stage'] === 'post'), settled = posted || end >= 0 || input.now - at(r) > COMPACT_GRACE_MS;
      if (settled && !posted) missing.push(r);
      if (settled && r['mode'] !== 'shadow' && !own.some(n => n['stage'] === 'restore')) unrestored.push(r);
    }
    const restores = compacts.filter(r => r['stage'] === 'restore').length, posted = compacts.filter(r => r['stage'] === 'post').length;
    const skipped = input.keyPresent ? started.filter(r => r['selection'] === 'disabled').length : 0, invalid = compacts.filter(r => r['stage'] === 'jev' && r['selection'] === 'invalid_answers').length;
    const selections = tally(compacts.filter(r => r['stage'] === 'pre').flatMap(r => str(r['selection']) ? [str(r['selection'])!] : []));
    const sessionsOf = (rows: Rec[]): string => [...new Set(rows.map(r => short(r['session_id'])))].join(', ');
    say(missing.length ? 'fail' : skipped || invalid || unrestored.length ? 'warn' : started.length ? 'ok' : 'info',
      `compact: ${started.length} pre / ${restores} restore / ${posted} post${missing.length ? `; ${missing.length} pre without post (sessions ${sessionsOf(missing)})` : ''}${unrestored.length ? `; ${unrestored.length} without restore (sessions ${sessionsOf(unrestored)})` : ''}; Jev recorded disabled with a key present ${skipped}; invalid_answers ${invalid}${selections ? `; selections ${selections}` : ''}`,
      missing.length ? 'A compaction started but its PostCompact never recorded; check /hooks for the PostCompact entry and the host log.' : 'Some compactions ran without a restore or Jev selection; check the key and the classic hooks in /hooks.');
  }

  // A session reads its provider when it starts, so one started before the current connection was written keeps the old
  // provider until restarted. That explains a silent session; it does not make it routed, so every prompted session counts.
  const owner = input.codexOwner, isEvent = (r: Rec, event: string): boolean => r['phase'] === 'codex_event' && r['event'] === event;
  const prompted = new Set(byHost.codex.filter(r => isEvent(r, 'UserPromptSubmit')).map(r => r['session_id']));
  const routedSessions = new Set(byHost.codex.filter(r => String(r['phase']).startsWith('codex_router_') || r['phase'] === 'codex_route_applied').map(r => r['session_id']));
  const silent = [...prompted].filter(id => !routedSessions.has(id)), broken = !!owner && (!owner.rootExists || !owner.pidAlive);
  // Starts are looked up past the 24 h window: a long-lived session started long before it.
  const stale = owner ? silent.filter(id => (input.traces.codex?.records ?? []).some(r => isEvent(r, 'SessionStart') && r['session_id'] === id && at(r) < owner.since)).length : 0;
  say(broken || silent.length ? 'fail' : owner || prompted.size ? 'ok' : 'info',
    `codex_connection: ${owner ? `owner root ${owner.root} ${owner.rootExists ? 'present' : 'missing'}, pid ${owner.pidAlive ? 'alive' : 'not running'}, written ${new Date(owner.since).toISOString()}` : 'no connection owner record'}; ${prompted.size} Codex sessions prompted in the last 24 h, ${silent.length} with no codex_router record${stale ? ` (${stale} started before the connection was written)` : ''}`,
    stale ? 'No Codex root routing was recorded: sessions started before the current connection keep the old provider; restart them (exit and resume), then rerun doctor.' : 'No Codex root routing was recorded; start a fresh Codex session so the installed plugin reconnects, then rerun doctor.');

  const failures = phase('failure');
  say(failures.length ? 'warn' : 'ok', `failures: ${failures.length} failure records${failures.length ? ` (${tally(failures.map(r => str(r['failure_category']) ?? str(r['verdict_reason']) ?? 'uncategorized'))})` : ''}`,
    'Open the failures in the dashboard; each names the stage that failed.');

  return out;
};

/** Both hosts' trace directories as the dashboard reads them; a record's own `host` wins over the directory's. */
export const activityTraces = (env: Env, only?: Host): Partial<Record<Host, TraceRead>> => {
  const traces: Partial<Record<Host, TraceRead>> = {};
  for (const source of new Map((dashboardSources(env).traceDirs ?? []).map(s => [s.dir, s])).values()) {
    const read = readTraceRecords(source.dir);
    for (const r of read.records) (traces[r['host'] === 'codex' || r['host'] === 'claude' ? r['host'] : source.host] ??= { records: [], unreadable: 0 }).records.push(r);
    (traces[source.host] ??= { records: [], unreadable: 0 }).unreadable += read.unreadable;
  }
  return only ? { [only]: traces[only] ?? { records: [], unreadable: 0 } } : traces;
};

/** Only `root` and `pid` are taken from the owner record; its token is never read out or printed. */
export const codexOwnerFacts = (env: Env): CodexOwner | null => {
  let owner: Rec | null; try { owner = readPrivateJson(codexConnectionOwnerPath(env), 64 * 1024); } catch { return null; }
  const root = str(owner?.['root']);
  return root ? { root, rootExists: existsSync(root), pidAlive: ownerAlive({ pid: owner!['pid'] }), since: statSync(codexConnectionOwnerPath(env)).mtimeMs } : null;
};
