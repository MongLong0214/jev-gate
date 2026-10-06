# Advanced usage

Install, the five parts, and what a normal session sends are in the [README](../README.md). This page is Gate and lean configuration, background execution and worktree conditions, and a checkout. It is not a benchmark report. Older measurements are linked at the bottom and are not restated as current results.

Option names and defaults for Compact, Output, the Router, and Evidence stay in their own pages: [Compact](../mods/compact/README.md), [Output](../mods/output/README.md), [Router](../mods/router/README.md), [Evidence](../plugins/evidence/README.md). The manifest is [plugin.json](../.claude-plugin/plugin.json).

## Gate modes

`gateMode` does not turn Compact, Output, the Router, or Evidence off.

| Mode | What runs | Gate request |
|---|---|---|
| `off` | No admission, no guidance, no guard, no Gate state or trace write. The host still starts the hook process. Agent definitions stay installed. | None |
| `native` | The same roles, guard, and contracts if you start them. The session decides whether to call the planner and which worker profile to name. | None |
| `auto` | Gate A on an eligible root prompt. An admitted turn is single or orchestrated, below. Gate B on an eligible planner or worker dispatch. | At most one per eligible gate event. No retry |
| `lean` | Not Gate A, not the planner, not the guard. One judgement over prior history, then at most one `jev-gate:executor` on the inherited model. | One batch, or none if a local check stops it. [Below](#lean) |

`auto` is the manifest default and the call-path default of a legacy plugin hook with no config file. `off` is the call-path default for `--lean`, doctor, and a bare `node`. `lean` is opt-in.

An admitted turn is one of two shapes. `single` (the usual one under `admittedShape: "auto"`) dispatches the request once to a worker and does not run the planner. `hierarchy` runs a planner, then workers. Gate A calls the second shape orchestrated. Both are admitted jobs: the root is told to coordinate, and the guard below is on until terminal acceptance with no active work. Then the root can do remaining checks, integration and reporting under its native permissions. Reuse the observed checks for the same state; new edits, merges and explicitly requested independent reviews still need their own checks. Command success does not prove all requirements were met. A direct admission does not start a job or the guard.

The default `guardAllowTools: ["*"]` permits every native root tool, including MCPs and native Agent roles. A permitted call emits no approval: normal host permissions still apply. An explicit narrower list restores the read/task allow-list plus configured extras. Owned Jev dispatches still require their current marker, reservation and contract. Worker and planner profiles inherit the connected tools the host provides; child sessions are not root guarded.

Acceptance is not a Jev call. A worker accept is an observed passing run of each declared check after the last observed Edit, Write, MultiEdit, or NotebookEdit in that worker's transcript. It does not certify an edit made inside Bash, by another editor, or by another process, and it does not certify that the check was the right one or that the current files are fully certified. The comparison is on by default (`verifyWorkerChecks`). The normal path does not make the old Gate C HTTP call.

Uncertainty keeps the call that was already going to happen: a tie, low confidence, abstain, a missing key, a timeout, or an invalid response. A tier above standard needs a concrete upgrade basis on the task. Model names in config are aliases or exact IDs the patch proposes for a worker or planner. They do not change the root session's model, and they do not grant account access. `routeMainModel` is a Router option and defaults to true. The fast tier asks for low effort; haiku was observed, on 2026-09-18, not to apply a requested effort. That is a host fact about that model, not a new measurement.

New automatic atomic jobs carry the user request verbatim. If the request or complete single-worker packet cannot fit the existing UTF-8 bounds, the request stays in the main session. A final packet failure consumes no worker reservation, attempt or Gate B call. Previously stored jobs without the policy revision keep their existing whole-or-omitted behaviour.

## When auto still sends nothing

A missing key, a missing Function Hooks flag, and an unsupported fork profile are different. The flag does not affect Gate.

- No `prompt_id`, a slash command, a child caller, or blank input: no admission request.
- The session cannot run a fresh owned worker, or a concrete `CLAUDE_CODE_SUBAGENT_MODEL` / `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set: `auto` and `lean` stay native (`host_unsupported`) and do not send. [Background execution](#background-execution-and-worktrees).
- Depth below the floor: the turn stays direct and Gate A is not asked. [Floor](#depth-floor).
- The composed answer says the turn is not worth delegating, forbids delegation, or is otherwise not admitted: direct, no planner, no guard.
- Invalid config, other than an explicit `off`: the hook reports the error and preserves the call. It is not treated as "no file".

## Mode precedence

Checked on Claude Code 2.1.284 only (native install). Not checked on any other version or install.

An unset `gateMode` is not exported. It does not override a config file. A valid explicit `JEV_GATE_MODE` wins, then an explicit `gateMode`, then a valid config file, then the call-path default (`auto` only for a legacy plugin hook with no file; `off` for `--lean`, doctor, and a bare `node`).

`JEV_GATE_MODE=off` returns before the file is read. `--lean`, doctor, and a bare `node` still keep a valid file's mode when nothing overrides it. A bad or unreadable explicit config, with no `off` override, is an error (`missing file`, invalid JSON, or `EACCES`), not `auto`.

`pluginConfigs` are read from user settings, an explicit `--settings` file, and managed settings. The same key in project settings or in project `.claude/settings.local.json` is ignored. On 2.1.284 the explicit value was seen from user settings and from `--settings`. Managed settings are the same contract and were not part of that check. `env` in a project settings file is a different contract.

The Gate file, if you use one, is `$HOME/.config/jev-gate/config.json`, or the path in `JEV_GATE_CONFIG`. The plugin does not load a project's `.env`. An interactive shell file such as `~/.zshrc` is not enough for the key: the process that starts Claude Code has to see it. Doctor passing in a terminal is not evidence that the `claude` process has the key.

A V3 or V4 file is rejected with a sample. The plugin does not rewrite it. A key that is not in the object below is rejected. A key you omit takes the default shown. `mode` omitted from a file is `off`, the code default. That is not the plugin's call-path default: a legacy plugin hook with no file still runs `auto`. Copying this object into the file therefore sets `mode` to `off`. `resultConfidenceFloor` is accepted and unused. `requestDeadlineMs` must be in `(0, 3500]`.

```json
{
  "version": 5,
  "mode": "off",
  "jevModel": "jev-1.13.0",
  "requestDeadlineMs": 3000,
  "admissionConfidenceFloor": 0.8,
  "routeConfidenceFloor": 0.8,
  "resultConfidenceFloor": 0.8,
  "plannerDefaultTier": "deep",
  "maxParallelWorkers": 16,
  "guardAllowTools": ["*"],
  "workerIsolation": "worktree",
  "delegationDepthFloor": 0,
  "delegationDepthFraction": 0.6,
  "maxTasksPerPlan": 64,
  "admissionQuestionShape": "atomic",
  "routeQuestionShape": "atomic",
  "admittedShape": "auto",
  "delegationCoordinatorTurns": 11,
  "delegationWorkerTokensPerCall": 40000,
  "guardAllowMcp": true,
  "verifyWorkerChecks": true,
  "planInterpretation": true,
  "models": {
    "fast": "haiku",
    "standard": "sonnet",
    "deep": "opus",
    "frontier": "claude-fable-5-1"
  }
}
```

`admittedShape` `auto` runs `single` when effective `maxParallelWorkers` is 1. Above 1, separate outcomes (`parallel_outcomes >= .6`) or a whole project (`size >= 4`) select `hierarchy`; otherwise it selects `single`. An unreadable required shape answer stays direct unless the other OR arm already proves hierarchy. `single` and `hierarchy` pin one shape. `admissionQuestionShape` and `routeQuestionShape` default to `atomic`: the judgement is composed in this plugin, and the matching composite confidence floor is not consulted. Atomic Gate A requires a uniquely self-contained answer with at least .8 probability, a valid five-bin Score, positive rounded point saving and at least .8 normalized distribution support for positive-saving bins. This support is a policy heuristic, not a probability of actual savings. It asks three facts at cap 1 or a fixed shape, five for auto above cap 1, in one HTTP batch. Atomic Gate B asks six task facts, with candidate-local model/effort allocation questions added to the same bounded HTTP batch: yes is at least .6, no at most .4, and the middle preserves the called tier. Specific difficulty upgrades fast/standard to deep; deep/frontier are retained. Fast needs fully specified or repetitive work, fixed interfaces and stated checks, with both difficulty facts negative. `composite` is the single choice question. `planInterpretation` is true by default; false skips the extra request. Turned on, it classifies clauses and rejects nothing; the plan is adopted either way. `maxTasksPerPlan` rejects a plan above that many tasks. `maxParallelWorkers` defaults to 16. Above 1, `workerIsolation` must be `worktree`, and `guardAllowTools` must include `Bash` or `*`. `guardAllowMcp` changes only the root guard; it never says which MCPs a worker has.

On Claude Code, the frontier preference is `claude-fable-5-1`, but automatic Fable is disabled unless `routerAllowFable` is boolean true. A role mapping does not authorize a restricted family. Codex derives its default frontier ID from the account's live model catalog. Gate tier configuration does not change the root session's model; the independent Router controls that.

## Depth floor

The depth floor defaults to `0`. With an explicit `delegationDepthFloor: null` and the atomic shape, that null does not use the host's compaction window. The floor is the shallowest depth at which the largest tool-call bin could still pay. The live map from that score to estimated root turns is `[4, 6, 6, 26.5, 51.5]`. At the defaults (`delegationCoordinatorTurns` 11, `delegationWorkerTokensPerCall` 40000) the floor is 50865. The formula is `floor(turns * delegationWorkerTokensPerCall / (turns - delegationCoordinatorTurns)) + 1` with `turns` the last bin. The bins are owner-reported estimates of root turns, not a count of tool calls and not a measured bill. Changing the two constants changes the floor. This is not a savings guarantee.

`delegationDepthFloor` set to an integer, including `0`, replaces that derivation. `0` turns the floor off. A transcript that cannot be read still keeps the turn direct.

`admissionQuestionShape: "composite"` has no price. Its floor, when `delegationDepthFloor` is null, is `min(300000, floor(delegationDepthFraction * window))` when the window is known, and 300000 when it is not. `delegationDepthFraction` defaults to 0.6, accepted from 0.25 to 0.95. It is a policy value, not a measured crossing.

The window is read from `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, then managed settings, then project-local, project, and user settings. A launch `--autocompact` or `--settings` flag, MDM, and server-managed settings are not visible to the hook. When nothing is configured, a composite floor uses the model window the hook can infer from the session, and 300000 when it cannot. The atomic floor does not read the window. Doctor prints the window, its source, and the effective floor. It fails when that floor is at or above a known window, and warns when the floor is within 15% of one. With no configured window and the composite fallback, it warns that the runtime window comes from the session's model.

The map this replaced, and the withdrawn savings claims attached to an earlier floor, are in the [v0.6.3 README](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/README.md#results) and the files under [Recorded runs](#recorded-runs). Those files are not edited to match the live map.

## Background execution and worktrees

Ordinary installation prepares `CLAUDE_CODE_FORK_SUBAGENT=0` and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=0`. Owned planner, worker and Lean reservations dispatch with `run_in_background: true`, preserving the complete patched input and native permissions. Explicit owner profiles stay authoritative: fork mode remains unsupported, and a manually disabled background setting remains foreground. The complete old Jev-generated foreground profile is migrated automatically; restart once when the initialization notice asks. No environment editing is needed for ordinary use.

A background job keeps its original prompt identity and contracts across subsequent main conversation questions. `async_launched` records a running worker and keeps ownership. Claude `SubagentStop` must match the native agent identity or private dispatch token, profile and bounded native transcript terminal before the original result is checked. An observed successful `TaskStop` releases that exact execution without accepting it. A main tool failure, unknown termination, or cancellation request alone keeps ownership. Late results from retired jobs are recorded as unknown and cannot advance a newer plan.

Codex `jev_agent` defaults to background execution. `action: "status", agent_id: "<returned identity>"` collects its result without waiting; `action: "cancel"` requests explicit cancellation. Native worker `turn/completed` owns terminal settlement. Main interruption leaves background work running; ending the native session requests child interruption. Connection loss preserves unconfirmed reservations and file protection. Advanced callers can explicitly request `run_in_background: false` for a synchronous execution.

`workerIsolation` defaults to `worktree`. Patched planned workers receive `isolation: "worktree"`; planners and single executors stay in the root. The integrated Claude plugin uses its `WorktreeCreate` hook, and Codex creates the same snapshot inside the captured native permission scope. Each snapshot includes staged, unstaged and untracked working files and excludes ignored files. A private Git index leaves the root HEAD, index and files intact. Record the worker's initial HEAD as its snapshot baseline; after checks, commit worker changes and apply only `git diff --binary <baseline> <worker-branch>` with `git apply` in the root. Integrate predecessors before creating dependent workers. Conflicting root changes require resolution; do not merge the snapshot commit. Explicit native worktree settings are preserved; the integrated snapshot hook selects its own baseline.

## What Gate sends

In `auto`, the normal path sends two kinds of text to TypeSafe: the user request at admission, and the composed task contract with the relevant predecessor summaries at each eligible planner or worker dispatch. That text can include source excerpts, file names, and earlier constraints. The hook does not independently upload the repository, the transcript, or the environment. There is no secret scrubber and no zero-retention promise. Enable `auto` only for data you are allowed to send.

`native` and `off` send no Gate request. They do not stop the Router or Evidence. Those switches are in the [README](../README.md#settings-data-and-what-leaves-the-machine).

Optional traces (`JEV_GATE_TRACE_DIR`) are local per-phase JSON: lengths, hashes, decisions, Jev usage, and the reported model. The writer is not given the key. Current records store a prompt's length and hash, not its text. They are not uploaded. Job state is one file per session. The directory is `<stateRoot>/jev-gate/jobs/`, where `stateRoot` is `JEV_GATE_STATE_DIR` when that is set, otherwise `XDG_STATE_HOME`, otherwise `~/.local/state`. The file holds the plan and the request. A file older than 7 days is removed only when cleanup can establish no retained executor identity or unsettled native execution. Background reservations remain protected across age and history limits until termination is observed. This plugin has no command that deletes job files, traces, credentials, or transcripts.

`node dist/cli.js explain <trace-dir>` reads those records. A missing record means nothing was recorded, not that nothing happened. A worker verdict is what the worker reported. A model after `ran` is what the host reported, not a check that a patch took effect.

When Gate A answers `needs_context` for the prompt alone, it is asked once more with the last three turns the user typed in this session attached as context (#115). Tool results, host and hook messages, `/commands`, subagent turns and any turn that looks like a credential are never included. The second `admission_result` record carries `context_turns`. A second `needs_context` is final and the turn stays direct.

## Lean

`lean` shares the dispatcher, state files, locks, trace, and TypeSafe client with the other modes. It does not run Gate A, Gate B, the planner, the task graph, tier routing, the depth floor, the root guard, or plan interpretation. Set it with `gateMode` or `JEV_GATE_MODE`. The marketplace plugin already includes `agents/executor.md`. You do not install a second plugin.

On an ordinary request, one batched Jev request can carry the current request, the mandatory layer (the current words, every active human turn, and the supported compact summary), and enumerated earlier groups. The questions are work shape, handoff scope, and keep or omit per group. Credential screening is a local pattern check. It is a filter, not a DLP and not a no-retention promise. If the request or a required turn matches, nothing is sent and the turn stays native. An optional group that matches is withheld. Groups that do not fit the provider bound are left unassessed, not sliced.

No optional group, no key, or an unreadable transcript: native, and no request. A short, unclear, forbidden, or needs-context answer, or a packet that omits nothing: native. The request is still paid for when it was sent. Otherwise the hook can hand one executor a packet. The packet is not placed in the root's additional context. There is no root guard in `lean`. The recommendation can be ignored. An explicit request not to delegate is not reliably classified as forbidden; for work that must not be delegated, leave `lean` off. The probe behind that limit is in [Recorded runs](#recorded-runs).

A smaller packet is not a measured saving. The comparisons that were specified are ordinary Claude with auto-compact, and a deterministic recency packet. No product saving is claimed.

The separate lean archive (`node scripts/pack.mjs --profile lean` from a checkout) ships only the executor. Selecting `auto` or `native` there is `profile_mode_mismatch`, not a guard for roles the archive does not contain.

## Doctor and explain

From a built checkout, `node dist/cli.js doctor` reads this tree. From an installed bundle, `node <plugin-dir>/dist/cli.js doctor` reads that bundle. Evidence is the other program: `node <plugin-dir>/plugins/evidence/dist/server.mjs --doctor`. A passing doctor is not model access, not source accuracy, and not a performance guarantee.

Doctor reports the launch profile, key presence (not validity), the role files, a model-family mismatch between config and installed frontmatter, the compaction window, the effective floor, and liveness. Liveness is `<stateRoot>/jev-gate/liveness.json`, a ring of the last 50 auto-mode admission decisions. Doctor warns when all 50 never attempted Gate A. In `off`, doctor warns that the hook process still starts; `claude plugin disable jev-gate@jev-gate` is what stops that. Explain is `node dist/cli.js explain`. Neither command calls Jev.

The installed plugin opens one shared dashboard automatically for Claude Code and Codex. Recording is on by default and Router, Compact and Output write independent Jev metadata without `--debug`. The UI and `recording on|off|status` / `dashboard on|off|status` CLI commands control shared recording and automatic opening independently. The default directories are `$XDG_STATE_HOME/jev-gate/{claude,codex}/traces` or `~/.local/state/jev-gate/{claude,codex}/traces`. Explicit `JEV_GATE_TRACE_DIR`, `JEV_CODEX_TRACE_DIR` and optional Claude debug logs remain supported. `node dist/cli.js dashboard --port 4733` opens a manual development view; `--trace` and `--debug` override sources. Missing records mean unknown. Selected models, observed response models and observed effort are separate facts.

The page keeps concurrent runs separate and shows the decision path in time order: Gate A admission and context floor, planner and Gate B tier choice, task dependencies, worker dispatch and reported checks, root guard decisions, or the separate Lean packet path. Router separates selected pairs, submitted request values and reported response models; missing observed effort remains unknown; Compact shows the bounded Jev dependency judgment (actual dispatch, candidate coverage, selected dependencies, latency and observed usage), local digest packing and native installation or fallback separately; Output shows whether a Vitest log was folded; Evidence shows local search, Jev batches, cache reuse, and result coverage. Jev intent and result are separate. A sent request without a result becomes unconfirmed, and a missing usage counter stays unknown. Gate C is withdrawn and does not run in the current implementation. The page reads only named metadata, not prompts, source bodies, job state, credentials, or transcript text. It makes no Jev request and grants no tool permission. Existing v0.6.5 trace and debug records can appear where their fields suffice; events that version never wrote cannot be reconstructed.

## Checkout

Not required to install.

```sh
git clone https://github.com/MongLong0214/jev-gate.git
cd jev-gate
npm ci
npm run build
node dist/cli.js doctor
```

`npm run typecheck`, `npm test`, and `claude plugin validate . --strict` are the checks in [AGENTS.md](../AGENTS.md). Tests are offline. Do not put a key in the repository, an issue, or a chat log, and do not attach raw transcripts.

`npm run pack` writes `dist-pack/jev-gate-<version>.zip` for the integrated plugin. `--profile lean`, `--profile router`, and `--profile evidence` write the single-part archives used for development. The bench is not part of that. `npm run release:check` rebuilds the integrated archive and compares it with the pin; it fails on a released version whose bytes changed, which is the point of the check. Do not publish from a documentation edit.

Load the checkout with `claude --plugin-dir .` after the build. It performs the same automatic initialization as the installed archive; start a fresh host after a first-start notice.

## Recorded runs

The numbers in these files are the runs as published at v0.6.3 (`931e8367e8b8f27536e14da1ed41baed1f83e22e`). They are not rewritten to the live turn map. Unfavorable and withdrawn results stay. None of them is a general saving.

- [v0.6.3 README](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/README.md#results) — V3 pilot, V4 (the gate did not engage; forced delegation cost more on that sample), the stopped V5 cell (every task on one tier), and the withdrawn depth-ladder claim.
- [bench/results](https://github.com/MongLong0214/jev-gate/tree/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results) — the published aggregates. Raw transcripts are not in the repository.
- [V3 report](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/run-1-2026-09-17/report.md), [V4 run](https://github.com/MongLong0214/jev-gate/tree/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/v4-run-1-2026-09-18), [V4 forced delegation](https://github.com/MongLong0214/jev-gate/tree/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/v4-diag-delegate-1-2026-09-18), [partial V5 cell](https://github.com/MongLong0214/jev-gate/tree/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/v5-run-1-partial-2026-09-18).
- [Gate A calibration](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/gate-a-calibration-2026-09-18.json), [cost-model fit on the old map](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/v5-gate-a-cost-2026-09-28/RESULTS.md), [withdrawn depth ladder](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/v5-depth-ladder-2026-09-19/RESULTS-WORK-RERUN-2026-09-20.md).
- [Host notes, V5](https://github.com/MongLong0214/jev-gate/tree/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/v5-host-2026-09-18) and [V4](https://github.com/MongLong0214/jev-gate/tree/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/v4-host-2026-09-18).
- [Single versus hierarchy on two jobs](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/DECISION-admitted-shape-2026-09-19.md), [why atomic shipped](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/DECISION-defaults-2026-09-19.md), [single-first](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/DECISION-defaults-2026-09-28.md), [depth gate](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/DECISION-depth-gate-2026-09-19.md).
- [Lean scope probe](https://github.com/MongLong0214/jev-gate/tree/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/v5-lean-scope-probe-2026-09-25). The hierarchy failure that motivated `planInterpretation` is [v5-context-vs-decomposition-s1](https://github.com/MongLong0214/jev-gate/tree/931e8367e8b8f27536e14da1ed41baed1f83e22e/bench/results/v5-context-vs-decomposition-s1-2026-09-19).
- [HANDOFF.md](https://github.com/MongLong0214/jev-gate/blob/931e8367e8b8f27536e14da1ed41baed1f83e22e/HANDOFF.md) is a snapshot of remaining engineering notes at that commit, not a plan for this install.

Closed product issues are history. The list is in the [README](../README.md#older-work). The cancelled future-bench plan that used to sit under the V5 results is in that same v0.6.3 README section and is not revived here.
