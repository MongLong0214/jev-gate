# Pre-registration: does Gate B routing help at a fixed dispatch boundary? — 2026-09-20

**Status: superseded before it ran, 2026-09-20.** The owner approved the spend the same day. It was
not run, and it can no longer be run as written, for two separate reasons:

1. **The arms do not exist.** `fixed_standard` and `jev_atomic` are not in `ALL_ARMS`
   (`src/bench/run.ts:21,28`), and every arm that does exist drives a full `claude -p` session with
   the coordinator in the loop — the one thing §Design excludes by construction. Building them needs
   a fidelity decision this registration never made: how a worker is dispatched without the host's
   Agent tool.
2. **The code changed under it.** A21 and A22 (`08fe8fb`) added questions to the atomic admission and
   worker-route sets, so `jev_atomic` no longer names the question set this document was written
   against. Rule 8 below forbids moving a rule after seeing results; it says nothing about a
   registration whose subject moved, and the honest reading is the same — **this document is a record
   of a question asked on 2026-09-20, not a description of the current code.**

Anything measured here needs a new pre-registration written against the arms and question sets that
exist when it is written. Nothing below is edited; it stands as it was registered.

## Why this question and not the last one

Four runs tried to measure what admitting a turn saves. The ladder was withdrawn on 2026-09-20:
six comparisons, none reproduced, and the deepest rung reversed sign on a separation. The reason
is structural rather than bad luck — an admitted turn moves the work into a fresh context *and*
routes it *and* splits it, and the arm that does all three has spreads (95.1 % cache reads at one
rung against the native arm's 14.8 %) that two repetitions cannot clear. No pairing trick removes
that, and the runner already shuffles arm order.

So this run does not ask what the product saves. It asks **whether one decision the product makes
is a good decision**, with everything else held fixed. That is a smaller claim and it is one this
harness can actually carry.

## The question

Given a worker dispatch that is going to happen anyway, does letting Jev choose the tier produce
better work than the fixed default, at what cost in tokens and latency?

## Design

One job, one fixture, one worker packet. **The packet is byte-identical in both arms** — the same
request, the same contract, the same tool workload, the same retry policy. The only thing that
differs is who picks the tier.

| arm | tier chosen by |
|---|---|
| `fixed_standard` | the configured default, no Jev call |
| `jev_atomic` | Gate B atomic, `routeQuestionShape: 'atomic'` |

No planner. No admission. No hierarchy. `admittedShape` is not exercised. The coordinator is not
in the loop, which is the largest source of variance the last four runs could not hold still.

## Rules, fixed before the first cell

1. **Repetitions:** 4 per arm per job, 3 jobs. 24 cells.
2. **Validity:** a cell is valid if the dispatch was reserved, the worker returned a parseable
   reply, and the checker ran. An invalid cell is reported and excluded, never re-rolled.
3. **Primary outcome is quality, not cost.** The independent checker's pass/fail, defined in the
   fixture before any cell runs. Cost is secondary and is reported whether or not it is separable.
4. **Separation:** a cost difference is claimed only at ≥ 15 % magnitude **and** greater than the
   wider arm's own within-run spread. Quality is reported as counts, with no threshold — 24 cells
   cannot support a significance claim about pass rates and none will be made.
5. **Units:** report the vector, not one number. Input exposure (fresh + cache creation + cache
   reads), output, usage-bearing message count, dispatches, retries, checker outcome, wall clock,
   and the Jev call's own tokens and latency separately.
6. **Reported, not verified.** `turn_totals_stream` is *summed reported stream usage*. The runner
   now counts `duplicates` and `incomplete` per turn; **if either is non-zero in any cell, every
   token figure in the report carries that count beside it** and the word "de-duplicated" is not
   used. `turn_totals_usd` is what the host reported, not a reconciled bill.
7. **The attribution band is reported per session, not assumed.** Host-reported cache reads over
   stream-summed cache reads, for every cell. Within one earlier run this varied 17 %–63 %, and it
   is a property of the session rather than of the day. If it varies across arms here, the dollar
   comparison is withdrawn and only the token vector is reported.
8. **No post-hoc rule changes.** If a threshold or a unit needs to move, it moves in a new
   pre-registration and the run is done again.
9. **No third attempt.** If this run disagrees with itself, the disagreement is the finding.
10. **A negative result is the deliverable.** "Jev routing changed nothing measurable at this
    boundary" is a publishable answer and closes the question for this boundary.

## What this cannot establish, stated before the numbers exist

- **Not whole-session savings.** One dispatch boundary is not a session.
- **Not a depth crossing.** Depth is not varied and nothing here speaks to `delegationDepthFloor`.
- **Not that the hierarchy is worth having.** The hierarchy is absent by construction.
- **Not routing accuracy in general.** Three jobs is three jobs. A tier that helps here may not
  elsewhere, and the checker measures whether the work passed, not whether the tier was optimal.
- **Not that a fixed replay predicts autonomous work.** A scripted dispatch establishes the
  overhead of that dispatch. It does not establish what an unconstrained session does.

## Estimated cost

Deliberately stated before spending, because the last estimate was wrong: I quoted ≈$25 for a run
that had already cost $32.62. 24 cells at the observed per-cell range of $0.9–$2.1 gives
**$22–$50**. Cumulative spend on this bench to date is $87.83.
