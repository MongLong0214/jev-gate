# Run 4 — the 21-note and 30-note rungs did not reproduce, in any unit — 2026-09-20

Conditions: [`PREREGISTRATION-WORK-2026-09-20.md`](PREREGISTRATION-WORK-2026-09-20.md), committed at `d5eae34`
before the first cell. Rules applied by `apply-rules.cjs` (dollars) and `apply-rules-work.cjs` (work), both
committed before the run. Raw: `rules-applied-4.txt`, `rules-applied-work-4.txt`.

**8 cells, 8/8 valid, 8/8 checker pass, `jev_single` admitted 2/2 at both rungs. Spend $29.64.**

## The result

Reproduction was defined in advance as **verdict class and direction both matching run 2**. Nothing matched.

| rung | unit | run 2 (2026-09-19) | run 4 (2026-09-20) | reproduced? |
|---|---|---|---|---|
| 21-note (285K) | dollars | 43.1 % single LESS — **SEPARATION** | 46.4 % single LESS — direction only | **no** (class) |
| | cache reads | 12.4 % single **MORE** — under floor | 10.5 % single **LESS** — under floor | **no** (direction) |
| | output tokens | 29.6 % single MORE — SEPARATION | 24.3 % single MORE — direction only | **no** (class) |
| 30-note (389K) | dollars | 56.6 % single LESS — **SEPARATION** | **67.2 % single MORE — SEPARATION** | **no** (sign) |
| | cache reads | 27.1 % single LESS — SEPARATION | 15.5 % single LESS — direction only | **no** (class) |
| | output tokens | 11.3 % single MORE — under floor | 49.6 % single MORE — direction only | **no** (class) |

Two rungs, three units, six comparisons, **zero reproductions**. One of them flipped sign on a separation.

Per the pre-registered outcome table this is the **"work does not reproduce"** row, and its conclusion was fixed
before the numbers existed:

> the arms themselves vary run to run at these depths. Neither unit measures a stable property with 2 repetitions
> inside one day, and the depth question needs a design with repetitions **across** days before it is asked again.
> **The ladder is withdrawn entirely, not re-stated in work terms.**

That is the result. The three-point depth ladder is withdrawn whole. No percentage from it is quotable.

## Why the dollar unit is not measuring the arms — now visible inside one run

The 13-note reversal looked like a day-to-day effect. It is not. **The two rungs of this single run sat in
different host-attribution regimes, an hour apart:**

| rung | native host/stream | native cache reads (job turn) | native job-turn $ |
|---|---|---|---|
| 21-note | **60–62 %** | 13.73M, 15.77M | $1.8753, $2.0783 |
| 30-note | **17–20 %** | 19.23M, 20.44M | $0.9387, $0.8910 |

**The 30-note native cells did about 35 % more work than the 21-note ones and were billed about half as much.**
Within one run, one configuration, one fixture. The regime is a property of the session, not of the day.

This is the mechanism behind the 30-note dollar reversal: the native arm's reported cost collapsed while its work
went up, so `single` became "67.2 % more expensive" without either arm changing what it did.

## The arms' own spreads, which are the other half of the story

| rung | arm | cache-read spread | dollar spread |
|---|---|---|---|
| 21-note | native | 14.8 % | 10.8 % |
| | **single** | **95.1 %** | **62.3 %** |
| 30-note | native | 6.3 % | 5.4 % |
| | **single** | 28.5 % | 21.3 % |

The `single` arm is far noisier than the native arm at both rungs. Run 2 happened to catch it tight at the 30-note
rung (2.1 % dollar spread); that tightness was luck, not a property. **With two repetitions the separation rule
cannot clear this arm's own variance**, which is exactly what rule 5 was written to prevent us from ignoring.

## Quality, admission, wall clock

- **8/8 checker pass.** Every `jev_single` cell: one worker, `accept:1`, `completed`.
- Rule 2 held: no priming prompt was admitted in any cell.
- Rule 4: `jev_single` job prompts admitted 2/2 at both rungs.
- Wall: 21-note native 239s vs single 236s (**−1.3 %**); 30-note native 182s vs single 338s (**+85.5 %**).
  The 21-note figure is the first rung measured where `single` was not slower. Against +26.9 %, +55.0 % and
  +54.1 % previously, wall clock is not stable either.

## A confound found in the published data, after the fact

`bench/results/.../RESULTS-RERUN-2026-09-20.md` reported the 21-note rung of run 2 with a single-arm spread of
31.3 %. One of those two cells — `wide-validators-primed-21 / jev_single / 2` — recorded `preserved=1`: the hook
kept the coordinator's call instead of patching it.

On that path the hook returns **before** `composeSingleWorkerPrompt`, so **the user's request was never appended
to the worker's prompt**, while `coordinator.ts` tells the coordinator it does not need to restate the request
because the hook appends it. In that cell the coordinator restated the whole task anyway (3,931 bytes) and the
checker passed, so nothing was measured wrong — by luck rather than by design.

It is recorded here because it is the only cell of the four runs that took that path, it was the expensive outlier
of its rung, and a reader comparing rungs deserves to know it ran under a defect. **No causal claim is made: the
cell's cost is not attributed to this.** The defect itself is being fixed separately.

## Spend, against what was quoted

| | |
|---|---|
| quoted to the owner when approval was given | ≈ $25 |
| corrected in the pre-registration, before the first cell | $13–$33 |
| **actual** | **$29.64** |
| ladder question, cumulative | **$87.83** |

## Limits

- Two repetitions per arm per rung. That is the whole sample, and this run is the demonstration that it is too
  small for the `single` arm's variance.
- Rule 5 holds: **no third attempt.** Run 2 and run 4 both stand as published, and the disagreement is the finding.
- Rule 6 holds: nothing here was produced by differencing a run-4 percentage against a run-2 percentage. The
  reproduction verdicts compare verdict class and direction only.
- Why the host attribution changes between sessions is still **not established**. It is outside what this bench
  records and it was not guessed at.
- `hierarchy` was not an arm. This run says nothing about whether splitting work adds or subtracts.

## What now stands, and what does not

**Withdrawn:** the depth ladder, whole — 41.8 % at 193K, 43.1 % at 285K, 56.6 % at 389K. None of the three rungs
survived a repeat, and the unit they were measured in has now been shown unstable **within** a run.

**Still standing:** the quality record (every `jev_single` cell of every run passed its checker), Gate A's refusal
below the floor, and the fact that `delegationDepthFloor: 300000` was derived from `hierarchy` measurements and has
never described this shape.

**Not established, and not to be presented otherwise:** that the `single` shape saves money at any depth.
