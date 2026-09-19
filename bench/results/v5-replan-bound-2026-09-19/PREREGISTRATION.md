# Pre-registration — does the fixed replan-bound text convert the failure? (2026-09-19)

`v5-job2-orbit-2026-09-19` produced one cell that dispatched no worker at all. Its trace shows why: the coordinator
held an accepted four-task plan revision, asked for a third revision, and was refused with *"This job has used its
allowed attempts for that step. Report the blocker to the user instead of retrying."* It reported, as instructed, and
the turn ended with the fixture untouched at 96 % of a successful cell's cost.

`b82f717` changes only what that refusal says: with a plan in force it now names the revision, says it stays in force
and its ready tasks can still be dispatched, lists the ready ids, and makes reporting-without-dispatching the last
resort. This run asks whether a real coordinator reading that text dispatches.

**Case:** `orbit-core-primed-30`. **Arm:** `jev_hierarchy` only. **Repetitions:** 3. **Config:** the shipped defaults,
frozen as in the previous run (`admissionQuestionShape: atomic`, `delegationDepthFloor: 300000`,
`maxParallelWorkers: 1`, `maxTasksPerPlan: 10`). **Budgets:** 120 turns, 40 minutes per cell — identical to the run
this follows.

Fixed before the run:

1. **A cell is invalid** if `context_at_job_prompt` is below 250,000, if the turn was truncated by the turn budget, or
   if the harness recorded an environment error. Invalid cells are reported with their cause and excluded from both
   outcomes below.
2. **The mechanism outcome comes first, and it is binary per cell**: did this cell reach a `bounds_exhausted` refusal
   on a replan? Only a cell that did has read the new text. A cell that never reaches the bound tests nothing about
   this change, however it ends.
3. **If no cell reaches the bound, the run is reported as not having tested the fix.** The pass counts are then
   reported as three more observations of this job's pass rate and nothing else. This is the expected-null outcome and
   it is not a reason to re-run with different settings.
4. **For a cell that does reach the bound, the outcome is whether it dispatched a worker afterwards** — recorded from
   the trace (`pre_result` / agent dispatches), not from the final message. Dispatching and then failing the checker is
   a different result from not dispatching, and both are reported.
5. **Quality is reported per cell as passed/total checks**, by the same `bench/v5/checkers/orbit-core.mjs` used before.
6. **No cost comparison is reported, and no percentage is quoted.** The native arm is not re-run: nothing in `b82f717`
   can reach it, and its two same-day cells stand. A one-armed run cannot compare arms, and this run is not an attempt
   to answer the cost question that `v5-job2-orbit` left unmeasured.
7. **Dollars are recorded per cell** for the record, exactly as in the previous run, and are not promoted to a claim.
8. **Nothing is tuned after results are visible** — not the floor, not the checker, not the budgets, not the number of
   repetitions. If this run says the question was asked wrong, the answer is a new pre-registration and a new run.
9. **A failure that is not the one being studied is reported as itself.** If a cell fails for a new reason, that reason
   is the result for that cell; it is not folded into the plan-validation-churn story.

**What this run cannot settle, stated now:** why a plan drifts from the request's explicit API contract in the first
place. The validator checks a plan's shape, not its fidelity, and that is untouched here. Three cells also cannot
measure the rate at which the bound is reached; they can only show what happens when it is.
