# The job prompt at real depth — delegation halves the job turn, and takes half again as long — 2026-09-19

Step 2 of `DECISION-depth-gate-2026-09-19.md`, and the first measurement in this repository where the job prompt was
submitted at a real session depth rather than reaching that depth inside its own turn. Every earlier "loaded" result
primed and worked in one turn, so at `UserPromptSubmit` the session still looked fresh and a depth gate could never
have fired.

## Result — four cells, all valid, all checks passing, two repetitions

| arm | depth at the job prompt | job turn | session | workers | wall |
|---|---|---|---|---|---|
| `sonnet_native` r1 | 375,219 | $2.7401 | $5.457 | 0 | 284 s |
| `sonnet_native` r2 | 375,263 | $2.6585 | $5.376 | 0 | 272 s |
| `jev_forced_orchestration` r1 | 390,141 | **$1.2338** | $4.087 | 4 | 495 s |
| `jev_forced_orchestration` r2 | 392,089 | **$1.2766** | $4.166 | 4 | 327 s |
| **mean difference** | | **−53.5 %** | **−23.8 %** | | **+47.8 %** |

Within-arm spread is under 4 % on both arms. The priming turn costs about $2.85 and both arms pay it, which is why
the job turn is the comparison the pre-registration fixed and the session total is reported beside it.

## What this settles

**Delegation at depth halves the job turn, for the same finished work.** All four cells pass the same checker against
the same twelve modules. This is the first cost result in this repository that does not rest on priming and work
happening in one turn.

**It does not make anything faster.** +47.8 % wall against native, on top of +196 % in the run before it. The
operator's stated goal has two axes — fewer tokens and more speed — and this design delivers the first and moves the
second the wrong way.

## What the run before it got wrong, and what that corrects

The second run of this case measured **−10.1 %** on the job turn. It is tempting to read the difference as the
priming split finally being fair, and that reading is wrong. The difference is worker count:

| run | workers | job turn, forced | against native |
|---|---|---|---|
| second | 13 | $3.0022 | −10.1 % |
| third | 4, twice | $1.2338 / $1.2766 | −53.5 % |

Same job, same depth, same arms. **Worker count is what moves the cost**, and the depth condition sits on top of it.
The task ceiling added in `7de339b` did not cause the 4: the plan record shows `outcome: ready` with no rejection, so
the planner simply returned four tasks. Why it returned thirteen the run before is still unexplained, and it is the
largest uncontrolled variable left in this measurement — larger than the effect being measured.

## Two invalid cells, and what they cost to find

Under pre-registration rule 1 a cell is invalid when `context_at_job_prompt` is below 250,000.

- **First run, all four cells** (recorded in `invalid-run-2026-09-19.json`): closing stdin with every prompt in it
  makes the host append the waiting prompts to the turn already running. Priming and job became one turn and the job
  prompt was submitted at 27–28K, which is the same condition the loaded case already had.
- **Second run, one cell**: the forced arm orchestrates *every* prompt, priming included, so it handed the thirty
  files to subagents. The content landed in a worker's context and the main session stood at 38,905. The other forced
  cell read them in the main session, which was luck rather than design — the two arms were not under the same
  condition during priming. The priming prompt now says the reading must be done by the session itself.

Neither was discarded. Both are recorded, with the cause, and neither run's numbers are used as a result.

## Not settled here

- **Worker count is not controlled.** 13 and 4 both occurred on the same case; the spread between them is bigger than
  the effect. Until a run repeats planning or fixes a plan, a single cell's cost says as much about the planner's
  variance as about the gate.
- **The task ceiling has never fired.** It is shipped and tested offline; no run has rejected a plan against it.
- **The forced arm is still the arm.** Gate A has not admitted a job end to end. `admissionQuestionShape` and
  `routeQuestionShape` both still default to `composite`.
- **One case, one depth.** The 13-note and 21-note cases in `bench/cases-depth.json` have not been run, so the
  crossing point that sets `delegationDepthFloor` is still derived rather than measured.
- The depth reader itself was observed working in these sessions: the three `admission_result` records of a forced
  cell carry `null`, 389,445 and 390,141 — the fresh first turn, then the primed depth.
