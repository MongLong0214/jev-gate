# Changelog

## v0.6.2 — The evidence tool needs no setup

### Changed

- **`jev_evidence` works as soon as the plugin is installed.** Without `JEV_EVIDENCE_CONFIG`, the server searches the
  Git worktree holding the session's directory (`CLAUDE_PROJECT_DIR`, which Claude Code 2.1.284 sets for a plugin's
  MCP server; `PWD` otherwise), the whole worktree, with remote on: when `TYPESAFE_API_KEY` is present a semantic page
  is sent to Jev. Installing the plugin with a key is that opt-in; the built-in exclusions (credentials, `.env*`,
  dependency and build directories, symlinks, submodules, binaries) are unchanged. A session outside a Git worktree
  gets `unsupported_inventory`. `JEV_EVIDENCE_CONFIG` still decides when set, and an invalid one never falls back.
  Observed: a `--plugin-dir` session in this repository with no config logged `config ok, remote on, key present`
  and a semantic call answered with `backend: jev`.

### Upgrading

- To keep a project's source on the machine, point `JEV_EVIDENCE_CONFIG` at a config with `"remote": false`
  (`plugins/evidence/README.md#configure`).

## v0.6.1 — A check run with absolute paths counts

### Fixed

- **A worker's passing check is no longer refused because its paths were made absolute.** The gate accepts a planned
  task only when the worker's own transcript shows a passing run of each required check's command. Claude Code tells
  workers to prefer absolute paths, and in an end-to-end run on 2.1.283 a `worker-fast` (Haiku) ran the planned
  `! grep -q '…' tests/zz/spam.test.ts && grep -q '…' tests/zz/spam.test.ts` as the same command with
  `<cwd>/tests/zz/spam.test.ts`: the run passed, the gate found no run of the check and marked the task incomplete.
  The reader now reads an unquoted path under the run's own working directory (the transcript's `cwd` for that call)
  as the relative path, so both name the same file. A quoted one stays as written, since it may be a pattern
  (`! grep -q '<cwd>/a' f` passing says nothing of `'a'`); an unquoted pattern that looks like such a path is the known
  gap. Replayed on that transcript, both checks are observed and nothing refuses.

### Upgrading

- `claude plugin marketplace update jev-gate && claude plugin update jev-gate@jev-gate`, or wait for the
  marketplace's auto-update, then restart Claude Code (or `/reload-plugins`). Options carry over.

## v0.6.0 — One plugin: install once, update once

### Changed

- **The marketplace lists one plugin, `jev-gate`, and it carries every part.** Until v0.5.1 the gate, the compactor,
  the Router, the Vitest folder and the evidence tool were five plugins, installed, configured and updated one by one.
  `jev-gate-<version>.zip` now holds the gate's command hooks, the three Function Hooks Mods (from their source in
  `mods/`, loaded through one module, `hooks/register.ts`) and the evidence server and skill (`plugins/evidence/`).
  Each part is still off until enabled, and a part without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is still not loaded
  while the gate and the evidence tool run.
- **Options take the plugin's names.** A name two Mods shared, or one that would read as the gate's, carries the Mod's
  prefix: `compactEnabled`, `compactMode`, `compactBudgetChars`, `outputEnabled`, `routerEnabled`, `routerTimeoutMs`,
  `routerLogDecisions`, `routerMinUpgradeConfidence`, `routerMinDowngradeConfidence` and `router<Tier>Model`; the rest
  (`compactSubagents`, `compactManual`, `route*`, `typesafeApiKey`) keep theirs. A test holds `plugin.json` to each
  Mod's own options, types and defaults. An unusable option still turns only its Mod off, with the same debug line.
- **The evidence tool is `mcp__plugin_jev-gate_evidence__jev_evidence`**, and its skill `/jev-gate:evidence`.
- The release uploads, downloads back and checks every archive the marketplace pins, now one.

### Upgrading from v0.5.x

The four separate plugins are gone from the marketplace and will not update again. Uninstall them
(`claude plugin uninstall jev-gate-compact@jev-gate`, and likewise `jev-gate-router`, `jev-gate-output`,
`jev-gate-evidence`) before updating `jev-gate`, or their hooks run twice, and set their options again under the names
above. Each directory still loads alone with `--plugin-dir` under its old names, for development and the bench.

### Host facts behind the shape (Claude Code 2.1.283)

- A plugin loads one hooks module; a second `modules` entry fails the whole `hooks.json`, command hooks included.
- A module that registers one event twice fails to load, so the Mods' diagnostics for an unusable option (each on
  `session.start`) are written from one hook; their own hooks share no event.
- The validator reads every `on("<event>", hook)` call and every use of `$` statically, through imports.

### Observed (Claude Code 2.1.283, `claude -p --plugin-dir .`, no user settings, 2026-09-28)

- One session ran the gate's command hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, in mode `off`), loaded the
  combined module with the Router's and Output's events, connected the evidence server (`jev-evidence` 0.6.0) and loaded
  the skill as `jev-gate:evidence`. `compactMode: "fast"` wrote `jev-compact {…"field":"compactMode"}` and left the
  others on; `compactMode: "active"` registered `session.compact`. ToolSearch returned
  `mcp__plugin_jev-gate_evidence__jev_evidence`. Loading from the marketplace archive is observed only after release.

## v0.5.1 — The evidence tool installs from the marketplace, and a hand-set effort stays

### Changed

- **`jev-gate-evidence` is a marketplace entry (#77, v1.2).** Like `jev-gate`, it is the tagged release's archive pinned
  by SHA-256 (`jev-gate-evidence-0.5.1.zip`), so `/plugin install jev-gate-evidence@jev-gate` installs it; downloading
  the asset and loading it with `--plugin-dir` still works. `scripts/release.mjs` packs, pins and checks every archive
  entry with its own pack profile, freezes each one once its version is released (an archive entry added after a
  release has no pin there and is refused the same way), and takes `--asset` once per archive, matched by file name.
  The release job uploads both archives, downloads both back and checks them against their pins.
- **Router: a turn that arrives at another effort keeps it (#81, v1.2).** The host does not say who set a root turn's
  effort, and a change made in the session (`/effort`, the model picker) shows only as a turn arriving at another
  effort than the turn before. That turn now keeps its effort and asks Jev nothing about it
  (`"effort_kept":"incoming_changed"`); the next turn at the same effort is routed again. `CLAUDE_CODE_EFFORT_LEVEL`
  still pins it for good. Read from the declarations; not observed on an installed host.

### Dependencies

- `@modelcontextprotocol/sdk` 1.30.1 and `esbuild` 0.28.2 (devDependencies, fixed by `package-lock.json`), added in
  v0.5.0 for #77. The SDK is the official MCP implementation, used so the server writes no JSON-RPC of its own; esbuild
  bundles it into `plugins/evidence/dist/server.mjs`, so the installed plugin needs Node 22 and no `node_modules`. The
  bundle is byte-identical between macOS and the Linux release job (checked on v0.5.0's asset).

## v0.5.0 — One evidence tool, a Vitest log folder, and compact and router fixes

### Added

- **`jev-gate-evidence` (#75–#77).** One read-only MCP tool, `jev_evidence`, in `plugins/evidence`, shipped as its own
  archive (`jev-gate-evidence-0.5.0.zip` on the release, or `node scripts/pack.mjs <out> --profile evidence`) with the
  MCP SDK bundled into `dist/server.mjs`. It reads
  the one project `JEV_EVIDENCE_CONFIG` names, returns exact 40-line windows with their path, lines and file SHA-256,
  pages with a snapshot check, and reads a returned reference back exactly. With `remote: true` and a key, a semantic
  page goes to Jev (at most two requests of eight candidates, no retry, 1.5 s): relevant windows first, and a clearly
  unrelated `locate` window keeps its reference but not its text. Exact-symbol lookups, read-backs, `remote: false`
  and a missing key send nothing. A manual skill, `/jev-gate-evidence:evidence`, runs only when typed.
  Checked on Claude Code 2.1.283 with `--plugin-dir plugins/evidence`: the server connected, the tool was listed
  (deferred, found by ToolSearch) as `mcp__plugin_jev-gate-evidence_evidence__jev_evidence`, the skill as
  `jev-gate-evidence:evidence`, and an `exactSymbols` call returned its windows. With `remote: true` and a real key,
  a 16-candidate page took two Jev requests and 440 ms and folded four windows. The skill itself was not run on a host.
- **`jev-gate-output` (#80)** is in the marketplace: it folds runs of identical lines in a passing Vitest log the host
  persisted, off by default.

### Fixed

- **Compact (#79).** User-role text is kept beside tool results and quoted whole; the previous summary, user
  messages and failed or interrupted calls are mandatory and unclipped, and when they do not fit the engine compacts
  (`mandatory_overflow`). Failures get their own section.
- **Router (#81).** No override after a failed step (`step_failed`) or into a subagent's later run (`next_turn`); a
  spawn onto a model that takes no effort sends no Jev request.

## v0.4.0 — Gate A prices the request, both gates act, and a reported pass is checked

This release answers the owner's review of real use on 2026-09-28, point by point.

### Changed

- **Gate A prices each request instead of vetoing on its kind.** The `answer_only` veto is gone: it said nothing about
  cost, and it vetoed a 26-call analysis that would have cost 7.9M tokens direct and 3.24M delegated. The `size ≥ 1`
  floor is gone with it, since it let almost everything through. Jev now reads off roughly how many tool calls the
  request needs (`tool_calls`, a 0–4 score). Code maps that score to root turns (`TOOL_CALL_TURNS = [0, 10, 10, 10, 60]`)
  and delegates only when `(turns − 11) × depth − turns × 40,000 > 0`. Put simply: delegate when the turns saved,
  each of which would re-read the whole session, outweigh what the worker reads doing them. A turn that does not pay
  stays direct as `admission_not_worth`, and the trace records the price (`estimate`). Both constants are config
  keys (`delegationCoordinatorTurns`, `delegationWorkerTokensPerCall`).
- **The floor is derived, not a policy number.** With the atomic gate (the default) and `delegationDepthFloor: null`,
  the floor is the shallowest depth at which the largest answer could pay: 48,980 tokens (`source: cost_model`). The
  window-fraction floor (180K on a 300K window) applies only to the composite gate now. The measured points behind it
  are unchanged: +182% at 55K and −57% at 406K.
- **`admittedShape: auto` is the default.** An admitted turn runs as one worker carrying the request verbatim, with no
  planner, unless Gate A read the request as separate outcomes or a whole project; only then does the planner
  hierarchy run. The owner chose this on 2026-09-28, following `DECISION-admitted-shape-2026-09-19.md` (single passed
  6/6, hierarchy 4/6). The single-shape coordinator is told to dispatch before reading anything.
- **Gate B's answer is applied.** `routeQuestionShape` defaults to `atomic`. The composite answer never cleared its
  0.8 floor in real use (0.78, 0.35), so every dispatch kept the tier the coordinator called. The atomic shape
  composes fast, standard or deep in code, with no floor. It never picks frontier.
- **The Router leaves jev-gate dispatches alone.** A `jev-gate:` subagent, or a prompt carrying Gate B's route note,
  is skipped as `gate_routed`, so Gate B's model and effort are the ones that run.
- **MCP work can be delegated.** The root guard now allows `mcp__*` tools (`guardAllowMcp`, default on), and the
  coordinator is told to run any connector step itself and hand the worker the result. Gate A's `external_tools`
  veto applies only when `guardAllowMcp` is off.

### Added

- **Reported passes are checked against the worker's own transcript** (`verifyWorkerChecks`, default on). A worker's
  `accept` used to be accepted on its word. The hook now reads the worker's transcript (last 8 MiB) and compares each
  required check reported as passing with the last call of that check's command. A call counts only if it contains
  the command's own shell segments in order and nothing around them (`|| true`, `; …`, a leading `||`) can decide the
  exit status in their place. The task is `incomplete`, with the check named in the reason, when that last run failed
  (the host marked it `is_error`) or when the gate cannot see a passing run: none in the transcript, none in the last
  8 MiB of a longer one, no transcript at all, or a required check with no command. A single-shape worker that changed
  files and reports no passing check is `incomplete` too. A run before a later edit is recorded in `verification` and
  refuses nothing. The check is still
  weak: a command piped into `tail` exits with `tail`'s status. On the single shape, checks are named by position in
  traces, never by the command. `explain` prints the verification and Gate A's price.
- **Malformed Jev answers change nothing.** Gate A needs all six answers, each in the type its question asked for, or
  the turn stays direct (`admission_invalid`); Gate B reads a fact only as a `noul` answer. All 100 real Gate A answers
  in the calibration run met this. A transcript whose depth cannot be read keeps the turn direct even with
  `delegationDepthFloor: 0`.
- `bench/results/v5-gate-a-cost-2026-09-28/`: the pre-registered calibration and validation of the cost model on 100
  real prompts (numbers only).

### Measured, and the limits

- On 50 held-out prompts the gate admitted 8, with a precision of 0.625. The net saving under the model was +30.4M
  tokens against 885.1M native, which meets the pre-registered rule. The shipped default, which does not veto on
  `external_tools`, admitted 9 with a precision of 0.667 and a net saving of +66.4M; that comparison was not
  pre-registered.
- **Jev's read-off barely predicts the turns a request takes:** Spearman correlation 0.05–0.08. As a result the gate
  recovers 5–11% of the saving the model says is available. Admitting everything at depth would save 513.6M under the
  model, but that figure prices only tokens, not the quality of a worker that does not see the conversation. It is
  not taken here: it needs a quality guard and a paid measurement.
- The oracle is the cost model itself (`C` and `d` are declared, not fitted), so this checks which prompts the gate
  picks, not whether delegation pays. No paid end-to-end run backs 0.4.0.

## v0.3.1 — the release archive ships lean's executor

- The `jev-gate` archive now includes `agents/executor.md`. v0.3.0 shipped only the six routing roles, so
  `node dist/cli.js doctor` failed on the installed plugin (`agents/executor.md missing`), and `mode: lean` would have
  dispatched an agent that was not installed. The default hook set runs every mode, so the default archive carries
  every agent doctor checks. `tests/pack.test.ts` now runs doctor on the packed archive and requires no failure.
- `jev-gate-compact` and `jev-gate-router` are unchanged apart from the version, which the three plugins share.

## v0.3.0 — a plugin marketplace, the compactor and the Router

Install from the repository's own marketplace instead of a local checkout:

```text
/plugin marketplace add MongLong0214/jev-gate
/plugin install jev-gate-compact@jev-gate
```

Every plugin here is off until you enable it. `jev-gate-compact` and `jev-gate-router` are Function Hooks plugins and
also need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment Claude Code starts in.

### Added

- **Marketplace** (`.claude-plugin/marketplace.json`): three plugins. The two Function Hooks plugins ship from their
  source directories; `jev-gate` ships as this release's archive, pinned by SHA-256. `npm run release:check` rebuilds
  the archive and fails unless it matches the pin (`scripts/release.mjs`), and `scripts/pack.mjs` now writes the same
  bytes for the same tree.
- **`jev-gate-compact`** (#59, #60): answers the host's auto compaction with an extractive digest of the earlier
  conversation and the recent tail. No summarizer request is sent, so a compaction takes milliseconds (2–7 ms
  observed) instead of the engine's minute or more (a 95-second median over the owner's week of sessions). It calls no
  Jev: Jev was tried for ranking what to keep and for deciding when to fall back, and neither beat recency. Keep
  `compactManual` off (host defect, see its README).
- **`jev-gate-router`** (#47, #49, #63): chooses the effort of the main thread and of subagents, and the model of a
  subagent (an inheriting built-in, or one whose Agent call names a model), from one TypeSafe Jev assessment each; any
  doubt, timeout or unverified host leaves the request native. The main thread's model is not routed.
- **Lean mode** (#37): one request, one selected packet, one fresh executor. Implemented, not measured.

### Changed

- The orchestration gate derives its depth floor from the host's compaction window (#52) and stays native where Agent
  calls can only run in the background (#57); one model table with an opus frontier default (#53).
- Jev probability sums off by Jev's two-decimal rounding are accepted (#62).

### What is and is not established

- Compaction speed is measured on the installed host. The token effect comes from compacting earlier with no
  summarizer cost: replayed over the owner's sessions, a 200K compaction window with the compactor used 18.6–26.6%
  fewer tokens than the host's 300K window, and the host alone at 200K 12.5% fewer. That is a simulation, not a
  measured A/B.
- No saving from the Router or the orchestration gate is established: the Router comparison (#61) stopped at 16 of 45
  cells and was not adjudicated.

## v0.2.0 — Jev-directed orchestration (V5)

See the [release](https://github.com/MongLong0214/jev-gate/releases/tag/v0.2.0).

## v0.1.0 — Claude Code hook MVP

See the [release](https://github.com/MongLong0214/jev-gate/releases/tag/v0.1.0).
