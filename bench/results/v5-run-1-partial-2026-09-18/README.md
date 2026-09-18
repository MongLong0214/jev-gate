# V5 whole-job comparison — partial run, one cell

**Stopped before any comparison arm ran.** This directory holds the single completed cell so the observation is not lost.
It contains **no cost, runtime or quality comparison**, and none may be derived from it.

## What was run

```sh
node dist/bench/run.js --cases bench/v5/cases.mini-sql.json --out ~/jev-gate-runs/v5-run-1 \
  --execute --max-sessions 4 \
  --arms orchestrated_control,jev_forced_orchestration,frontier_native,sonnet_native \
  --plugin-dir /Users/isaac/jev-gate --timeout-ms 900000 --max-turns 45 --seed 20260918
```

Host: Claude Code 2.1.276, macOS, Claude.ai subscription, headless, sequential. Job: `mini-sql` (an in-memory SQL query
engine: lexer, parser, analyzer, executor with hash join and aggregates, index selection, formatter). Arm:
`jev_forced_orchestration` — Sonnet main, plugin in `auto`, `JEV_GATE_EXPERIMENT_ADMISSION=orchestrated`, so Gate A is
skipped and recorded as forced — **no real Gate A judgment ran in this cell** — while Gate B and Gate C (as they existed
at the time of this run) made real Jev calls. The run was stopped during this cell for budget reasons; the remaining
three arms never executed.

## Gate decisions (`gate-decisions.json`)

| # | Dispatch | Called profile | Jev route | Confidence | Upgrade basis | Applied |
|---|---|---|---|---:|---|---|
| 1 | planner | — | — | — | — | patch → deep |
| 2 | worker `t1` errors | standard | standard | 0.96 | `no_specific_basis` | patch → standard |
| 3 | worker `t2` formatter | standard | standard | 0.41 | `no_specific_basis` | preserve (below floor) |
| 4 | worker `t2` attempt 2 | standard | standard | 0.38 | `no_specific_basis` | preserve (below floor) |
| 5 | worker `t3` parser | standard | standard | 0.94 | `no_specific_basis` | patch → standard |
| 6 | worker `t4` analyzer | standard | standard | 0.99 | `no_specific_basis` | patch → standard |

Worker dispatches: five (`t1`, `t2`, `t2` attempt 2, `t3`, `t4`). Four have a published completed result below;
`t4`/analyzer's dispatch has none in this directory.

Gate C produced three advisory verdicts, all `accept`; these are `worker_reported` and are not independent proof the
code works.

## Receipts

| Task | Verdict | Model observed | Duration | Tokens |
|---|---|---|---:|---:|
| t1 | accept | `claude-sonnet-5` | 86.0 s | 33,356 |
| t2 | **invalid** | `claude-sonnet-5` | 84.1 s | 31,553 |
| t2 (attempt 2) | accept | `claude-sonnet-5` | 29.3 s | 25,925 |
| t3 | accept | `claude-sonnet-5` | 239.6 s | 54,175 |

`t2`'s `invalid` verdict was a report-format failure — `check_id` didn't match the required pattern — not a
demonstrated implementation bug; whether the first attempt's implementation was actually correct is unknown. These
durations and token counts are per dispatch, not whole-job time or cost; child token counts include cache-related
entries and must not be read as output tokens or priced at one rate.

## What this shows

Working: forced-admission state (no real Gate A judgment ran), a strong planner returning a multi-task plan,
marker-validated dispatch, the canonical contract reaching workers, code-owned acceptance rejecting one reply as
invalid, the coordinator reworking it as `attempt=2`, and advisory result judgments — all on a real job on a real host.

Not working as hoped: **every task routed to the same tier**. Nothing went down to `fast` and nothing went up. In the
shipped policy `upgrade_basis` gates only `deep` and `frontier`, so `no_specific_basis` on all five worker calls does
not explain why nothing went down to `fast` — the policy never required a basis to reach it. Why everything landed on
`standard` has two explanations this cell cannot separate: the strong planner may already have resolved the design
decisions that made `standard` appropriate, or the router may have been missing information it needed. The one input
gap this run actually confirms: the formatter task's own previous `invalid` verdict was not carried into its
`attempt=2` dispatch. Two dispatches fell below the confidence floor and preserved the default.

Dispatch was serial, so the four worker durations add up rather than overlap; the parallel path remains unexercised.

## What this does not show

No arm comparison, no cost or time claim, no quality claim, one job, one repetition, one cell.
