# The gate orchestrates. The blocker was the depth floor. (2026-09-21)

One live session, grown honestly past `delegationDepthFloor`, then given a compound request. This answers the
question `v5-depth-census-2026-09-20` left open: *"Whether Gate A, given a key and a turn above the floor,
orchestrates anything. No run in this census had both."*

**It orchestrates.** Gate A returned `orchestrated`, `decided: true`, `changed_default: true`, and the turn ran a
planner and two workers to `accept` / `completed`.

## Conditions

Host: Claude Code **2.1.278**, macOS 26.2 (Darwin 25.2.0), node v24.18.0, subscription login. Plugin built from the
committed tree at `cd50020` in a detached worktree; the main checkout was never built from and never edited. Launch
profile copied from `src/bench/run.ts` `runClaudeCell`, with the primed-case variant (stream-json input,
`--replay-user-messages`, **no** `--no-session-persistence`, because the depth gate reads the on-disk transcript):

```
claude -p --model sonnet[1m] --input-format stream-json --output-format stream-json --verbose
  --max-turns 150 --permission-mode acceptEdits
  --allowedTools 'Bash(node *),Bash(npm test),Bash(npm run test),Bash(ls *)'
  --setting-sources project,local --replay-user-messages --plugin-dir <worktree>
```

Environment: 22 inherited `CLAUDE*` / `JEV_GATE_*` variables stripped, then
`CLAUDE_CODE_FORK_SUBAGENT=0 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 JEV_GATE_MODE=auto` plus fresh
`JEV_GATE_TRACE_DIR` / `JEV_GATE_STATE_DIR`, and `TYPESAFE_API_KEY` read from `~/.config/jev-gate/typesafe.key`
straight into the child environment — never echoed, never written, never on a command line. No
`~/.config/jev-gate/config.json` exists, so `DEFAULT_CONFIG` applied and `delegationDepthFloor` was 300,000.

Work happened in a disposable project outside the repository (`~/jev-gate-runs/v5-live-admission-1/work`) holding a
copy of a real codebase under `vendor/` for the session to read. Two deviations from the bench profile, both
deliberate and both recorded: `--model sonnet[1m]` rather than `sonnet`, because a 200K-context root cannot hold a
300,000-token turn at all; and `--max-turns 150` rather than 60, to leave room for priming plus orchestration.

## Two stages, one session

| turn | what it was | measured depth at `UserPromptSubmit` | Gate A |
|---|---|---|---|
| 1 | priming: read 7 large vendored files | **`depth_unknown`**, 0 bytes read | `direct`, `reason: depth_unknown`, no request sent |
| 2 | priming: read 10 more | **211,957** | `direct`, `reason: depth_below_floor`, no request sent |
| 3 | **the compound request** | **448,908** | **`orchestrated`** |

Depth was read between turns by the plugin's own `readSessionDepth` against the live `transcript_path`; the numbers
above are the hook's own, from its `admission_result` records.

Turn 1 is a fact worth keeping: on the first prompt of a session the transcript does not exist yet, so the read
returns 0 bytes and the branch is `depth_unknown`, not `key_missing`. **A fresh session is always direct on its first
prompt, whatever else is true.**

## The compound turn, end to end

| step | evidence |
|---|---|
| admission request actually sent | one `admission_intent`, one `admission_result`, `attempted: true`, request 2,134 bytes |
| HTTP | **200 in 703 ms**, `jev-1.13.0`, 722 in / 91 out |
| Jev's answer | `size` score **2.94** (p(3)=0.94, confidence **0.95**); `forbids_delegation` 0.12, `answer_only` 0.04, `plan_only` 0.05, `parallel_outcomes` 0.84 |
| applied decision | `shape: orchestrated`, `decided: true`, `reason: null`, **`changed_default: true`**; recommendation `hierarchy` recorded, `applied: false` |
| owned dispatch | **3 owned `Agent` calls**: `jev-gate:planner`, then `jev-gate:worker` ×2. All root-level (`parent: null`), all with `subagent_type/description/prompt` only |
| Gate B (planner tier) | 200 in 576 ms, `planning_tier: deep` p=1.00 confidence 1.00 → `patch` to `opus`; observed `claude-opus-5[1m]`, agreement **match** |
| plan | `outcome: ready`, rev 1, **2 tasks**, chain depth 2 (`t2 depends_on t1`), 2 and 4 required checks |
| Gate B (worker route) t1 | 200 in 698 ms, `route: fast` **confidence 0.43** → **`preserve`** at `standard`, `reason: route_low_confidence` |
| Gate B (worker route) t2 | 200 in 598 ms, `route: standard` **confidence 0.62**, `upgrade_basis: unresolved_contract_reasoning` confidence 0.39 → **`preserve`**, same reason |
| receipts | `t1` **accept**, `t2` **accept**, both attempt 1, `advisory: null` |
| guard | **0 guard records, 0 denials** — during the orchestrated turn the root called nothing but `Agent`, so the guard was never exercised |
| `Stop` | **`completed`** |
| product | 7 real files written under `toolkit/` (`types.ts` + slug/retry/ledger with a `node:test` file each) |

## Which of the four blockers fired

**The depth floor fired, and only the depth floor.** In this session the key was present and used, the profile was
the verified foreground one, and Gate A did *not* answer `direct` — it answered `orchestrated` the moment the turn
was above 300,000.

| candidate | status after this run |
|---|---|
| missing TypeSafe key | **ruled out as a necessary blocker**: four HTTP 200s with the key exported this way |
| session not foreground | **ruled out**: `CLAUDE_CODE_FORK_SUBAGENT=0`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `run_in_background` absent, dispatch eligible |
| Gate A answering `direct` | **ruled out as unconditional**: on a real compound request above the floor it answers `orchestrated` with confidence 0.95 |
| `config.delegationDepthFloor` = 300,000 | **this is what fired** — twice, as `depth_unknown` then `depth_below_floor`, before Jev was asked at all |

Two limits on that, stated plainly:

1. This rules the other three out **as blockers in this session**. It does not explain the 45,309 fleet turns that
   were above the floor with 0 orchestrated generations (`v5-depth-census-2026-09-20`). Those sessions are a
   different population; `fleet-gate-status` attributes the ones running at the time to `key_missing`, which is
   tested *before* the depth read and would mask the floor entirely. That remains untested here.
2. One session, one prompt, one shape. Gate A answering `orchestrated` once is not a rate.

## Also observed

- **`root_effort` is no longer null.** `v5-host-2026-09-18` recorded the host sending `effort` as an object that
  `parseInput` dropped. Both `post` records here carry `root_effort: "high"`, so on 2.1.278 with this build the value
  survives. Not investigated further.
- **Workers resolved to `claude-sonnet-5[1m]`**, i.e. the `[1m]` variant, for a `standard`-tier call issued from a
  `[1m]` root. Whether the root's context variant propagates to owned children is not established by one run.
- **Gate B preserved on both workers** for the same reason (`route_low_confidence`), so the tier was never actually
  moved by Jev on this turn — only the planner tier was patched. Neither worker route cleared the confidence floor.
- **A 200K-context root cannot reach the operating region.** The floor is 300,000 by a definition that sums
  `cache_read + cache_creation + input`; a 200K window cannot produce that number. Any measurement of this gate needs
  a `[1m]` root.

## Cost

| session | purpose | cost USD | wall |
|---|---|---|---|
| preflight | model/plugin check, shallow session | 0.0763 | 1.4 s |
| main turn 1 | priming to 211,957 | 0.7822 | 20 s |
| main turn 2 | priming to 448,908 | 1.8396 (cumulative) | 31 s |
| main turn 3 | **the compound orchestrated turn** | 3.3833 (cumulative) | 285 s |

**Total $3.46** in model spend, plus four TypeSafe calls (admission 722/91, planner tier 643/46, worker routes
2515/116 and 3662/121; 576–703 ms each). About 6 minutes of model time.

## Raw logs and what is withheld

Raw streams, driver records, traces and job state: `~/jev-gate-runs/v5-live-admission-1/` (outside the repository).
`evidence.json` here carries whitelisted trace fields, prompt lengths and sha256 only, decisions, models, costs and
the CLI flags. No prompt body, no plan text, no request text, no key, no account identifier.
