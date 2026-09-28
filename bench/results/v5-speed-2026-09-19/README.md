# The speed axis, settled — 2026-09-19

The owner's goal has two axes: fewer tokens and more speed. The token axis is measured
(`v5-gate-a-live-2026-09-19/`). This file settles what is known about the second, from every valid cell run today.

## Wall clock, seconds

| condition | arm | cells | mean | plan tasks |
|---|---|---|---|---|
| deep (~376K) | `sonnet_native` | 284, 272 | 278 | — |
| deep | **`jev_hierarchy`** | 274, 303 | **288** | 2, 2 |
| deep | `jev_forced_orchestration` | 495, 327 | 411 | 3, 3 |
| deep | `jev_forced_orchestration` (12-task plan) | 548 | 548 | 12 |
| shallow (~180K) | `sonnet_native` | 197, 214 | 206 | — |
| shallow | **`jev_hierarchy`** (gate refuses) | 227, 219 | **223** | — |

Only cells whose checks passed and whose depth was valid are listed. The second primed run's native cells are
excluded: they did not do the job, which is why they were fast.

## What it settles

**On the admitted path, speed is unchanged.** +3.6 % deep, against a native arm whose own two cells differ by 4.4 %.
+8.3 % shallow on the refused path, against a native arm whose own cells differ by 8.6 %. Both differences sit inside
the baseline's own spread, so neither is a slowdown this bench can demonstrate.

**The slowdown is real, and it is proportional to worker count.** Three tasks take 411 s, twelve take 548 s, two take
288 s. Workers run in series (`maxParallelWorkers: 1`), so each one adds its own turn-around to the wall clock. The
task ceiling of 10 bounds the worst case; below it, wall time tracks plan size.

**An earlier reading of mine, corrected here.** Two runs measured +196 % and +47.8 % wall against native, and I
reported those as the design being slower. They were: those cells had 12 and 3 tasks. The two-task cells are level
with native. The variable was never "delegation is slow", it was plan size — the same variable that sets the cost.

**One hypothesis tested and rejected.** The refused path was suspected of paying hook process startup on every tool
call. Measured: one hook run takes 30 ms, so 53 tool calls plus 3 prompts is about 1.7 s — a tenth of the 17 s
difference, which is itself inside the baseline spread.

## What is not settled

- **Whether parallelism would buy speed at an acceptable cost.** `maxParallelWorkers: 1 → 4` measured **+32.7 %** in
  cost, but that observation also took plan size from 2 to 6, so the cost increase and the worker increase are
  confounded. A clean test would hold plan size fixed and vary only the cap. Until then the cap stays at 1.
- **Whether a faster path exists at all.** Nothing measured today makes the work finish sooner than doing it directly;
  the best case is parity. If the goal is speed rather than cost, this design does not yet serve it.
