# Preregistration — installed-host observation of the Router and Lean, 2026-09-27

Written and committed before any paid session. Owner-authorised budget: about **$10** in total for #36, #42, #43 and
#44B. This is an observation of mechanism. Pairs below are n = 1; no saving is claimed from them.

## Why this host

The owner runs Claude Code **2.1.283** with `model: opus`, `effortLevel: xhigh`. The Router pins
`VERIFIED_HOST = '2.1.282'`, so on the owner's real host every spawn is `host_unverified` and no subagent is ever
routed. The 2.1.283 declarations (`/plugin-types`, $0) differ from the 2.1.282 copy only in UI and turn-cost comments;
`agent.spawn`, `agent.offer` and `turn.step` are identical. The observation copy of the Router therefore sets
`VERIFIED_HOST = '2.1.283'`; that edit is local to the run directory and is not a repository change.

## Conditions (every session)

- Binary `~/.local/share/claude/versions/2.1.283`, `-p`, `--model opus --effort xhigh`, `--setting-sources project,local`
  (user settings and the installed jev-gate plugin are not loaded), `--permission-mode acceptEdits`,
  `--debug-file <cell>/debug.log`, clean env (`env -i` + HOME/USER/PATH/TERM/TYPESAFE_API_KEY),
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, `CLAUDE_CODE_FORK_SUBAGENT=0`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
- Every session loads an observation probe (Function Hooks, forwards everything unchanged) that logs `agent.spawn`
  input/result (type, requested/resolved model, permission mode, prompt bytes and FNV hash, Lean marker/header present)
  and every `turn.step` (agentId, model, effort, usage, duration).
- Router arm: `--plugin-dir router`, options via `--settings` `pluginConfigs["jev-gate-router@inline"]`:
  `enabled, routeSubagentModel, routeMainEffort` true, `routeMainModel` false, defaults otherwise (800 ms wait).
- Lean arm: packed `jev-gate-lean-0.2.0` from dev `6bd5a19`, `JEV_GATE_MODE=lean`, key present.
- A fresh copy of a 4-file fixture repository per session. Raw data stays in `~/jev-gate-runs/host-obs-2026-09-27/`.

## Sessions

| id | arm | task | answers |
|---|---|---|---|
| S1 | router | Explore: find where `parseConfig` is defined | #43 spawn: requested vs resolved, permissions unchanged; #42 root effort at index 0 |
| S2 | probe only | same as S1 | native baseline for S1 (resolved model, tokens) |
| S3 | router | general-purpose: add a test for `add`, run `npm test` | #43 on a writing task; #42 |
| S4 | probe only | same as S3 | native baseline for S3 |
| S5 | lean + router | turn 1 reads the repo; turn 2 asks for a change, root told to follow a Jev recommendation | #44B: does `agent.spawn` see the expanded packet or the marker; #36: executor model/effort, Grep/Glob actually used, Jev-selected packet with key |

## Stop rules

- Stop when cumulative `total_cost_usd` reaches $9, or on any session over $2.5 (`--max-budget-usd 2.5`).
- A session that fails for a harness reason is fixed and rerun once; the failed one is kept and counted.
- #36 items not reached (compaction/interruption ordering, unsupported-capability fallback) are reported as not
  observed, not inferred.

## What counts

Only fields the host reported: probe `step.model/effort/usage`, `spawn_out.model`, Router `root_result` /
`spawn_result`. A Router log line that says it applied a patch is not proof the host ran it; the probe's next
`turn.step` for that agent is.
