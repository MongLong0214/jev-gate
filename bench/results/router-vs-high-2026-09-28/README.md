**The run stopped at 16 of 45 cells under rule 7, and no pair is adjudicated: no claim in the pre-registration is
supported or refuted by it.** The stop came from the Router itself: one of its Jev requests outlived the Router's
800 ms wait, its usage never arrived, and a row whose cost is unknown stops the run. Of six Router assessments, one
lowered the effort; two produced no usable answer.

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
`xhigh` (`assessment: "timeout"`). The host's HTTP takes no abort signal, so the request itself ran on. Its late
event arrived 23 s after it was sent, with `usage: null`. The provider may have billed it, and the Router cannot say
for how much. The cell is otherwise valid (exit 0, checker pass, Claude cost $0.2056 known).

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
| `quote-pricing` | 1 | none returned | .94 | none | `answer_invalid` | 0 |
| `quote-pricing` | 2 | `[.06, .93, .01]` | .95 | `medium` | `applied` | 6 |
| `quote-pricing` | 3 | no answer | — | none | `timeout` | 0 |

The Router lowered the effort in **1 of 6** sessions. In the other five the session ran at the baseline `xhigh` with
one Jev request added. The `search-race` answers repeat 2026-09-27's almost exactly. In `quote-pricing`, 2026-09-27
applied `medium` in both reps from answers like rep 2's. Here, one rep's answer carried no effort field and another
never arrived in time. No spawn was assessed (`spawn_assessed` 0), so subagent-model routing is untested here as
there.

## Observations this run did not register

These are not claims under the pre-registration. They are written down so the next design can use them.

- **The Router's 800 ms wait is not a bound on its cost.** A request that outlives the wait still runs and may bill,
  and a late event without usage leaves the session's complete cost unknown. Any run that holds rule 3 and rule 7 as
  written can stop on the Router's own timeout. A design that wants 45 cells needs either a longer `timeoutMs` in the
  frozen config or a spend stop that bounds an unknown Jev request, and either one is a new pre-registration.
- **Two of six Jev assessments returned nothing usable** (`answer_invalid`, `timeout`); 2026-09-27 had none in ten.
  Six is too few to call that a rate.
- Across both runs the Router has now lowered the effort in 5 of 16 sessions, all on `quote-pricing` and
  `wide-validators`, and never on `search-race`, `status-count` or `ttl-cache`.

## Standing of the question

2026-09-27 adjudicated the Router pair on four cases and found no saving above 15 %. This run was to test whether that
null is stable and whether a fixed `high` saves, and it answers neither. The Router remains not enabled on the host.
