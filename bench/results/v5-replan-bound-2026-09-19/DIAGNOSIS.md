# Why orbit-core loses when nothing is broken (2026-09-19)

Offline diagnosis. **No cell was run for this.** Every number below comes from artifacts already on disk:
`/Users/isaac/jev-gate-runs/v5-job2-orbit/` and `/Users/isaac/jev-gate-runs/v5-replan-bound/`.

## The question this answers

`v5-job2-orbit` r2 is the cell that matters, because nothing went wrong in it. It planned once, dispatched five
workers, and passed 16/16 checks. Neither `b82f717` (the replan-bound text) nor `c2c9bd1` (request carriage) can
explain anything about it: it never reached the bound and it produced the right answer.

**A note on what this document is not allowed to say.** `r-orbit2job` records that no percentage may be quoted from
that run, and its pre-registration rule 3 withholds a cost comparison because the arms differ in pass count. The
per-cell dollars are preserved in `bench/results/v5-job2-orbit-2026-09-19/run.json` under rule 8 and **are not a
comparison**. So this diagnosis quotes no cost figure and no percentage for orbit-core. It works entirely from
**mechanism counts** — reads, test runs, dependency depth — which are not gated by that rule, and which are the
thing a future pre-registered comparison would be trying to explain.

## The plan r2 executed

| task | depends_on | deliverables | contract bytes |
|---|---|---|---|
| t1 | — | `src/clock.js`, `src/camera.js`, `src/hud.js` + 3 tests | 5,040 |
| t2 | — | `src/physics.js` + test | 3,488 |
| t3 | — | `src/collisions.js`, `src/snapshot.js` + 2 tests | 5,370 |
| t4 | t1, t2, t3 | `src/simulation.js` + test | 3,783 |
| t5 | t4 | `test/determinism.test.js` | 2,835 |

`chain_depth: 3`. Three leaves fan **in** to one integration task, which feeds a whole-pipeline determinism test.
The three `v5-replan-bound` cells are the same shape one level shallower: 4–5 tasks, `chain_depth: 2`, all passing,
job turns $3.26–$4.18.

## What wide-validators looks like, in the same terms

Every observed `wide-validators` plan: **12 tasks at `chain_depth 1`** (`v5-atomic`), and in the other runs 1, 3 or 5
tasks at depth 1–2. The canonical shape is a pure fan-out with **no `depends_on` edges at all** — twelve independent
modules receiving the same edit, one test per module.

The requests differ by the same factor as the structures: wide-validators is **322 bytes**, orbit-core is **4,676
bytes** — 14.5×, because orbit-core has to fix seven modules' signatures *and how they compose*.

## (a) (b) (c), answered from the r2 stream

**(a) Do the tasks depend on each other?** Yes — `chain_depth 3` against wide-validators' 1. t4 cannot start until
three workers have settled, and t5 cannot start until t4 has. Two of five tasks are strictly serial, so the
parallelism that pays for delegation is unavailable for 40 % of the plan.

**(b) Do workers re-read the same files?** Yes, and this is the largest single difference measured.

| | jev_hierarchy r2 | sonnet_native r2 |
|---|---|---|
| `Read` calls | **49** (29 distinct paths) | **6** (6 distinct) |
| most-repeated read | `test/core.test.js` **5×** (also `src/clock.js` 5×, `src/physics.js` 5×, `package.json` 4×) | 1× |
| `Bash` calls | 63 | 33 |
| test-suite runs | **15** (3+1+2+2+7 across five workers) | **1** |
| `Write` / `Edit` | 17 / 5 | 14 / 0 |

The coordinator alone spent 17 `Read` and 31 `Bash` calls re-deriving state it had delegated. Every worker opened
`test/core.test.js` — the spec the whole job is written against — because a worker starts with an empty context and
cannot inherit what its siblings already read.

**(c) Is the contract prefix large?** No, and this is the one suspect that is **not** guilty. Contracts run
2,835–5,370 bytes; the coordinator's own briefs were 703–2,359 bytes; the planner prompt was 10,076. Five workers at
roughly 6 KB of prefix is about 30 KB — a rounding error against a 388 K context and 46 M tokens of traffic.

## The mechanism, in one paragraph

Delegation costs one full rediscovery per worker and buys one parallel unit of work. wide-validators is the shape
where that trade is free: twelve disjoint files, nothing shared to rediscover, twelve units bought. orbit-core is one
artifact cut five ways over a shared specification, so every worker re-reads the same substrate (5× on three files,
15 test runs against native's 1), and two of the five tasks cannot run in parallel anyway. **The duplication scales
with coupling; the saving scales with independence.** That is the mechanism by which the same product can return a
large saving on one job and none on another with no defect in either run — and the reason a single job's figure was
never a property of the product.

If this holds, the product's saving is **conditional on job shape**, and that belongs at the top of `HANDOFF.md` as a
property, not on a backlog as a defect. It is not something to fix.

## Can Gate A know in advance?

**Not with what Gate A has.** It sees the prompt and decides compound vs direct, and it was right both times — both
jobs *are* compound. Compound is not the predicate that matters. The predicate that matters is whether the work
*decomposes into independent units*, and both prompts describe many modules; only orbit-core's text also describes
how they compose, which is a distinction no current gate input captures.

But the discriminator does exist — one step later. `chain_depth` is computed at plan time and already recorded in
every plan trace, and the overlap between tasks' `deliverables` and `spec.files` is computable from the same reply.
Across the three `v5-replan-bound` cells the planner (opus) accounts for **$2.4654 of $19.8628 total**, about a fifth
of the arm's spend — a within-arm split, not a comparison against anything. So the gate could buy the plan, measure
its shape, and decline to execute it, paying the planner to avoid the worker phase.

That is a design proposal, not a result. Two things would have to be pre-registered and measured before it is one:
that `chain_depth` (or file overlap) actually predicts the sign of the cost difference, and that the fallback path
costs what it looks like it costs. Note the caution already visible in the data: the three `v5-replan-bound` cells
were `chain_depth 2` and still expensive, so depth alone may not be the right threshold — shared-substrate overlap
is present at depth 2 as well.

## Limits of this diagnosis

- **n = 2 job shapes**, and the cost side of one of them may not be quoted at all. This is a mechanism with two data
  points, not a measured relationship between coupling and cost.
- The read/test counts are from **one cell per arm** (r2 of each). They are large differences (8× reads, 15× test
  runs), but they are single observations.
- Both pre-registrations forbid a cost comparison — `v5-job2-orbit` rule 3 because the arms differ in pass count,
  `v5-replan-bound` rule 6 because it is one-armed. **Nothing here may be read as "orchestration costs X % more on
  orbit-core."** That claim needs a new pre-registration, a paired native arm, and repetitions, written before the
  cells run.
- Fixing a bug and re-running does not evidence a saving. The negative result at `895f95b` stands as written.
