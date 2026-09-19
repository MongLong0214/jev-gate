# Pre-registration — is the saving the fresh context or the decomposition? (2026-09-19)

Written before any cell runs. **Nothing has been executed for this document.**

## The question

Two jobs have been measured. `wide-validators` returned a large saving; `orbit-core` did not reproduce it and the
run could not say by how much. The offline diagnosis
(`bench/results/v5-replan-bound-2026-09-19/DIAGNOSIS.md`) proposes a mechanism: delegation costs one full
rediscovery per worker and buys one parallel unit of work, so the duplication scales with coupling and the saving
with independence. That is a mechanism with two data points and no arm that can separate its two halves.

The product does two things at once to a job:

1. it moves the work **out of the loaded session into a fresh context**, and
2. it **splits** that work across several workers.

Every figure in this repository confounds the two. This run separates them with a third arm that does (1) and not
(2): one worker, fresh context, the whole job, no decomposition.

**This is the first design in this repository that can attribute the saving rather than observe it.** If the saving
is (1), the product's value does not depend on job shape and the shape-conditionality is a cost of (2) that could be
removed. If the saving is (2), the shape-conditionality is intrinsic and the `DIAGNOSIS.md` mechanism stands.

## Arms

| arm | plugin | plan | what it isolates |
|---|---|---|---|
| `sonnet_native` | none | — | the loaded session doing the job itself |
| `jev_single_worker` **(does not exist yet — see Preconditions)** | `mode: auto`, `maxTasksPerPlan: 1` | one task | fresh context **without** decomposition |
| `jev_hierarchy` | `mode: auto`, shipped defaults | free (2–12 observed) | the shipped product |

`jev_single_worker` pays for a planner call that `sonnet_native` does not. That is not corrected for: the primary
outcome is the whole job turn, which is what a user pays. The planner's share is recorded per cell as a covariate
(it was $2.4654 of $19.8628, about a fifth, across the three `v5-replan-bound` cells — a within-arm split, not a
comparison against anything).

## Jobs

**Both**, because shape-dependence is the thing under test and one job cannot show it:

- `wide-validators-primed-30` — 12 independent modules, `chain_depth 1`, nothing shared.
- `orbit-core-primed-30` — 5 tasks, `chain_depth 3`, a shared specification (`test/core.test.js` read 5× by the
  orchestrated arm in the one clean cell, against native's 1×).

2 jobs × 3 arms × 2 repetitions = **12 cells**.

## Predictions, fixed before the run

Written as a table so the result cannot be read to fit afterwards. `S` = single worker, `H` = hierarchy, `N` =
native, each the job-turn cost.

| if the saving is | `wide-validators` | `orbit-core` | reading |
|---|---|---|---|
| **the fresh context** | S ≈ H, both ≪ N | S ≪ N, S < H | decomposition is what `orbit-core` loses to; a one-task plan would be the better default for coupled work |
| **the decomposition** | H ≪ S, S ≈ N | S ≈ H ≈ N | the parallel units are the whole product; `DIAGNOSIS.md` stands as written |
| **both, additively** | H < S < N | S < H, both < N | the two effects are separable and trade against each other by shape |
| **neither (depth artefact)** | S ≈ H ≈ N | S ≈ H ≈ N | the `wide-validators` figure does not survive a third arm and everything downstream of it is in question |

"≈" means the difference is under 15 %, which this bench cannot resolve. "≪" means at least 15 % below.

## Fixed before the run

1. A cell is **invalid** if `context_at_job_prompt` is below 250,000, read from the cell and never from the case name.
2. A cell is **invalid** if it is truncated by `--max-turns` or `--timeout-ms`.
3. **Quality gates cost, per job.** A cost comparison for a job requires every cell of that job, in all three arms, to
   pass its checker. If the arms differ in pass count on a job, that difference is the result for that job and **no
   cost comparison is reported for it**. The other job is reported on its own terms.
4. **The primary outcome is which row of the predictions table the job-turn costs fall in**, stated per job. A result
   that fits no row is reported as fitting no row; the table is not extended after the fact.
5. **Nothing under 15 % is quoted.** Plan size is free in `jev_hierarchy` and fixed at 1 in `jev_single_worker`, so
   the two arms differ in variance by construction: the hierarchy arm's own two cells bound what can be claimed, and
   a delta smaller than that spread is `undecidable`, not a finding.
6. **Mechanism counts are recorded per cell whatever the cost shows**, and are not gated by rule 3, because they are
   not cost: `Read` calls and distinct paths read, `Bash` calls, test-suite runs, worker count, plan size,
   `chain_depth`, planner dollars. These are the quantities `DIAGNOSIS.md` predicts, and the only ones this run can
   report if rule 3 withholds the cost.
7. The gate's decision on each prompt is recorded whatever it is. The two priming prompts are expected to be refused.
   If a **job** prompt is refused in a plugin arm, the recorded reason is that cell's result and no cost claim is made
   from it.
8. Failures, cancellations, timeouts and unknown cells are published with their cause. **A negative result is the
   deliverable.** Rule 4's fourth row is a real possible outcome of this run and is published if it happens.
9. **No floor, checker, criterion, default or threshold is adjusted after seeing these results.** If something here
   needs changing, it is a new pre-registration and a new measurement.
10. `be679ab` (the tier-name redaction and the replan carrying its plan) is in the plugin these cells copy. It is
    **not** what this run measures, and the run is not evidence that either fix works: neither has an end-to-end
    observation, and a fix plus a re-run is not a demonstration of a saving.

## Preconditions — none of this can run yet

1. **`jev_single_worker` does not exist.** `ArmSpec` (`src/bench/run.ts:31-51`) has no per-arm config, and the runner
   freezes exactly one config for the whole run (`plan.frozen_inputs['config_copy']`), so a `maxTasksPerPlan: 1` arm
   cannot sit in the same run as a default-config arm today. It needs a per-arm config override that freezes one file
   per distinct config and records each one's sha256 in `plan.json`. Splitting it into a separate run instead is
   rejected here: the frozen inputs would differ, and a cross-run cost comparison is the thing this harness exists to
   avoid.
2. Unit coverage for that override in `tests/bench-runner.test.ts`, including that a cell records which config it ran
   under. No paid cell runs before those pass.
3. **The owner's own word on the spend.** Recorded `orbit-core` job turns ran $3.26–$4.18 per cell; six orbit cells
   are of that order before the six `wide-validators` cells are counted. This is a paid experiment and is not started
   on a peer's instruction.

## Command (for the record; not run)

```sh
node dist/bench/run.js --cases bench/cases-depth.json \
  --only wide-validators-primed-30,orbit-core-primed-30 \
  --out ~/jev-gate-runs/v5-context-vs-decomposition --execute --max-sessions 12 \
  --arms sonnet_native,jev_single_worker,jev_hierarchy --repetitions 2 \
  --plugin-dir "$PWD" --timeout-ms 2400000 --max-turns 120 --seed 20260919
```
