# Pre-registration — is moving the work into a fresh context worth anything on its own? (2026-09-19)

Written after stage 1 (`bench/results/v5-context-vs-decomposition-s1-2026-09-19/`) and **before any cell of this run
exists**. Nothing here may be edited once a cell has run; a change means a new pre-registration and a new run.

## The question

One question, and it decides whether this product has a reason to exist.

> Does `jev_single` — an admitted turn moved whole into one fresh worker, with no planner, no plan, no contract and
> no replan path — cost less than the same request answered by `sonnet_native` in the loaded session?

- **Cheaper, on both jobs** → the value is the context move alone. Planner, plan, contract, replan, Gate B tiering and
  the task ceiling are then machinery the measured saving does not need, and the product should be that one move.
- **Not cheaper** → **this product has no reason to exist.** A user who opens a new session gets the same thing for
  free. That is the kill criterion, written here before the numbers exist (rule 8 below).

## Why this question, and where it came from

It came from stage 1's **rule 3**, not from stage 1's numbers. Stage 1 asked a cost question about three arms;
`jev_hierarchy` failed the checker in one of two cells, different pass counts fired rule 3, and **no cost comparison
was reportable**. The comparison that survives the rule is a two-arm one, and the two-arm one happens to be the
question the whole repository has been confounding since the first figure: every saving measured here moved the work
into a fresh context *and* split it, in the same step.

**Disclosure, because it matters for how this is read:** the stage 1 wide cells for both of these arms have already
been seen, and they are recorded in that directory. They are treated as a **prior only**. They are not reused as
cells here, no cell of this run is skipped because of them, and no number from them enters this run's result. Reusing
them would be choosing a reuse after seeing what it pays, which is what rule 9 exists to stop.

## Arms — two, and why the third is absent

| arm | plugin | shape | what it is |
|---|---|---|---|
| `sonnet_native` | no | — | the request answered in the loaded session, no plugin loaded |
| `jev_single` | yes | `admittedShape: single` | depth reader → Gate A → Gate B tier → one worker carrying the request verbatim |

`jev_hierarchy` is **not in this run**, and the reason is not that it lost. Its quality differed from the other arms
on both jobs measured so far (orbit: `bench/results/v5-job2-orbit-2026-09-19/`; wide: stage 1), and a quality
difference fires rule 3 and withholds the cost comparison — so including it would spend four more cells to produce
the same withheld answer a third time. **A different question is owed to that arm first**: stage 1 found that its
failure was the plan freezing what the request left open, and that no receipt-layer check can catch it. That is a
mechanism question, and it gets its own pre-registration. It is deferred, not excluded.

## Cells

| job | arms | repetitions | cells |
|---|---|---|---|
| `wide-validators-primed-30` | `sonnet_native`, `jev_single` | 2 | 4 |
| `orbit-core-primed-30` | `sonnet_native`, `jev_single` | 2 | 4 |

**8 cells, ~$45**, one build, one frozen config, no reuse.

`--max-sessions` is a cap on planned cells, not on concurrency: it must be at least the 8 this plan contains, or
preflight refuses to run. Corrected here after preflight refused `4`; **nothing had executed and nothing was
written**, and no arm, job, repetition, rule or threshold changed with it.

```sh
node dist/bench/run.js --cases bench/cases-depth.json \
  --only wide-validators-primed-30,orbit-core-primed-30 \
  --out ~/jev-gate-runs/v5-single-vs-native --execute --max-sessions 8 \
  --arms sonnet_native,jev_single --repetitions 2 \
  --plugin-dir "$PWD" --timeout-ms 2400000 --max-turns 120 --seed 20260919
```

## What is measured

Primary: **job-turn dollars per job**, `jev_single` against `sonnet_native`, reported per job and never pooled across
jobs. The priming turns are not part of the comparison; the job turn is the last turn's cumulative total minus the
previous one, as in every prior run here.

Covariates recorded per cell: wall-clock seconds, root turns, Read calls and distinct paths read, Bash calls,
test-suite runs, Write and Edit counts, Gate A admission, Gate B decision and tier, agent calls, and the worker's
receipt. `jev_single` has no plan and no planner, and **that absence is the arm, not a missing covariate**. The
worker's model cost is inside the arm's total; there is no correction for it.

## Rules — fixed before the run

1. **Depth floor.** A cell whose `context_at_job_prompt` is below 250,000 is invalid and is not counted. Both jobs
   prime to ~390,000; a cell far off that is an environment failure, not a datum.
2. **Truncation.** Any cell whose request or prime was truncated, or that reports an environment error or a non-zero
   exit, is invalid.
3. **Quality gates cost, per job.** A job's cost comparison is reported only if **all four of that job's cells pass
   their checker.** If they do not, that job reports no cost comparison — its mechanism counts and its per-cell
   dollars are still recorded under rule 6, as a record and not as a comparison.
4. **Both jobs, or neither, for the headline.** The kill criterion below is a statement about both jobs. One job
   passing rule 3 and the other not means the headline is not adjudicated; what was measured is still published.
5. **Nothing under 15 % is quoted from this bench**, in either direction. A difference smaller than that is reported
   as "no difference this bench can resolve".
6. **Mechanism counts are recorded whatever rule 3 does.** The counts above are published for every valid cell even
   when no cost may be compared.
7. **No percentage may be quoted from the earlier `v5-job2-orbit` run** (`r-orbit2job`). That ban is about those
   cells. Percentages computed from *this* run's own orbit cells are this run's, and are subject to rule 5.
8. **The negative result is the deliverable, and so is the kill.** If `jev_single` does not beat `sonnet_native` by
   more than 15 % on both jobs, the README says so in its first line and says what follows: the product's measured
   value does not survive removing the hierarchy, and a saving that needs a new session is not a saving this plugin
   produces. Nobody has to be talked into that conclusion afterwards; it is written here.
9. **No post-hoc threshold, rule or arm changes.** Not the floor, not the 15 %, not rule 3's "all four cells", not
   the arm set. A different design is a different pre-registration and a different run.
10. **This run does not measure a default change.** Whatever it shows, `admittedShape` stays `hierarchy` by default
    until a separate decision is taken and recorded; a bench result is not a release.
11. **The build is frozen before the first cell and recorded.** Its commit sha goes in the results README. Cells from
    any other build are not mixed in, including stage 1's.

## Falsification — what result kills what

| claim | falsified by |
|---|---|
| the context move alone pays | `jev_single` not more than 15 % below `sonnet_native` on either job |
| the product has a reason to exist beyond a new session | the above, on **both** jobs |
| the single shape is quality-neutral | any `jev_single` cell failing its checker while both native cells of that job pass |
| the shape is well-behaved | a cell where Gate A does not admit, or where more than one worker is dispatched |

## Precondition for spending

1. Gates green on the frozen build: `npm run typecheck`, `npm run build`, `npx vitest run` all clean.
2. The single-shape receipt repair is in that build (below), with its unit tests.
3. **The owner's own approval for these 8 cells (~$45), given directly.** A relayed approval from a peer session is
   not the owner's word; this repository has already held a run for exactly that reason, and did so correctly.
   **Given directly by the owner on 2026-09-19 ("승인"), for this run as written above.** It covers these 8 cells
   and nothing else: it is not cover for a rule below being relaxed, for a third arm, for a second attempt after a
   bad result, or for any default change, release or tag. Recorded here before the first cell ran.

## Repaired before this run, on purpose

Stage 1 found that the single shape dispatched a worker nobody reserved: a passing job recorded no receipt, stayed
`incomplete` at Stop, and its worker records counted as orphans in the report. `jev_single` is the main arm of this
run, so reading its results would have meant correcting that by hand on every cell. It is repaired with unit tests
before the freeze rather than after the numbers exist.

The repair changes bookkeeping, not work: a reservation and a receipt are written to the job state file, no model
call and no Jev request is added. **It also makes the shape's acceptance legible instead of absent**, and what it is
legible as matters: with no contract there is nothing for code to check, so a single-shape accept is the worker's own
report and is recorded and rendered as reported rather than verified. That is weaker than the hierarchy's
deterministic acceptance, by construction, and this run does not treat the two as the same judgement.

## Not in this run

- `jev_hierarchy`, for the reason above — its own question comes first, with its own pre-registration.
- Any change to `planner.md`. The obvious repair for stage 1's failure ("where the request is silent, follow the
  conventions of the surrounding code") is deliberately **not** made before this run: it would change what the next
  measurement is measuring, and it belongs to the hierarchy track.
- Any default change, release, tag or publish.
