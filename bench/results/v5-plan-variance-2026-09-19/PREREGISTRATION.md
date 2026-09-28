# Pre-registration — how much does the plan size vary? Written before the run (2026-09-19)

Worker count has moved the same job's cost by a factor of 2.4, and it is not controlled. Counts observed on
`wide-validators` so far: **13, 4, 4, 3, 3** — across runs that differed in other ways too, so none of them is a
clean measurement of the planner's own spread.

**What is measured:** the number of tasks in the accepted plan, for the same job, six times, changing nothing else.

**How:** `wide-validators` (the unprimed case, so a cell costs about a dollar instead of four),
`jev_forced_orchestration` (admission forced, so the planner runs every time and the measurement is not lost to a
refusal), shipped defaults otherwise — `routeQuestionShape: composite`, `maxParallelWorkers: 1`,
`maxTasksPerPlan: 10`. Six repetitions.

Depth is not a variable here: the planner is a subagent with its own context and receives the request, not the
session. This run says nothing about cost at depth and is not used for one.

Fixed before the run:

1. The outcome is the distribution of `task_count` over six plans, reported in full, not a mean.
2. **Interpretation, fixed now.** If max/min ≥ 2, plan size is a genuine free variable and no cost comparison on this
   bench is trustworthy at better than that ratio until a plan is fixed or repeated; the next step is then to make the
   plan controllable. If max/min < 2, the 13 was caused by something other than ordinary planner variance, and the
   next step is to find what — the atomic Gate B run it came from is the first place to look.
3. Any plan rejected by `maxTasksPerPlan` is recorded with the count it proposed. A rejection is data, not a failure:
   it would be the first time the ceiling fired.
4. Worker count is recorded beside task count. They can differ — a task can be dispatched more than once — and the
   cost axis is workers, not tasks.
