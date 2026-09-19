# Gate A admits a job on its own — and the speed penalty disappears — 2026-09-19

Every cost figure in this repository until now rested on `jev_forced_orchestration`, the diagnostic arm where
admission is forced and no Gate A judgement runs. This is the first run where the shipped gate decided for itself.

Arm: `jev_hierarchy`, `mode=auto`, nothing forced, `admissionQuestionShape: atomic`, `delegationDepthFloor: 300000`.
Case: `wide-validators-primed-30`. Two repetitions, both passing the same checker.

## The decision, which is the primary outcome

Three prompts reach the gate in each cell, and it treated them differently — which is the point:

| prompt | depth | request sent | decision |
|---|---|---|---|
| priming (read the thirty notes) | — | **no** | `depth_unknown` → direct |
| confirmation ("just say ready") | ~376,000 | yes | `admission_answer_only` (r1) / `admission_too_small` (r2) → direct |
| **the job** | 376,413 / 376,075 | yes | **`orchestrated`, decided: true, no reason** |

The first prompt of a fresh session costs nothing at all: with no transcript yet there is no depth, and the gate
refuses before any request. The confirmation turn is a genuine refusal on the request's own content, at full depth,
and both vetoes that fired are correct readings of "just say ready".

## Cost and time, against the same case on the same build

| arm | job turn | session | workers | wall |
|---|---|---|---|---|
| `sonnet_native` (mean of 2) | $2.6993 | $5.417 | 0 | 278 s |
| `jev_forced_orchestration` (mean of 2) | $1.2552 | $4.127 | 4 | 411 s |
| **`jev_hierarchy` (mean of 2)** | **$0.9658** | **$3.693** | 3 | **288 s** |
| **against native** | **−64.2 %** | **−31.8 %** | | **+3.8 %** |

Within-arm spread 3.8 %. Baseline cells are the third primed run: same case, same priming prompt, same build, same
day, not re-run here.

**The speed penalty is gone.** Every earlier condition measured wall time moving the wrong way — +196 %, then
+47.8 %. Here it is +3.8 %, which is inside the spread of the native arm itself. For the first time the two axes the
owner asked for — fewer tokens, not slower — are satisfied at once, with the same finished work.

## What this does not settle

**Why `jev_hierarchy` beat `jev_forced_orchestration` is not established.** The two differ only in whether Gate A is
consulted; once it admits, the path is the same. The cheaper arm also ran 3 workers against 4, and worker count has
moved this job's cost by a factor of 2.4 before. Worker counts observed on this case so far: 13, 4, 4, 3, 3. This run
does not separate "the gate chose better" from "the planner split smaller this time", and nothing here should be read
as the former.

**One case, one depth, two repetitions.** The shallow half — that the gate refuses a session below the floor, and
costs native when it does — is measured separately (`wide-validators-primed-13`), and the default does not flip until
that result exists.

**`routeQuestionShape` is still `composite`** in these cells. Gate B's atomic shape was not exercised here.
