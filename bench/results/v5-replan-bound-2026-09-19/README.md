# v5-replan-bound — the run did not test the fix (2026-09-19)

Pre-registration: [PREREGISTRATION.md](PREREGISTRATION.md), committed at `21073ae` before the run started.
Run directory: `/Users/isaac/jev-gate-runs/v5-replan-bound`. Plugin under test: `b82f717` (the runner copies the
plugin at start, so nothing committed later is in this run).

## Result, by rule 2 and rule 3

**No cell reached a `bounds_exhausted` refusal.** All three planned once, were accepted at revision 1, and never asked
for a replan. By rule 3 this run **did not test `b82f717`**, and that was written down as the expected-null outcome
before any money was spent. It is not a reason to re-run with different settings.

| rep | planner calls | invalid replies | accepted rev | tasks | chain depth | replans | `bounds_exhausted` | workers dispatched | checks |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 0 | 1 | 5 | 2 | 0 | never reached | 5 | pass 16/16 |
| 2 | 1 | 0 | 1 | 4 | 2 | 0 | never reached | 4 | pass 16/16 |
| 3 | 1 | 0 | 1 | 5 | 2 | 0 | never reached | 5 | pass 16/16 |

All three cells are valid under rule 1: depth 388,478 / 388,234 / 388,380 at the job prompt (floor 250,000), no
truncation, no environment error. The runner's own verdict is `mechanism only`.

## What the pass counts are allowed to say

By rule 3 they are **three more observations of this job's pass rate and nothing else**. With the two `jev_hierarchy`
cells of `v5-job2-orbit-2026-09-19`, `orbit-core-primed-30` now stands at **4 of 5** jev cells passing.

The one failure remains the only cell of the five that ever reached the bound. Three clean repetitions do not make it
rare in any measured sense — three cells cannot estimate a rate — but they do rule out the reading that the failure
was the normal course of this job.

## Dollars, recorded and not promoted (rule 6, rule 7)

| rep | job turn | session | wall |
|---|---|---|---|
| 1 | $3.8146 | $6.7322 | 893 s |
| 2 | $4.1756 | $7.0210 | 1107 s |
| 3 | $3.2583 | $6.1065 | 1278 s |

**No cost comparison is reported and no percentage is quoted.** The native arm was not re-run; this is a one-armed
run and cannot compare arms. These numbers exist so a later pre-registered comparison can be checked against them,
not so this run can be read as one.

## What it cannot settle, restated

Why a plan drifts from the request's explicit API contract. The validator checks a plan's shape, not its fidelity.
`c2c9bd1` (record `r-reqcarry`) now carries the request to the worker so the drift is visible where it lands, but
**no run has exercised that**, and this one could not: it was already measuring `b82f717` when `c2c9bd1` was written.

The cost question that `v5-job2-orbit` left open is also untouched here, and it is the one that matters — see
`DIAGNOSIS.md` in this directory, which uses only artifacts already on disk and spends nothing.
