# Pre-registration — is the saving the fresh context or the decomposition? (2026-09-19)

Written before any cell runs. **Nothing has been executed for this document.** Revised the same day, after the arm it
depends on was built (`2042170`), to the design that arm actually implements and to a staged spend.

## The question

Two jobs have been measured. `wide-validators` returned a large saving; `orbit-core` did not reproduce it and the run
could not say by how much. The offline diagnosis (`bench/results/v5-replan-bound-2026-09-19/DIAGNOSIS.md`) proposes a
mechanism: delegation costs one full rediscovery per worker and buys one parallel unit of work, so the duplication
scales with coupling and the saving with independence. That is a mechanism with two data points and no arm that can
separate its two halves.

The product does two things at once to an admitted job:

1. it moves the work **out of the loaded session into a fresh context**, and
2. it **splits** that work across several workers.

Every figure in this repository confounds the two. This run separates them with a third arm that does (1) and not (2).

**This is the first design in this repository that can attribute the saving rather than observe it.** If the saving is
(1), the product's value does not depend on job shape and the shape-conditionality is a cost of (2) that could be
removed. If the saving is (2), the shape-conditionality is intrinsic and the `DIAGNOSIS.md` mechanism stands.

## Arms

| arm | plugin | planner | plan | what it isolates |
|---|---|---|---|---|
| `sonnet_native` | none | — | — | the loaded session doing the job itself |
| `jev_single` | `mode: auto`, `admittedShape: single` | **none — denied** | **none** | fresh context **without** decomposition |
| `jev_hierarchy` | `mode: auto`, shipped defaults | yes | free (2–12 observed) | the shipped product |

`jev_single` is **not** a one-task plan. `admittedShape: single` (`2042170`) removes the planner, the plan, the task
contract and the replan path from an admitted turn; the coordinator dispatches the request once, whole, to one worker,
and the hook appends the user's own request as the task. A `maxTasksPerPlan: 1` arm was rejected for this role: it
still pays for a planner call, still carries a contract and still has a replan path, so it would measure a small
hierarchy rather than the absence of one.

`jev_single` keeps everything the other plugin arm keeps: the depth reader, Gate A, the root guard, Gate B's tier
choice, and the same frozen config with this one key overridden. The override is written per cell, and the file the
cell loaded is on disk beside its trace with its sha256 in the cell record, so what each cell ran under is checkable
rather than asserted.

## Jobs, in two stages

Both jobs matter — shape-dependence is the thing under test and one job cannot show it — but they are **not** funded
at once. Stage 2 runs only if stage 1 earns it.

### Stage 1 — `wide-validators-primed-30`, the job the saving was found on

**All three arms, two repetitions, 6 cells, one build.** This is the job where the effect is largest and therefore
the job where a null result for `jev_single` is most informative. Running native alongside the two plugin arms on the
current build costs two cells more than reusing it, and buys a stage 1 in which every number comes from one build and
no reuse argument has to hold — see the reuse section for what the existing cells can and cannot do.

### Stage 2 — `orbit-core-primed-30`, all three arms, 6 cells

Run **only if** stage 1 places `jev_single` at or below `jev_hierarchy` on `wide-validators`, i.e. only if the
single-executor shape is a live hypothesis rather than a refuted one, **and only on a separate approval of its own**:
stage 1 being funded is not stage 2 being funded. If stage 1 refutes it (see falsification below), stage 2 is not run
and the negative result is the deliverable.

This condition is fixed now, before the stage 1 numbers exist.

## Reuse of existing cells — what is accepted and what is refused

Cells already exist for this exact case, priming prompt and depth band. Stage 1 as designed above does **not** rely
on them — it re-measures all three arms — so what follows is what they can still be used for, and what they cannot:

| arm | source | job turn | decision |
|---|---|---|---|
| `sonnet_native` | `v5-depth-primed-2026-09-19/run-2026-09-19.json` (third run, 2 valid cells) | $2.7401, $2.6585 | **reuse accepted** |
| `jev_hierarchy` | `v5-gate-a-live-2026-09-19/run-deep.json` (2 valid cells, gate admitted on its own) | $0.9475, $0.9842 | **reuse refused for a cost comparison** |

**Why native reuse is accepted.** That arm loads no plugin, so no commit since changes what it does; the case id, the
priming prompt, the depth band (375.2K / 375.3K) and the checker are the same, and both cells passed. The conditions a
reused native cell must still satisfy are the validity rules below, checked against the recorded cell and not assumed.

**Why hierarchy reuse is refused.** Those cells were run on a plugin build from before `c2c9bd1` (the worker now reads
the request the plan was written from), `be679ab` (tier names are redacted at the routing boundary, and a replan
carries its plan) and `2042170`. All three change what the hierarchy path composes and what the planner is shown.
Comparing a new `jev_single` cell against them is comparing across builds, which is the comparison this harness exists
to avoid. So:

The consequence is the stage 1 above: **6 cells, ~$22–$28**, all three arms re-measured on the current build. The
cheaper shapes, and what each forfeits, are recorded so the trade is visible rather than assumed:

| stage 1 shape | cells | what it forfeits |
|---|---|---|
| all three arms (**chosen**) | 6 | nothing; every number is from one build |
| `jev_single` + `jev_hierarchy`, native reused | 4 | nothing measurable — native carries — but the native cells are from another run |
| `jev_single` only | 2 | the S-vs-H comparison: the old hierarchy cells are a **prior, not an arm**, and no S-vs-H percentage may be quoted from that pairing |

Which shape runs is the owner's call, because it is the owner's money. Nothing here starts without it.

## Predictions, fixed before the run

`S` = `jev_single`, `H` = `jev_hierarchy`, `N` = `sonnet_native`, each the job-turn cost.

| if the saving is | `wide-validators` | `orbit-core` | reading |
|---|---|---|---|
| **the fresh context** | S ≈ H, both ≪ N | S ≪ N, S < H | decomposition is what `orbit-core` loses to; the single shape would be the better default for coupled work |
| **the decomposition** | H ≪ S, S ≈ N | S ≈ H ≈ N | the parallel units are the whole product; `DIAGNOSIS.md` stands as written |
| **both, additively** | H < S < N | S < H, both < N | the two effects are separable and trade against each other by shape |
| **neither (depth artefact)** | S ≈ H ≈ N | S ≈ H ≈ N | the `wide-validators` figure does not survive a third arm and everything downstream of it is in question |

"≈" means the difference is under 15 %, which this bench cannot resolve. "≪" means at least 15 % below.

## What would falsify each arm

Fixed now, so that no result is read as support for the arm that produced it.

- **`jev_single` is refuted** if its job turn is **above `sonnet_native`** by 15 % or more, or if it fails the checker
  where native and hierarchy pass. Either says the fresh context is not what buys the saving — a worker starting empty
  pays a rediscovery the loaded session does not, and one worker has no parallelism to pay it back. That outcome ends
  stage 2 and is published as the result.
- **`jev_single` is refuted as a *product* direction**, separately, if it matches hierarchy on cost but loses on
  quality: a shape that is cheap because it does less is not cheaper.
- **`jev_hierarchy` is refuted as the explanation** if `S ≈ H` on `wide-validators`: the planner, the plan, the
  contract and the replan path would then be cost with no measured return on the job this repository's headline came
  from.
- **The `DIAGNOSIS.md` mechanism is refuted** if `S ≪ H` on `orbit-core` *and* the mechanism counts show `jev_single`
  reading the shared specification once where the hierarchy read it five times — the duplication, not the coupling,
  would be doing the work.
- **The whole line of inquiry is refuted** by the fourth row: three arms within 15 % of each other on both jobs.

## Covariates recorded per cell

- **Plan size** (`jev_hierarchy` only): the largest uncontrolled variable in every earlier result — 13 workers cost
  +92.5 % where 4 cost −53.5 % on the same job. `jev_single` has **no plan at all**; that absence is not a missing
  value, it is the observation the arm exists to make, and it is recorded as `admittedShape: single` with the plan
  field null rather than as a plan of size 1.
- Planner dollars (`jev_hierarchy` only; about a fifth of that arm's spend across the three `v5-replan-bound` cells —
  a within-arm split, not a comparison against anything). `jev_single` pays none: that is part of the effect, not a
  correction to apply.
- `Read` calls and distinct paths read, `Bash` calls, test-suite runs, worker count, `chain_depth`, wall clock,
  `context_at_job_prompt`, and the gate's decision and reason on every prompt.

## Fixed before the run

1. A cell is **invalid** if `context_at_job_prompt` is below 250,000, read from the cell and never from the case name.
2. A cell is **invalid** if it is truncated by `--max-turns` or `--timeout-ms`.
3. **Quality gates cost, per job.** A cost comparison for a job requires every cell of that job, in every arm being
   compared, to pass its checker. If the arms differ in pass count on a job, that difference is the result for that
   job and **no cost comparison is reported for it**.
4. **The primary outcome is which row of the predictions table the job-turn costs fall in**, stated per job. A result
   that fits no row is reported as fitting no row; the table is not extended after the fact.
5. **Nothing under 15 % is quoted.** Plan size is free in `jev_hierarchy` and absent in `jev_single`, so the two arms
   differ in variance by construction: the hierarchy arm's own cells bound what can be claimed, and a delta smaller
   than that spread is `undecidable`, not a finding.
6. **Mechanism counts are recorded per cell whatever the cost shows**, and are not gated by rule 3, because they are
   not cost. They are the quantities `DIAGNOSIS.md` predicts, and the only ones this run can report if rule 3
   withholds the cost.
7. The gate's decision on each prompt is recorded whatever it is. The two priming prompts are expected to be refused.
   If a **job** prompt is refused in a plugin arm, the recorded reason is that cell's result and no cost claim is made
   from it.
8. Failures, cancellations, timeouts and unknown cells are published with their cause. **A negative result is the
   deliverable.** Rule 4's fourth row, and every falsification above, are real possible outcomes and are published if
   they happen.
9. **No floor, checker, criterion, default or threshold is adjusted after seeing these results.** If something here
   needs changing, it is a new pre-registration and a new measurement.
10. `c2c9bd1`, `be679ab` and `2042170` are in the plugin these cells copy. They are **not** what this run measures, and
    the run is not evidence that any of them works: none has an end-to-end observation, and a fix plus a re-run is not
    a demonstration of a saving.
11. `admittedShape: single` stays off by default whatever this run shows. Changing the shipped default is a separate
    decision on more than one job, not a consequence of stage 1.

## Preconditions

1. **The arm exists.** `2042170`: `admittedShape` in the config schema, the single path in the hook and the
   coordinator, the `jev_single` arm, and the per-cell config override recorded with its sha256. Done.
2. **Unit coverage, including that a cell records which config it ran under.** `tests/bench-runner.test.ts` runs all
   eight arms and asserts that the `jev_single` cell loaded a file inside its own cell whose sha256 the cell records,
   that the file differs from the frozen config in `admittedShape` and nothing else, and that every other arm records
   no override. `npm run typecheck` 0, `npm run build` 0, `npx vitest run` 534/534. Done.
3. **The owner's own word on the spend.** Recorded `wide-validators` primed cells ran about $3.7 per cell all-in, so
   stage 1 is of the order of $22–$28. A peer session relayed an approval for exactly this shape first; a relayed
   approval is not the owner's own word, and the run was held for it. **Given directly by the owner on 2026-09-19
   ("승인한다고"), for stage 1 as written: `wide-validators-primed-30`, three arms, two repetitions, 6 cells.** It
   covers this run and nothing else — stage 2 is a separate approval, and this one is not retroactive cover for any
   rule below being relaxed.

## Command (for the record; not run)

Stage 1, as designed — all three arms, one job, 6 cells:

```sh
node dist/bench/run.js --cases bench/cases-depth.json \
  --only wide-validators-primed-30 \
  --out ~/jev-gate-runs/v5-context-vs-decomposition-s1 --execute --max-sessions 6 \
  --arms sonnet_native,jev_single,jev_hierarchy --repetitions 2 \
  --plugin-dir "$PWD" --timeout-ms 2400000 --max-turns 120 --seed 20260919
```

Cheaper shapes, if funded instead: `--arms jev_single,jev_hierarchy --max-sessions 4`, or
`--arms jev_single --max-sessions 2` with the forfeit named in the reuse table.

Stage 2 (only if stage 1 earns it):

```sh
node dist/bench/run.js --cases bench/cases-depth.json \
  --only orbit-core-primed-30 \
  --out ~/jev-gate-runs/v5-context-vs-decomposition-s2 --execute --max-sessions 6 \
  --arms sonnet_native,jev_single,jev_hierarchy --repetitions 2 \
  --plugin-dir "$PWD" --timeout-ms 2400000 --max-turns 120 --seed 20260919
```
