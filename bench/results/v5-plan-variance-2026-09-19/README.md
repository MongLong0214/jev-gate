# Plan size is a free variable, and it sets this bench's precision — 2026-09-19

Worker count had moved the same job's cost by a factor of 2.4 across earlier runs, and it was never controlled. This
run measures the planner's own spread directly: the same job, six times, nothing else changed.

`wide-validators` (unprimed, so a cell costs about a dollar), `jev_forced_orchestration` so the planner runs every
time, shipped defaults otherwise. All six cells pass the same checker.

## Result

| repetition | plan tasks | agent calls | session cost | wall |
|---|---|---|---|---|
| r1 | **4** | 5 | $1.0035 | 313 s |
| r2 | 2 | 3 | $0.6987 | 262 s |
| r3 | 2 | 3 | $0.6844 | 226 s |
| r4 | 3 | 4 | $0.7838 | 259 s |
| r5 | 2 | 3 | $0.7572 | 289 s |
| r6 | 3 | 4 | $0.7346 | 233 s |

Task counts 4, 2, 2, 3, 2, 3 — **max/min = 2.0**, which meets the threshold fixed before the run. Plan size is a
genuine free variable. `maxTasksPerPlan` did not fire; nothing came close to ten.

`agent_calls` is one more than the task count in every cell, because it counts the planner dispatch as well as the
workers. Earlier results in this repository that reported "13 workers" and "4 workers" were reporting 12 and 3 workers
plus the planner.

## What it means for every other number here

| grouping | spread |
|---|---|
| within one plan size (2 tasks, three cells) | **10.6 %** |
| within one plan size (3 tasks, two cells) | 6.7 % |
| across all six | **46.6 %** |

So this bench resolves about **10 %** when plan size happens to be constant, and about **47 %** when it is not.

- **The −64.2 % at depth survives.** It is far outside 47 %, it has the same sign in three independent runs, and the
  native arm it is measured against has no plan at all. It should be quoted with an uncertainty of roughly ±20 %, not
  as a point value.
- **The +14.1 % in the shallow condition cannot be claimed**, which is what that run already concluded on its own
  (the native arm there varied 26.9 % between two cells). This explains why.
- **A comparison between two runs whose plan sizes differ is measuring two things at once.** The Gate A run (2 tasks)
  against the third primed run (3 tasks) differ by 30 %; that is not a gate effect, or not only one.

## Not settled

- Why the planner returns 2 for the same job it returns 4 for is unexplained. Nothing in the request changes, and the
  planner is a fresh subagent each time.
- The 12-task plan seen once on the primed case is outside this run's range. Whether the primed case's longer session
  makes larger plans more likely is untested.
- Six cells on one case. The 10 % within-size figure rests on three cells at one size.
- One claim made earlier in this session and corrected here: after two 2-task cells landed within 2 % of each other,
  the within-size precision was called 2–3 %. The third 2-task cell made it 10.6 %.
