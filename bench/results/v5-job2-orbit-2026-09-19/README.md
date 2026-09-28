# The second job — orbit-core at depth, 2026-09-19

Every cost figure in this repository came from one job, `wide-validators`. This is the first run of a second one.
Pre-registration: `PREREGISTRATION.md`, committed before the run at `000f28c`.

**The saving did not transfer, and the run cannot say by how much, because the orchestrated arm did not reliably
finish the job.** One of its two cells produced nothing at all.

Case `orbit-core-primed-30`, arms `sonnet_native` and `jev_hierarchy`, two repetitions, shipped defaults, nothing
forced. All four cells are valid: depth 387,637–388,391 against the 250,000 validity floor, no truncation, no
environment error.

## The four cells

| arm | rep | depth | job turn | session | wall | turns | agents | checker |
|---|---|---|---|---|---|---|---|---|
| `sonnet_native` | 1 | 387,700 | $2.5642 | $5.4094 | 494 s | 24 | — | **pass** 16/16 |
| `sonnet_native` | 2 | 387,637 | $2.7411 | $5.5850 | 594 s | 24 | — | **pass** 16/16 |
| `jev_hierarchy` | 1 | 388,391 | $3.5165 | $6.3649 | 834 s | 26 | 5 planner, **0 workers** | **fail** 0/16 |
| `jev_hierarchy` | 2 | 388,294 | $3.6644 | $6.5110 | 982 s | 28 | 1 planner + 5 workers | **pass** 16/16 |

The runner's own declared-criteria verdict: **`pass_not_below` not met** — pass 1 is below 2, Δ success −50.0 points —
and the run as a whole is **"mechanism only"**: the gates ran and were recorded, and no declared criterion was met.

## The primary outcome: no cost comparison is reported

Pre-registration rule 3 gates cost on quality: *a cost claim requires all four cells to pass the checker; if the arms
differ in pass count, that difference is the result.* The arms differ 2/2 against 1/2, so **rule 4's holds / does not
hold category is not reported, and no percentage from this run may be quoted.**

The job-turn dollars are recorded above under rule 8 and are **not** a comparison. Answering the cost question on this
job needs a new pre-registration and more repetitions, not a reinterpretation of these cells.

## What this run did establish

**Gate A was correct in both jev cells, on all three prompts, exactly as on `wide-validators`:**

| prompt | depth | request sent | decision |
|---|---|---|---|
| priming (read the thirty notes) | — | **no** | `depth_unknown` → direct |
| confirmation ("just say ready") | 387,947 / — | yes | `admission_answer_only` → direct |
| **the job** | 388,391 / 388,294 | yes | **`orchestrated`, decided: true, no reason** |

Entry judgement is not what failed here. Neither is the guard: all 18 of its records in the failing cell are `Read`
with `allow: true`, and it denied nothing.

**A failure mode `wide-validators` never exposed.** In `jev_hierarchy` r1 the coordinator spent the whole job turn
trying to get a plan past validation:

```
jev-gate:planner   Plan orbit-core 7-module implementation
jev-gate:planner   Fix plan validation error
jev-gate:planner   Correct plan scope regression
jev-gate:planner   Fix plan validation error again
jev-gate:planner   Correct API drift in accepted plan
```

Two planner replies were invalid, one replan failed. A 4-task plan (`t1`–`t4`) was finally accepted — the state file
ends at `phase: "planned"` with `active: 0` — and then the turn ended `incomplete` without dispatching one worker. The
working tree was byte-identical to the fixture: `collisions.js`, `snapshot.js` and `simulation.js` were never written,
and no test was added. 26 turns of a 120-turn budget, so nothing was truncated.

**The failure is not cheap.** It cost $3.5165 against the succeeding cell's $3.6644 — 96 % of the price for none of the
work. Within-arm job-turn spread is 4.2 % for `jev_hierarchy` and 6.9 % for `sonnet_native`, so cost alone cannot tell
the two jev cells apart; only the checker can.

**Variance on this job is all-or-nothing, not marginal.** Same job, same depth, same config, two repetitions: one cell
dispatched zero workers and shipped nothing, the other dispatched five and passed every check. On `wide-validators`
plans always validated, which is why five earlier runs never saw this.

## What it does not settle

- **Whether the saving holds on this job.** Unmeasured, by rule 3. Not "absent" — unmeasured.
- **Why the planner failed.** One observation. Whether it is the module count, the 4,676-character spec, the
  contract-composition rules or a draw from planner variance is not separated here.
- **Whether the rate is 1 in 2.** Two cells give a rate of one failure; the confidence interval on that is useless.
  It is a failure mode that occurs, at an unknown rate.
- Nothing here bears on `mini-sql`, the third job, which is a narrower and more serial shape again.

## The control that makes this a finding about the product, not the fixture

The request text is byte-identical to `bench/v5/cases.orbit-core.json`, the priming is byte-identical to
`wide-validators-primed-30`, and `tests/bench-v5-orbit-core.test.ts` asserts both equalities. `sonnet_native` received
that same request at that same depth and produced all seven modules with eight new test files, twice. The orchestrated
path is the only thing that differed.
