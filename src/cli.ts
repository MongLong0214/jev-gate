import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexTraceDir } from './codex-paths.js';
import { resolveApiKey, validApiKey, apiKeyOverride } from './credentials.js';
import { claudeConfigDir, claudeTraceDir } from './claude-setup.js';

import { AUTH_CONFLICT_ENV, isSubscriptionOAuth, parseAuthStatus, subagentModelOverride, type CommandResult } from './auth.js';
import { OWNED_AGENT_PROFILES } from './agents.js';
import { foregroundDispatchPossible } from './brief.js';
import { DEFAULT_CONFIG, effectiveDepthFloor, LEGACY_DEPTH_FLOOR, loadConfig, MIGRATION_SAMPLE, NATIVE_HOOK_TIMEOUT_MS, type ConfigResult } from './config.js';
import { startDashboard, dashboardSources } from './dashboard.js';
import { ensureDashboard, serveAutomaticDashboard } from './dashboard-launch.js';
import { dashboardPreferenceCommand } from './dashboard-settings.js';
import { recordingCommand, recordingStatus } from './recording.js';
import { explainDir } from './explain.js';
import { HOST_WINDOW_MAX, readHostCompactWindow, readHostWorktreeBaseRef, readSettingsEnvVar, STANDARD_CONTEXT_WINDOW } from './host-window.js';
import { jobsDir } from './job.js';
import { LIVENESS_WINDOW, livenessPath, readLiveness } from './liveness.js';
import { OWNED_AGENTS, type Mode, type Tier } from './types.js';
import { doctorChecks, finishDoctor, renderDoctor, readableFile, storageIssue, moduleIssues, dashboardDiagnostic, versionDiagnostic, type DoctorReport } from './doctor.js';
import { checkRelease, unknownRelease, packageVersion } from './release-info.js';
import { claudeModelInventory, claudeCompatibility, compatibilityChecks, missingInventory } from './doctor-models.js';
import { type SymbolicEffort } from './claude-models.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const runCommand = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): CommandResult => {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', shell: false, timeout: 3000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, signal: r.signal ?? null, stdout: r.stdout ?? '', error: r.error ? ((r.error as NodeJS.ErrnoException).code ?? 'spawn_error') : null };
};

interface Frontmatter {
  fields: Record<string, string>;
  error: string | null;
}

export const parseFrontmatter = (text: string): Frontmatter => {
  text = text.replaceAll('\r\n', '\n');
  if (!text.startsWith('---\n')) return { fields: {}, error: 'no frontmatter on line 1' };
  const delimiter = /^---[ \t]*$/m.exec(text.slice(4));
  const end = delimiter ? delimiter.index + 3 : -1;
  if (end < 0) return { fields: {}, error: 'unterminated frontmatter' };
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) { if (m[1] in fields) return { fields, error: `duplicate frontmatter field: ${m[1]}` }; fields[m[1]] = m[2].trim(); }
  }
  return { fields, error: null };
};


/**
 * #48 P0-2: derived, not hand-copied. The six owned rows come from `OWNED_AGENT_PROFILES` (src/agents.ts) with
 * `model` read off `DEFAULT_CONFIG.models[tier]` -- the same table `gen-agents.mjs` writes frontmatter from -- so
 * this expectation and the packaged frontmatter can only agree or both be visibly wrong, never quietly disagree.
 * `executor.md` is added by hand because it is lean's one untiered agent and is deliberately not in that table.
 */
const AGENT_EXPECTATIONS: Record<string, { model: string; effort: string | null }> = {
  ...Object.fromEntries(
    OWNED_AGENT_PROFILES.map((p) => [p.file, { model: DEFAULT_CONFIG.models[p.tier], effort: p.effort }]),
  ),
  // JGL-01: lean's one agent. `inherit` is the point of it: a saving from a cheaper model would not be this feature's.
  'executor.md': { model: 'inherit', effort: null },
};

/** haiku|sonnet|opus|fable, case-insensitive substring match; `null` when the string names none of them. */
const MODEL_FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export const modelFamilyOf = (model: string): (typeof MODEL_FAMILIES)[number] | null => {
  const lower = model.toLowerCase();
  return MODEL_FAMILIES.find((f) => lower.includes(f)) ?? null;
};

/**
 * #48 P0-2: family comparison when both sides name a recognized family (so `claude-opus-4-6` agrees with `opus`),
 * exact string otherwise -- a model neither side's table recognizes should not silently compare equal to itself
 * under a family that was never matched.
 */
export const modelsAgree = (a: string, b: string): boolean => {
  const fa = modelFamilyOf(a);
  const fb = modelFamilyOf(b);
  if (fa !== null && fb !== null) return fa === fb;
  return a === b;
};

export const claudeDoctor = async (root: string, env: NodeJS.ProcessEnv, cwd: string, options: { checkUpdate?: boolean } = {}): Promise<DoctorReport> => {
  const report = doctorChecks();
  const say = report.say;
  const inspect = (name: string, fn: () => void): void => { try { fn(); } catch { say('fail', `${name}: unreadable or invalid local configuration; remaining checks continue`); } };
  let leanPackage = false;
  try { const hooks = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8')); leanPackage = hooks?.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command === 'node "${CLAUDE_PLUGIN_ROOT}/dist/entry.js" --lean'; } catch { /* Invalid definitions are reported by package checks. */ }
  const agentExpectations = leanPackage ? { 'executor.md': AGENT_EXPECTATIONS['executor.md']! } : AGENT_EXPECTATIONS;
  /** Maps an owned agent's file (e.g. `worker-frontier.md`) to the `model:` frontmatter it actually has installed. */
  const checkPluginFiles = (): Map<string, string> => {
    const installedModels = new Map<string, string>();
    // #48 P2: hooks.json/lean.json now command dist/entry.js, which dynamically imports dist/hook.js only when the
    // gate might be on (src/entry.ts) -- both files have to exist for that indirection to work.
    for (const rel of ['dist/entry.js', 'dist/hook.js', '.claude-plugin/plugin.json', 'hooks/hooks.json', ...Object.keys(agentExpectations).map((f) => `agents/${f}`)]) {
      const valid = readableFile(join(root, rel)); say(valid ? 'ok' : 'fail', `${rel} ${valid ? 'readable file' : 'missing or unreadable file'}`);
    }
    try {
      const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')) as unknown;
      if (!isRecord(manifest)) say('fail', 'plugin.json must be an object');
      if (isRecord(manifest) && manifest['name'] !== 'jev-gate') say('fail', 'plugin.json name must be jev-gate');
      if (!packageVersion(root, 'claude')) say('fail', 'plugin.json version must be a valid release version');
      if (isRecord(manifest) && 'hooks' in manifest) say('fail', 'plugin.json declares hooks inline; hooks/hooks.json is auto-discovered, so each hook would run twice');
      const servers = isRecord(manifest) && isRecord(manifest['mcpServers']) ? manifest['mcpServers'] : {};
      const evidence = servers['evidence'];
      const validMcp = isRecord(evidence) && evidence['command'] === 'node' && JSON.stringify(evidence['args']) === JSON.stringify(['${CLAUDE_PLUGIN_ROOT}/plugins/evidence/dist/server.mjs']);
      say(validMcp ? 'ok' : 'fail', 'Evidence MCP: packaged server command and discovery path');
      for (const rel of ['plugins/evidence/dist/server.mjs', 'plugins/evidence/skills/evidence/SKILL.md']) say(readableFile(join(root, rel)) ? 'ok' : 'fail', `${rel}: readable regular file required`);
      say(isRecord(manifest) && manifest['skills'] === './plugins/evidence/skills/' ? 'ok' : 'fail', 'Evidence skill: packaged discovery path');
      const hooks = JSON.parse(readFileSync(join(root, 'hooks/hooks.json'), 'utf8')) as unknown;
      const modules = isRecord(hooks) ? hooks['modules'] : undefined;
      if (leanPackage) say(modules === undefined ? 'ok' : 'fail', 'Lean package: no Function Hooks modules or tier routing');
      else {
        if (JSON.stringify(modules) !== JSON.stringify(['./register.ts'])) say('fail', 'Function Hooks: exactly one packaged hooks/register.ts module required');
        const issues = moduleIssues(root, 'hooks/register.ts');
        say(issues.length ? 'fail' : 'ok', `Function Hooks module dependencies: ${issues.length ? issues.join('; ') : 'packaged entry and relative imports readable'}`);
      }
      const table = isRecord(hooks) && isRecord(hooks['hooks']) ? hooks['hooks'] : {};
      // V5: PreToolUse guards every root tool, so it is registered once with no matcher; Stop records the terminal
      // outcome. SessionStart (#48 P2) is the liveness warning -- also no matcher, and also native/auto only in
      // practice, but hooks.json registers it unconditionally the same as the others; the hook itself no-ops in lean.
      const expected: Array<[string, string | null]> = [
        ['UserPromptSubmit', null],
        ['PreToolUse', leanPackage ? '^Agent$' : null],
        ['PostToolUse', '^(Agent|TaskStop)$'],
        ['PostToolUseFailure', '^Agent$'],
        ['SubagentStop', '^jev-gate:(?:worker(?:-fast|-deep|-frontier)?|planner(?:-frontier)?|executor)$'],
        ['Stop', null],
        ['SessionStart', null],
      ];
      for (const [event, matcher] of expected.filter(([event]) => !leanPackage || !['Stop', 'SessionStart'].includes(event))) {
        const groups = Array.isArray(table[event]) ? (table[event] as unknown[]) : [];
        const handlers = groups.flatMap((g) => isRecord(g) && Array.isArray(g['hooks']) ? g['hooks'] : []);
        const ours = handlers.filter((h) => isRecord(h) && h['type'] === 'command' && h['command'] === 'node "${CLAUDE_PLUGIN_ROOT}/dist/entry.js"' + (leanPackage ? ' --lean' : ''));
        const valid = groups.length === 1 && isRecord(groups[0]) && (matcher === null ? !('matcher' in groups[0]) : groups[0]['matcher'] === matcher) && handlers.length === 1 && ours.length === 1;
        say(valid ? 'ok' : 'fail', `hooks.json ${event}${matcher ? ` (${matcher})` : ' (no matcher)'}: ${ours.length} command hook(s) → dist/entry.js (expect 1 with the exact command and matcher)`);
        const timeout = ours[0] && isRecord(ours[0]) ? ours[0]['timeout'] : undefined;
        if (ours.length === 1 && timeout !== NATIVE_HOOK_TIMEOUT_MS / 1000) say('warn', `${event} hook timeout ${String(timeout)}s (design assumes ${NATIVE_HOOK_TIMEOUT_MS / 1000}s)`);
      }
    } catch (err) {
      say('fail', 'cannot parse plugin files (invalid JSON or unreadable file)');
    }
    const agentsDir = join(root, 'agents');
    let files: string[] = []; try { files = readdirSync(agentsDir).filter((f) => f.endsWith('.md')); } catch { say('fail', 'agents/ is missing or unreadable'); }
    const extra = files.filter((f) => !(f in agentExpectations));
    if (extra.length) say('warn', `agents/ contains extra definitions (${extra.join(', ')}); only the six owned profiles are V5 roles`);
    for (const [file, exp] of Object.entries(agentExpectations)) {
      const p = join(agentsDir, file);
      if (!existsSync(p)) continue;
      let text: string; try { text = readFileSync(p, 'utf8'); } catch { say('fail', `agents/${file}: not a readable file`); continue; }
      const fm = parseFrontmatter(text);
      if (fm.error) {
        say('fail', `${file}: ${fm.error}`);
        continue;
      }
      const name = file.replace('.md', '');
      if (fm.fields['model'] !== undefined) installedModels.set(file, fm.fields['model']);
      const problems: string[] = [];
      if (fm.fields['name'] !== name) problems.push(`name=${fm.fields['name'] ?? 'missing'}`);
      if (fm.fields['model'] !== exp.model) problems.push(`model=${fm.fields['model'] ?? 'missing'} (expected ${exp.model})`);
      if (exp.effort !== null && fm.fields['effort'] !== exp.effort) problems.push(`effort=${fm.fields['effort'] ?? 'missing'} (expected ${exp.effort})`);
      if (exp.effort === null && 'effort' in fm.fields) problems.push(`effort=${String(fm.fields['effort'])} (this profile inherits the session effort)`);
      if ('tools' in fm.fields) problems.push('tools must be absent so host tools are inherited');
      if (fm.fields['background'] !== 'false') problems.push('background must be false');
      if ('disallowedTools' in fm.fields) problems.push('disallowedTools must be absent so host tools are inherited');
      for (const ignored of ['permissionMode', 'hooks', 'mcpServers']) if (ignored in fm.fields) problems.push(`${ignored} is ignored for plugin agents`);
      say(problems.length ? 'fail' : 'ok', `agents/${file}: jev-gate:${name} model=${exp.model} effort=${exp.effort ?? 'inherited'} tools=host inherited${problems.length ? ` — ${problems.join('; ')}` : ''}`);
    }
    say('info', 'Worker profiles declare requested model and effort; actual provider model and effort remain unknown until recorded responses confirm them.');
    return installedModels;
  };

  /**
   * #48 P0-2: the packaging check above catches installed frontmatter that drifts from this repo's own table. This
   * catches the other disagreement: an effective user config whose `models[tier]` names a different model family than
   * the frontmatter of an owned agent of that tier actually runs. The two can diverge because a gated dispatch (one
   * the hook picks a tier and patches a call for) is not the same code path as a direct or ungated `@agent-` call,
   * which reads the model straight off frontmatter and never consults `models` at all.
   */
  const checkModelAuthority = (models: Record<Tier, string>, installedModels: ReadonlyMap<string, string>): void => {
    for (const profile of OWNED_AGENT_PROFILES) {
      const frontmatterModel = installedModels.get(profile.file);
      if (frontmatterModel === undefined) continue; // already reported missing/unparsable by checkPluginFiles
      const configModel = models[profile.tier];
      if (!modelsAgree(configModel, frontmatterModel)) {
        say(
          'fail',
          `a gated dispatch of ${profile.name} runs ${configModel} (config models.${profile.tier}), a direct or ungated one runs ${frontmatterModel} (frontmatter)`,
        );
      }
    }
  };

  const checkConfig = (loaded: ConfigResult): void => {
    if (!loaded.ok) {
      say('fail', `config invalid (${loaded.source}): ${loaded.error.split('\n')[0]}; the hook preserves native behavior until this is fixed`);
      if (/pre-V5 layout|version must be 5|unknown tiers/.test(loaded.error)) say('info', `V5 config sample (write a new file; the plugin never rewrites yours):\n${MIGRATION_SAMPLE}`);
      return;
    }
    const c = loaded.config;
    if (c.mode === 'lean' || leanPackage) {
      say('ok', `config ${loaded.source}: mode=${c.mode} jevModel=${c.jevModel} deadline=${c.requestDeadlineMs}ms`);
      say('info', 'Lean: no Gate A/B/C, no planner, no task graph, no depth floor and no root guard. The executor inherits native model and effort.');
      if (c.mode === 'lean') {
        say('info', 'lean needs a readable host transcript for this session; without one it stays native (source_unavailable), which is not the same as an empty history');
        if (env['JEV_GATE_BENCH_RECENT'] === '1') say('warn', 'JEV_GATE_BENCH_RECENT=1 is set: the deterministic no-Jev comparison arm is active. This is a benchmark dependency, not a product mode');
      } else if (c.mode === 'off') say('warn', 'mode=off still starts a node process for every matched hook event (hooks.json/lean.json registration is unconditional): to remove that cost too, disable the plugin with `claude plugin disable jev-gate@<marketplace>`');
      say('info', `job state directory: ${jobsDir(env)} (0700, one 0600 file per session, removed after 7 days)`);
      return;
    }
    say('ok', `config ${loaded.source}: mode=${c.mode} jevModel=${c.jevModel} deadline=${c.requestDeadlineMs}ms floors={admission:${c.admissionConfidenceFloor},route:${c.routeConfidenceFloor},result:${c.resultConfidenceFloor}} plannerDefaultTier=${c.plannerDefaultTier} models=${JSON.stringify(c.models)} maxParallelWorkers=${c.maxParallelWorkers} guardAllowTools=${JSON.stringify(c.guardAllowTools)} routeQuestionShape=${c.routeQuestionShape} admissionQuestionShape=${c.admissionQuestionShape} delegationDepthFloor=${c.delegationDepthFloor === null ? 'null (derived)' : c.delegationDepthFloor} delegationDepthFraction=${c.delegationDepthFraction} maxTasksPerPlan=${c.maxTasksPerPlan} admittedShape=${c.admittedShape} delegationCoordinatorTurns=${c.delegationCoordinatorTurns} delegationWorkerTokensPerCall=${c.delegationWorkerTokensPerCall} guardAllowMcp=${c.guardAllowMcp} verifyWorkerChecks=${c.verifyWorkerChecks}`);
    if (c.admissionQuestionShape === 'atomic') {
      say(
        'info',
        `admissionQuestionShape=atomic: Gate A requires self-contained support >= 0.8 and positive-saving distribution support >= 0.8, then prices the request in code -- delegate when (turns - ${c.delegationCoordinatorTurns}) x depth - turns x ${c.delegationWorkerTokensPerCall} > 0 -- and does not consult admissionConfidenceFloor; delegationDepthFraction is read only by the composite gate`,
      );
    }
    if (c.routeQuestionShape === 'atomic') say('info', 'atomic Gate B: six core facts; yes >= 0.6, no <= 0.4; uncertain answers preserve the called profile; fast requires all cheap-work evidence; specific difficulty upgrades only fast/standard to deep');
    if (c.admissionQuestionShape === 'atomic') say('info', `atomic admission execution: ${c.admittedShape === 'auto' && c.maxParallelWorkers === 1 ? 'single (no planner)' : c.admittedShape}; ${c.admittedShape === 'auto' && c.maxParallelWorkers > 1 ? 5 : 3} questions in one batch; selected execution is recorded before application`);
    /**
     * #48 P0-1: doctor resolves the same host window and effective floor the hook resolves on the auto path
     * (`effectiveDepthFloor` in src/config.ts), so what is printed here is the number that would actually gate the
     * next real prompt, not the raw config field alone -- `delegationDepthFloor: null` on its own says nothing about
     * whether the derived floor is usable on this host.
     */
    const window = readHostCompactWindow(env, cwd);
    const { floor, source: floorSource } = effectiveDepthFloor(c, window.tokens);
    say('info', `host compaction window: ${window.tokens === null ? `unknown (${window.source})` : `${window.tokens} tokens (${window.source})`}; a launch's --autocompact or --settings flag, MDM policy and server-managed settings are not visible to a hook and can override this`);
    if (floor === 0) {
      say('info', 'effective depth floor is 0: Gate A can assess every eligible prompt; Jev and the admission policy still decide whether delegation applies');
    } else if (window.tokens !== null && floor >= window.tokens) {
      say(
        'fail',
        `effective depth floor ${floor} (${floorSource}) is at or above the host's own compaction window ${window.tokens}: the host compacts the session before this floor can ever be reached, so Gate A is never asked (this is the #48 failure mode)`,
      );
    } else if (window.tokens !== null && floor >= Math.floor(0.85 * window.tokens)) {
      say('warn', `effective depth floor ${floor} (${floorSource}) is within 15% of the host's compaction window ${window.tokens}: most sessions will compact before reaching it`);
    } else if (window.tokens === null && floorSource === 'fallback_absolute') {
      // Doctor has no session, so no model: this is the configured half only. At runtime the hook also reads the
      // session's model from the transcript, which settles most unconfigured sessions (host-window.ts).
      say(
        'warn',
        `no autoCompactWindow is configured where a hook can read it (env, managed, project-local, project, user settings). At runtime the window then comes from the session's model: 1M for Opus 4.7+, Sonnet 5 and Fable on the Anthropic API (floor ${Math.min(LEGACY_DEPTH_FLOOR, Math.floor(c.delegationDepthFraction * HOST_WINDOW_MAX))}), 200K for other models or with CLAUDE_CODE_DISABLE_1M_CONTEXT (floor ${Math.min(LEGACY_DEPTH_FLOOR, Math.floor(c.delegationDepthFraction * STANDARD_CONTEXT_WINDOW))}). When the model does not settle it either (a gateway alias, a native-1M model on Bedrock/Vertex/Foundry), the floor is the fixed ${floor} (${floorSource}), which a 200K session never reaches: set autoCompactWindow, or delegationDepthFloor, to make it explicit`,
      );
    } else {
      say(
        'info',
        `effective depth floor: ${floor} (${floorSource}): a prompt arriving with less context than this stays direct and sends no Gate A request (recorded as depth_below_floor)${floorSource === 'cost_model' ? ', because below it no tool-call answer could repay the coordinator' : ''}; an unreadable transcript is depth_unknown and also stays direct`,
      );
    }
    if (c.mode === 'off') {
      say('info', 'mode=off: no guidance, no Jev, no job state, no trace writes. Loaded agent definitions still exist; remove the plugin for the absent-plugin condition');
      // #48 P2 Task 4.4: dist/entry.js's short-circuit removes the gate's *own* import/admission cost, not the host's
      // per-hook-event process spawn -- that cost is the plugin being registered at all, and only disabling it removes it.
      say('warn', 'mode=off still starts a node process for every matched hook event (hooks.json/lean.json registration is unconditional): to remove that cost too, disable the plugin with `claude plugin disable jev-gate@<marketplace>`');
    }
    if (c.mode === 'native') say('info', 'mode=native: guidance + owned profiles + job state and guard when orchestration starts, no Jev request');
    if (c.mode === 'auto') say('info', 'mode=auto: admission, allocation and result gates send the request, the planned task and the worker reply to TypeSafe (may include source excerpts and prior constraints)');
    say('info', `job state directory: ${jobsDir(env)} (0700, one 0600 file per session, removed after 7 days)`);
    if (env['JEV_GATE_EXPERIMENT_ADMISSION'] === 'orchestrated') say('warn', `JEV_GATE_EXPERIMENT_ADMISSION=orchestrated is set: every prompt starts an orchestrated job in ${c.mode} mode without a Gate A request (recorded as forced/admission_forced); allocation and result gates are unaffected`);
    if (c.workerIsolation === 'worktree') {
      let snapshot = false;
      try { snapshot = JSON.stringify(JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8'))?.hooks?.WorktreeCreate).includes('/dist/worktree-cli.js'); } catch { /* Standalone/legacy adapters retain the native baseRef behavior. */ }
      if (snapshot) say('info', 'workerIsolation=worktree: the installed WorktreeCreate hook snapshots current working files with a private index; root HEAD and index are preserved. No manual baseRef setting is needed');
      else {
      const baseRef = readHostWorktreeBaseRef(env, cwd);
      if (baseRef.value === 'head') say('info', `workerIsolation=worktree with worktree.baseRef="head" (${baseRef.source}): every planned worker dispatch the hook patches also carries isolation: "worktree" (an ad-hoc or single-executor dispatch never does); whether the host actually gives that worker its own git worktree for a patched call is not yet observed`);
      else say('warn', `workerIsolation=worktree is not in effect: host worktree.baseRef is ${baseRef.value === null ? (baseRef.source === 'unset' ? 'unset' : `unknown (${baseRef.source})`) : `"${baseRef.value}" (${baseRef.source})`}, so an isolated worker would start from origin/<default-branch> instead of this branch. The hook runs such turns as workerIsolation=none with one worker at a time; set "worktree": {"baseRef": "head"} in Claude Code settings to use it`);
      }
    } else say('info', `workerIsolation=${c.workerIsolation}: workers share the caller's working tree; maxParallelWorkers stays 1 under this setting`);
  };

  const checkClaude = (): string | null => {
    const version = runCommand('claude', ['--version'], env);
    if (version.error || version.status !== 0) {
      say('warn', `claude CLI not runnable (${version.error ?? `exit ${String(version.status)}`}); install/login is the user's step`);
      return null;
    }
    const detected = /^(\d+\.\d+\.\d+)(?:\s|$)/.exec(version.stdout.trim())?.[1] ?? null;
    say(detected ? 'ok' : 'warn', `claude ${detected ?? 'version unknown'} (hook trust and active policy application require native execution records)`);
    const parsed = parseAuthStatus(runCommand('claude', ['auth', 'status'], env));
    if (!parsed.ok) {
      say('warn', `auth unverified: ${parsed.reason}`);
      return detected;
    }
    const s = parsed.status;
    if (!s.loggedIn) {
      say('warn', 'not logged in; use `claude auth login` or /login (jev-gate never logs in for you)');
      return detected;
    }
    say(isSubscriptionOAuth(s) ? 'ok' : 'warn', `auth: method=${String(s.authMethod)} provider=${String(s.apiProvider)} subscription=${String(s.subscriptionType ?? 'unknown')}${isSubscriptionOAuth(s) ? '' : ' (supported condition is claude.ai subscription OAuth; other methods are unverified)'}`);
    return detected;
  };

  const checkEnv = (mode: Mode | null): void => {
    const conflicts = AUTH_CONFLICT_ENV.filter((k) => env[k]);
    say(conflicts.length ? 'warn' : 'ok', conflicts.length ? `auth-related env set: ${conflicts.join(', ')} (may replace subscription OAuth; jev-gate does not change it)` : 'no API-key/gateway/cloud env overrides detected');
    /**
     * A launch variable as a session started here would see it: a settings `env` block (managed, project-local, project,
     * user) is applied over the shell's environment, so it wins. Only a variable the launcher alone sets stays invisible.
     */
    const launch = (k: string): string | undefined => {
      const found = readSettingsEnvVar(env, cwd, k);
      return found !== null && !('ambiguous' in found) ? found.value : env[k];
    };
    if (!leanPackage) {
      const functionHooks = launch('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS');
      say(functionHooks === '0' ? 'warn' : 'info', functionHooks === '0' ? 'Function Hooks explicitly disabled: Router, Compact and Output cannot register' : `Function Hooks launch setting: ${functionHooks === '1' ? 'enabled' : 'unknown/default'}; registration and execution require native records`);
    }
    // #48: auto and lean refuse admission as host_unsupported under both conditions below, so the gate can never act.
    const gated = mode === 'auto' || mode === 'lean';
    const o = subagentModelOverride({ CLAUDE_CODE_SUBAGENT_MODEL: launch('CLAUDE_CODE_SUBAGENT_MODEL'), CLAUDE_CODE_SUBAGENT_MODEL_FORCE: launch('CLAUDE_CODE_SUBAGENT_MODEL_FORCE') });
    const overrideEffect = gated ? `mode=${mode} stays native on every prompt as host_unsupported and sends no Jev request` : 'eligible calls are preserved (no routing)';
    if (o.force) say(gated ? 'fail' : 'warn', `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1: every subagent model is overridden; ${overrideEffect}`);
    else if (o.concrete) say(gated ? 'fail' : 'warn', `CLAUDE_CODE_SUBAGENT_MODEL is a concrete override; ${overrideEffect}`);
    else if (o.value === 'inherit') say('info', 'CLAUDE_CODE_SUBAGENT_MODEL=inherit is treated as unset on v2.1.196+ (harmless)');
    else say('ok', 'no CLAUDE_CODE_SUBAGENT_MODEL override');
    const fork = launch('CLAUDE_CODE_FORK_SUBAGENT');
    const bg = launch('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
    if (fork === '0' && bg !== '1') say('ok', 'launch profile: responsive background owned agents enabled (fork=0; background tasks enabled)');
    else if (fork === '0' && bg === '1') say('warn', 'launch profile: CLAUDE_CODE_FORK_SUBAGENT=0 and CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 (foreground Agent calls; not a global scheduler)');
    else if (gated && !foregroundDispatchPossible({ CLAUDE_CODE_FORK_SUBAGENT: fork, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: bg })) {
      say('fail', `mode=${mode} but a fresh owned Agent profile is unavailable (fork=${fork ?? 'unset'}, disable_background=${bg ?? 'unset'}, read from this shell and the managed, project and user settings env): every prompt stays native as host_unsupported and sends no Jev request. Start Claude Code with CLAUDE_CODE_FORK_SUBAGENT=0, or set mode to off. A variable only the launcher sets is not visible here.`);
    } else if (fork === '1') say('warn', 'CLAUDE_CODE_FORK_SUBAGENT=1: Agent calls run in the background and lack run_in_background; eligible calls are preserved');
    else if (fork === '0' || bg === '1') say('ok', `launch profile: fork=${fork ?? 'unset'}, disable_background=${bg ?? 'unset'} (fresh owned Agent calls supported; background execution supported when disable_background is 0 or unset)`);
    else say('info', `launch profile not set (fork=${fork ?? 'unset'}, disable_background=${bg ?? 'unset'}): interactive sessions default to fork mode, where Agent calls omit run_in_background and V4 preserves them. Start with CLAUDE_CODE_FORK_SUBAGENT=0`);
    if (env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'] === '1') say('info', 'agent teams enabled: a named Agent call becomes a teammate; the coordinator guidance asks for no teammate name');
    const recording = recordingStatus(env);
    say(recording.error ? 'warn' : 'ok', `Jev local recording ${recording.enabled ? 'on (default)' : 'off'}: Router/Compact/Output do not require --debug; toggle with recording on|off${recording.error ? ` (${recording.error})` : ''}`);
    const debugDir = launch('CLAUDE_CODE_DEBUG_LOGS_DIR');
    if (debugDir) say('ok', `CLAUDE_CODE_DEBUG_LOGS_DIR=${debugDir}: Router/Compact/Output decisions are recorded there for the dashboard`);
    else say('info', 'Claude debug logs are optional; independent Jev metadata recording is available without --debug');
    report.group('credentials');
    const keyEnv = { ...env, TYPESAFE_API_KEY: launch('TYPESAFE_API_KEY') };
    const overrideKey = apiKeyOverride(keyEnv);
    if (overrideKey?.trim() && !validApiKey(overrideKey)) say('fail', 'Jev API key override has an invalid format (value hidden)', 'Correct or remove the explicit key override; it takes precedence over the private credential store.');
    const key = resolveApiKey(keyEnv);
    if (!leanPackage) {
      say('info', 'Router automatic Fable default: off; active routerAllowFable is controlled by the host plugin options. Capabilities do not establish account access; missing response model/effort remains unknown.');
      say('info', `Router launch pins: model=${launch('ANTHROPIC_MODEL')?.trim() ? 'present' : 'absent'}; effort=${launch('CLAUDE_CODE_EFFORT_LEVEL')?.trim() ? 'present' : 'absent'} (values hidden; injector source unknown). Starting with /model or --model establishes a baseline, not a permanent routing pin.`);
      let installed = 'unknown'; try { const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin/plugin.json'), 'utf8')); if (typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version)) installed = manifest.version; } catch { /* metadata unknown */ }
      say('info', `Router installed package=${installed}; loaded hook version=unknown to doctor. The active root record reports hook_version, host_version, incoming/effective effort, pins, candidate exclusions and selection threshold. Restart an already open host after updating; the installed manifest does not prove its loaded hook version.`);
      say('info', '/context summaries and previous cache usage do not establish the current request size. Unsupported or unobserved model/effort combinations preserve the native baseline.');
    }
    say(key ? 'ok' : 'warn', key ? 'Jev API key available from the plugin option, environment or shared private store (value not shown)' : 'Jev API key missing: the installed plugin opens a local key-entry screen; Gate/Lean/Router remain native until a key is supplied');
    if (existsSync(join(cwd, '.env'))) say('info', '.env in cwd is NOT auto-loaded by the hook; export the variable in the shell that starts Claude Code');
  };

  const checkUserSettings = (): void => {
    const p = join(claudeConfigDir(env), 'settings.json');
    if (!existsSync(p)) return;
    try {
      const s = JSON.parse(readFileSync(p, 'utf8')) as unknown;
      if (!isRecord(s)) return;
      if ('apiKeyHelper' in s) say('warn', 'settings.json has apiKeyHelper: the session may not use subscription OAuth');
      const env = isRecord(s['env']) ? Object.keys(s['env']) : [];
      const risky = env.filter((k) => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_SUBAGENT_MODEL') || k === 'CLAUDE_CODE_FORK_SUBAGENT' || k === 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS');
      if (risky.length) say('warn', `settings.json env sets ${risky.join(', ')} (names only; not modified)`);
    } catch {
      say('warn', 'cannot parse ~/.claude/settings.json');
    }
  };

  /**
   * #48 P2: the same ring SessionStart reads, surfaced in doctor so `jev-gate doctor` alone answers "is Gate A ever
   * firing" without waiting for a session to start (or for the warning's own 50-decision window to fill first).
   */
  const checkLiveness = (): void => {
    const state = readLiveness(env);
    if (state === null) {
      say('info', `liveness: no record yet at ${livenessPath(env)} (written by the first auto-mode admission decision)`);
      return;
    }
    const attempted = state.recent.filter((e) => e.attempted).length;
    say('info', `liveness: ${state.recent.length}/${LIVENESS_WINDOW} recent auto-mode decisions recorded, ${attempted} attempted a Gate A call`);
    if (state.recent.length >= LIVENESS_WINDOW && attempted === 0) {
      say('warn', `liveness: the last ${state.recent.length} auto-mode admission decisions never attempted a Gate A call -- same condition SessionStart's systemMessage warns about`);
    }
  };

  report.group('runtime');
  const [major, minor] = process.versions.node.split('.').map(Number);
  say(major! > 22 || major === 22 && minor! >= 15 ? 'ok' : 'fail', `Node ${process.versions.node} (requires >= 22.15)`);
  report.group('package');
  const installedModels = checkPluginFiles();
  report.group('configuration');
  const loaded = loadConfig(env);
  inspect('configuration', () => checkConfig(loaded));
  if (leanPackage && loaded.ok && !['lean', 'off'].includes(loaded.config.mode)) say('fail', 'Lean package supports only lean/off mode; legacy Gate and tier routing are not present');
  if (loaded.ok && loaded.config.mode !== 'lean' && !leanPackage) checkModelAuthority(loaded.config.models, installedModels);
  report.group('host');
  const hostVersion = checkClaude();
  const inventory = leanPackage ? missingInventory() : await claudeModelInventory(env, cwd);
  const configured = loaded.ok && loaded.config.mode !== 'lean' ? OWNED_AGENT_PROFILES.map(profile => ({ model: loaded.config.models[profile.tier], effort: profile.effort as SymbolicEffort | null })) : [];
  for (const name of ['FAST', 'STANDARD', 'DEEP', 'FRONTIER']) { const model = env[`CLAUDE_PLUGIN_OPTION_ROUTER${name}MODEL`]; if (model?.trim()) configured.push({ model, effort: null }); }
  const compatibility = leanPackage ? [] : claudeCompatibility(inventory, hostVersion, configured, env['CLAUDE_PLUGIN_OPTION_ROUTERALLOWFABLE'] === 'true');
  report.checks.push(...compatibilityChecks(compatibility));
  report.group('models');
  if (leanPackage) say('info', 'Lean executor inherits native model and effort; no tier routing targets or native catalog probe');
  else if (!inventory.complete) say('warn', `Native Claude model inventory is incomplete or unavailable (${inventory.error ?? 'unknown'}); unsupported or unobserved capabilities remain unverified`);
  report.group('configuration');
  inspect('environment', () => checkEnv(loaded.ok ? loaded.config.mode : null));
  report.group('configuration');
  inspect('host settings', checkUserSettings);
  report.group('activity');
  if (!leanPackage) inspect('liveness', checkLiveness);
  say('info', leanPackage ? 'Lean /hooks: UserPromptSubmit, Agent PreToolUse/PostToolUse/Failure and owned SubagentStop only; executor inherits native selection. No Gate A/B/C or tier routing.' : `in Claude Code: /hooks should list seven jev-gate lifecycle entries (UserPromptSubmit, PreToolUse with no matcher, PostToolUse on ^(Agent|TaskStop)$, PostToolUseFailure on ^Agent$, Stop, SessionStart, owned SubagentStop); the @agent- typeahead should show ${Object.keys(OWNED_AGENTS).join(', ')} once each`);
  say('info', `start: JEV_GATE_MODE=${leanPackage ? 'lean' : 'auto'} CLAUDE_CODE_FORK_SUBAGENT=0 claude --model sonnet --plugin-dir "${root}"  (doctor performed no inference; a passing doctor is not proof of patch support, effort support or model access)`);
  report.group('storage');
  inspect('storage', () => { for (const path of [jobsDir(env), claudeTraceDir(env)]) { const issue = storageIssue(path); say(issue ? 'fail' : 'ok', `storage: ${path}: ${issue ?? 'readable/writable or creatable (not created by doctor)'}`); } });
  report.group('activity');
  const dashboard = await dashboardDiagnostic(env); say(dashboard.level, dashboard.message);
  report.group('version');
  const release = options.checkUpdate ? await checkRelease() : unknownRelease();
  const version = versionDiagnostic(root, 'claude', release); say(version.level, version.message);
  return { ...finishDoctor('claude', root, report.checks, release), models: { source: leanPackage ? 'Lean executor inherits native selection; no routing catalog requested' : 'native Claude SDK initialize (safe mode, no user message)', complete: inventory.complete, accountAccess: 'unverified', compatibility } };
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

/**
 * `doctor` answers whether the gate is installed; `explain` answers what it then did. The second was the missing half:
 * every decision was already recorded, and reading it meant opening benchmark JSON by hand.
 */
const explain = (dir: string | undefined): void => {
  const target = dir ?? configuredDir(undefined, 'JEV_GATE_TRACE_DIR') ?? claudeTraceDir(process.env);
  if (!target) {
    process.stdout.write('explain: pass a trace directory, or set JEV_GATE_TRACE_DIR\n');
    process.exitCode = 2;
    return;
  }
  for (const line of explainDir(target)) process.stdout.write(`${line}\n`);
};

/** A shell env wins. Otherwise the same settings env the host would give the hook, and only that one name. */
const configuredDir = (flag: string | undefined, key: string): string | null => {
  if (flag && flag.length > 0) return flag;
  const fromEnv = process.env[key];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const found = readSettingsEnvVar(process.env, process.cwd(), key);
  if (found && 'value' in found && found.value.length > 0) return found.value;
  if (key === 'JEV_GATE_TRACE_DIR') return claudeTraceDir(process.env);
  if (key === 'CLAUDE_CODE_DEBUG_LOGS_DIR') return join(claudeConfigDir(process.env), 'debug');
  return null;
};

const flagValue = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
};

const dashboard = async (argv: string[]): Promise<void> => {
  if (['on', 'off', 'status'].includes(argv[0] ?? '')) {
    process.stdout.write(dashboardPreferenceCommand(process.env, argv[0]!) + '\n');
    if (argv[0] === 'on') await ensureDashboard(dirname(dirname(fileURLToPath(import.meta.url))), process.env);
    return;
  }
  const host = flagValue(argv, '--host');
  if (host && host !== 'codex' && host !== 'claude') throw new Error('--host must be codex or claude');
  const portArg = flagValue(argv, '--port');
  const port = portArg === undefined ? 4731 : Number(portArg);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write('dashboard: --port needs an integer from 0 to 65535\n');
    process.exitCode = 2;
    return;
  }
  const started = await startDashboard(
    { ...dashboardSources(process.env, host as 'codex' | 'claude' | undefined),
      ...(flagValue(argv, '--trace') ? { traceDir: flagValue(argv, '--trace')!, traceDirs: undefined } : {}),
      ...(flagValue(argv, '--debug') ? { debugDir: flagValue(argv, '--debug')! } : {}) },
    port,
  );
  process.stdout.write(`dashboard: ${started.url}\n`);
  process.stdout.write('local records only; nothing is sent to Jev. Ctrl-C stops it.\n');
  if (process.platform === 'darwin' && process.env['JEV_DASHBOARD_NO_OPEN'] !== '1') {
    const opened = spawn('open', [started.url], { stdio: 'ignore', detached: true });
    opened.on('error', () => undefined);
    opened.unref();
  }
};

if (isMainModule()) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'doctor') {
    if (argv.slice(1).some(v => !['--json', '--verbose', '--check-update'].includes(v))) { process.stderr.write('doctor: use --json, --verbose or --check-update\n'); process.exitCode = 2; }
    else void claudeDoctor(root, process.env, process.cwd(), { checkUpdate: argv.includes('--check-update') }).then(report => { process.stdout.write(argv.includes('--json') ? JSON.stringify(report) + '\n' : renderDoctor(report, argv.includes('--verbose'))); process.exitCode = report.ok ? 0 : 1; }).catch(() => { process.stderr.write('doctor: unable to complete local diagnostics\n'); process.exitCode = 1; });
  }
  else if (argv[0] === 'dashboard-serve') {
    void serveAutomaticDashboard(dirname(dirname(fileURLToPath(import.meta.url))), process.env, argv[1] ?? '').catch(() => undefined);
  }
  else if (argv[0] === 'recording') {
    try { process.stdout.write(recordingCommand(process.env, argv[1]) + '\n'); }
    catch { process.stderr.write('recording: use on, off or status; the local settings directory must be writable\n'); process.exitCode = 1; }
  }
  else if (argv[0] === 'explain') explain(argv[1]);
  else if (argv[0] === 'dashboard') {
    dashboard(argv.slice(1)).catch((err: unknown) => {
      process.stderr.write(`dashboard: ${err instanceof Error ? err.message : 'failed'}\n`);
      process.exitCode = 1;
    });
  } else {
    process.stdout.write('usage: node dist/cli.js doctor [--json|--verbose] [--check-update]\n       node dist/cli.js explain [trace-dir]   (default: $JEV_GATE_TRACE_DIR)\n       node dist/cli.js dashboard [on|off|status] [--port 4731] [--trace dir] [--debug dir]\n       node dist/cli.js recording on|off|status\n');
    process.exitCode = 2;
  }
}
