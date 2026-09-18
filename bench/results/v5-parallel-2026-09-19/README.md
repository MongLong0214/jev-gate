# Parallelism costs tokens, and a cheaper planner costs more — 2026-09-19

`PREREGISTRATION.md` was committed before these runs. Both predictions were wrong, and the second was wrong by a wide
enough margin to invert the conclusion it came from.

## The whole surface, one job, all arms passing the twelve-module checker

| configuration | cost | vs native | wall | vs native | agents |
|---|---|---|---|---|---|
| native, no plugin | $6.2851 | — | 321.3 s | — | 0 |
| delegate, sonnet workers | $2.6922 | −57.2 % | 382.6 s | +19.0 % | 7 |
| **delegate, haiku, serial** | **$1.1465** | **−81.8 %** | 285.1 s | −11.3 % | 2 |
| **delegate, haiku, parallel 4** | $1.5219 | −75.8 % | **232.1 s** | **−27.8 %** | 6 |
| delegate, haiku, parallel 4, sonnet planner | $3.2615 | −48.1 % | 395.2 s | +23.0 % | 6 |

Output is identical across every row — the checker says so, not inspection.

## Parallelism buys time with prefix

Predicted: wall clock below 285 s, cost within noise of $1.1465, "because parallelism reorders work, it does not
remove any."

Measured: **−18.6 % wall, +32.7 % cost.** The time half was right and the cost half was wrong, and the reason is in
the counts: agent calls went from 2 to 6 and main turns from 9 to 15. Given parallel slots the coordinator **cut the
work into more pieces**, and every additional worker writes its own prefix to cache — the term that became dominant as
soon as delegation removed the cache reads. Coordinator spend rose $0.8094 → $1.1152 accordingly.

So parallelism is not free reordering. It is **buying wall clock with prefix writes**, and whether that is worth it
depends on which half of "cheaper and faster" is being optimised.

## A cheaper planner is more expensive, by a factor of two

Predicted: below the parallel-4 arm, "by roughly the difference between an opus and a sonnet planning pass."

Measured: **$1.5219 → $3.2615, +114 %**, and 70 % slower. The model split shows what happened:

| | planner | coordinator + workers | total |
|---|---|---|---|
| parallel 4, opus planner | opus $0.4053 | sonnet $1.1152 | $1.5219 |
| parallel 4, sonnet planner | — | sonnet **$3.2601** | $3.2615 |

Removing a $0.41 opus pass **added $2.14 of sonnet**. The checker still passes, so the destination is the same; the
route to it is much longer. A weaker plan is made good by the coordinator doing more work.

**This inverts the conclusion it was testing.** `v5-tier-e2e-2026-09-19` called the planner "the largest fixed item
left" and named it as the next lever, on the grounds that it had grown to 29 % of a shrinking bill. It is not a fixed
cost to be reduced — it is a purchase that returns about five times its price. `plannerDefaultTier: 'deep'` and the
separate planner-tier question in `allocation.ts` were right, and this run is what shows it rather than assuming it.

## No configuration is best on both axes

The goal these runs serve is identical output at fewer tokens *and* more speed. Nothing here does both maximally:

| | cost | wall |
|---|---|---|
| serial | **−81.8 %** | −11.3 % |
| parallel 4 | −75.8 % | **−27.8 %** |

$0.38 buys 53 seconds. Both beat native on both axes; neither dominates the other.

## Not settled here

- One repetition per cell. Five configurations, five single observations; the ordering between serial and parallel-4
  on cost is $0.38 and could plausibly be noise, while the planner result is far too large to be.
- Only `deep → sonnet` was tried for the planner. Whether `haiku` planning collapses further, or whether `frontier`
  buys more than it costs, is untested.
- `maxParallelWorkers: 4` was the only parallel setting tried. The coordinator's tendency to subdivide more when given
  slots suggests 2 might land differently, and that is unmeasured.
- Every row is the forced arm. Gate A admits none of this on its own.
