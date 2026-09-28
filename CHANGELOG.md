# Changelog

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
