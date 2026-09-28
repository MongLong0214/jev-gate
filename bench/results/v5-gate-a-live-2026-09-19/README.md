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

**One case, one depth, two repetitions.** The shallow half is below.

**`routeQuestionShape` is still `composite`** in these cells. Gate B's atomic shape was not exercised here.


## The shallow half — the refusal is exact, and its cost is not measurable here

`wide-validators-primed-13` primes with thirteen notes and arrives at **179,171–180,778**, comfortably under the
300,000 floor, so the case does test the floor. Same arm, same config, two repetitions each against `sonnet_native`,
all four cells passing.

**The refusal is exactly what it should be.** Every prompt in both jev cells recorded `depth_below_floor` or
`depth_unknown` with `attempted: false` — **zero Jev requests, zero workers, zero orchestration**. The gate did not
ask a question it had already decided.

**Whether refusing costs what native costs cannot be answered from this run:**

| arm | cells | mean | spread within the arm |
|---|---|---|---|
| `sonnet_native` | $1.3697 / $1.7378 | $1.5537 | **26.9 %** |
| `jev_hierarchy` | $1.7605 / $1.7848 | $1.7727 | 1.4 % |

`jev_hierarchy` is 14.1 % above the native mean, and the native arm's own two cells differ by 26.9 %. The baseline
moves more than the thing being measured. Pre-registration rule 2 (a 10 % band) is not met, and rule 5 therefore
applies: **no cost claim is made from these cells**, and the default does not flip — not because refusing is
expensive, but because this run cannot tell.

### A wrong diagnosis, recorded because it was nearly published

With three of the four cells in hand, the jev arm read 26 % more `cache_read` than the single native cell
(9,275,140 against 7,360,698) while every stream-visible quantity matched — 41 turns, 53 tool calls, 53 tool results,
79 main-turn requests, zero retries, zero denials. That looked like a real per-session cost the plugin imposes on
turns it refuses, and it was written up as one. The fourth cell, `sonnet_native` r2, then read **9,185,753** — the jev
figure. The low cell was the native one, not the high ones.

The lesson is the ordinary one, and it cost nothing this time only because the run had not finished: **a difference
against a single baseline cell is not a difference.** The deep case's 3 % native spread made 26 % look impossible;
the shallow case's native spread is 27 %.

## What the two halves together do and do not license

- The gate admits at depth and refuses below the floor, both for the right recorded reason, with no request sent on a
  refusal. That part is settled.
- At depth the admitted path costs **−64.2 %** on the job turn against native, at **+3.8 %** wall. That part is
  measured, on one case, twice.
- Below the floor the refusal's cost is **unmeasured**, and this bench cannot measure a 10 % effect there without more
  repetitions or a case whose native arm is stabler.
- `admissionQuestionShape` therefore stays `composite` by default.
