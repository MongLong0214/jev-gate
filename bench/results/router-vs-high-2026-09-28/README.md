**The run stopped at 16 of 45 cells under rule 7, and no pair is adjudicated: no claim in the pre-registration is
supported or refuted by it.** The stop came from a Jev server error. One Router request was answered after 22.9 s
with HTTP 520 and no usage, long after the Router's 800 ms wait had ended. A row whose cost is unknown stops the run.
Of six Router assessments, one lowered the effort. Another logged no validated effort value (`answer_invalid`). Its
raw reply was not saved, so whether the effort answer was missing or rejected is not recorded. One possible cause, seen
when replaying the request, is a validator defect fixed in #62: it rejected correct answers whose two-decimal
probabilities sum to 0.99. Such an answer would have lowered the effort.

# Router vs native `xhigh` vs fixed `high`, 2026-09-28 — results

Preregistered in [`PREREGISTRATION.md`](PREREGISTRATION.md) before any cell ran. **Development data:** five small,
familiar fixtures; a paired, per-task difference on these tasks, not a claim about the owner's own work. **This run
changes no default** (rule 10): the Router is not enabled on the owner's host, and the host's effort is unchanged.

## Build, spend, approval

| | |
|---|---|
| commit (rule 11) | `3d952d85b5e4f2047a99fcc0f0a59bd191652597` |
| `frozen_inputs.router_sha256` | `08873861bdc97e013988037a5991e1afb44a777c0fe9deb0dbb4e71e88ce3b27`, the same Router as 2026-09-27 |
| `config_sha256` / `bench_sha256` | `0de543f8…b4b7be` / `4d11a1b0…5a2f2d` |
| host | Claude Code 2.1.283, `--frontier-model opus`, seed `20260928`, auto-compact on |
| cells | 45 planned, 16 completed, 0 timed out, 0 cancelled, 29 not started |
| spend | **$3.98** of Claude cost known; Router Jev $0.000202 known plus **one request of unknown cost** |
| approval | the owner's, as recorded in the pre-registration; it does not cover a second attempt, so none is made |

Raw data (stream JSON, Router debug logs, each cell's repository, `reports/report-1.md/json`) is in
`~/jev-gate-runs/router-vs-high-2026-09-28/`. [`cells.tsv`](cells.tsv) is one line per completed cell, extracted from
it; `total_cost_usd` is Claude's cost plus, for `router`, the Router's Jev cost, and reads `unknown` when that is.

## Why it stopped

The runner's seeded order reached `quote-pricing` rep 3. In its `router` cell the Router sent its one assessment at
the root's first step and stopped waiting after its default `timeoutMs` of 800 ms, so the step ran at the baseline
`xhigh` (`assessment: "timeout"`). The host's HTTP takes no abort signal, so the request itself ran on. The host's
fetch log shows how it ended: `520 in 22853ms, 7342 chars`, Cloudflare's code for an error at the origin server, so
the late event carried `usage: null`. Whether the provider billed it is not known. The other 15 Router requests across
both runs returned 200 in 226–279 ms. The cell is otherwise valid (exit 0, checker pass, Claude cost $0.2056 known).

Before the next cell the runner summed the complete cost of every row, met one it could not complete, and stopped:
`stop: the complete cost of cells/quote-pricing/router/3 is unknown, so --max-cost-usd 29 cannot be checked; no
further cell starts`. That is rule 7 as written ("A row whose cost is unknown stops the run too"), and rule 7 says a
stop never turns into a cheaper result, so this README reports the 16 cells as they are rather than resuming the
other 29 under a rule relaxed after the fact.

## Rules as applied

| rule | outcome |
|---|---|
| 1 validity | 16/16 completed cells valid |
| 2 quality gates cost | every completed cell passed its checker; `quote-pricing` has only 2 of 3 cells for `router_native` and `router_fixed` |
| 3 unknown is not zero | `quote-pricing` `router` rep 3 has unknown cost, so no pair that includes `router` is reportable on `quote-pricing` |
| 4 three cases | **no pair adjudicated**: the most any pair has is `search-race`, complete for all three arms, plus a partial `quote-pricing` |
| 5 15 % line | not reached: nothing is quoted |
| 7 spend stop | fired on an unknown row, as above |
| 9 negative result | no pair is adjudicated, so there is no result either way |
| 10 no default | nothing enabled or changed on the host |
| 11 frozen build | as recorded above |

## What was measured (per cell, no comparison)

Claude's cost, and for `router` the Jev cost added, in dollars. Every cell passed its checker.

| case | `router_native` | `router` | `router_fixed` (`high`) |
|---|---|---|---|
| `search-race` | 0.244, 0.302, 0.326 | 0.320, 0.272, 0.345 | 0.303, 0.252, 0.244 |
| `quote-pricing` | 0.220, 0.193, not started | 0.216, 0.179, unknown | 0.183, 0.177, not started |
| `status-count`, `ttl-cache`, `wide-validators` | not started | not started | not started |

Output tokens per cell, the part of cost that effort moves, are in `cells.tsv` beside cache reads and creation.

## What the Router decided

One Jev assessment per session, at the root's first step, as in 2026-09-27. A move down from `xhigh` needs the
answer's mass at or below the target to reach `minDowngradeConfidence` 0.9 and the `task_clear` control the same.

| case | rep | effort answer | task_clear | patch | reason | steps at `medium` |
|---|---|---|---|---|---|---|
| `search-race` | 1, 2, 3 | `[0, .73, .27]`, `[0, .70, .30]`, `[0, .69, .31]` | .97, .98, .97 | none | `low_confidence` | 0 |
| `quote-pricing` | 1 | no validated value logged (below) | .94 | none | `answer_invalid` | 0 |
| `quote-pricing` | 2 | `[.06, .93, .01]` | .95 | `medium` | `applied` | 6 |
| `quote-pricing` | 3 | no answer (HTTP 520 after 22.9 s) | — | none | `timeout` | 0 |

The Router lowered the effort in **1 of 6** sessions. In the other five the session ran at the baseline `xhigh` with
one Jev request added. The `search-race` answers repeat 2026-09-27's almost exactly. In `quote-pricing`, 2026-09-27
applied `medium` in both reps from answers like rep 2's. Here, rep 1 logged no validated effort value and rep 3's
answer never came. No spawn was assessed (`spawn_assessed` 0), so subagent-model routing is untested here as
there.

## Observations this run did not register

These are not claims under the pre-registration. They are written down so the next design can use them.

- **`answer_invalid` in `quote-pricing` rep 1 may have come from a Router defect.** The Router's validators rejected any answer whose probabilities summed more than 1e-3 away from 1. Jev rounds each probability to two
  decimals, so a correct answer can sum to 0.99 or 1.01. The raw reply was not logged. Replaying the same root request
  40 times through the shipped question builder (`~/jev-gate-runs/router-replay-2026-09-28/`) returned HTTP 200 every
  time, median 207 ms. Three of the 40 effort answers were `[0.05, 0.93, 0.01]`, which the Router marks
  `answer_invalid`. They were the only invalid answers in the replay. That makes the defect a possible cause for
  rep 1, not a recorded one: the Router logs `answer_invalid` both when the effort answer is missing and when the
  validator rejects it. With rep 1's task_clear of 0.94, such an answer lowers `xhigh` to `medium`. #62 fixes the validators; with
  the fix, all 40 replies validate. The main gate's `validateChoice` had the same tolerance and is fixed there too.
- **The Router's 800 ms wait is not a bound on its cost.** A request that outlives the wait still runs and may bill.
  A late event without usage leaves the session's complete cost unknown. A longer `timeoutMs` would not have kept this
  run going: this reply was a server error with no usage at any wait. To finish 45 cells, a design needs usage
  accounting for a failed reply or a pre-registered bound on an unknown request's cost rather than a longer wait,
  and either is a new pre-registration.
- One server error in 16 Router requests across both runs. That is too few to call it a rate.
- Across both runs the Router has now lowered the effort in 5 of 16 sessions, all on `quote-pricing` and
  `wide-validators`, and never on `search-race`, `status-count` or `ttl-cache`. Had rep 1's reply been one of the
  rounded answers, it would have been 6; rep 1's raw answer is not on record, so that stays a possibility.

## Standing of the question

2026-09-27 adjudicated the Router pair on four cases and found no saving above 15 %. This run was to test whether that
null is stable and whether a fixed `high` saves, and it answers neither. The Router remains not enabled on the host.
