# Pre-registration — the speed half, and the planner — 2026-09-19

Written before the run. Baseline is the measured cell in `v5-tier-e2e-2026-09-19`: the loaded job, forced
orchestration, haiku workers, **$1.1465 / 285.1 s / all checks passing**, against `sonnet_native` at $6.2851 / 324.6 s.

Two things remain unaddressed there, and they are independent:

- **Speed.** `maxParallelWorkers` is 1, so workers run in series. 285 s against 324 s is 12 %, and the sonnet-worker arm
  took 386 s, so run-to-run variance already exceeds that. The token half of the goal is met and the speed half is not.
- **The planner.** `claude-opus-5` costs $0.3358 and barely moves. As the total fell it went from about 12 % of the
  bill to **29 %** — the largest fixed item left.

## The runs

Two cells on the loaded job, forced orchestration, everything else identical to the baseline:

| cell | `maxParallelWorkers` | `models.deep` (the planner tier) |
|---|---|---|
| A | **4** | `opus` — isolates parallelism alone |
| B | **4** | `sonnet` — parallelism plus a cheaper planner |

## Prediction

| | prediction |
|---|---|
| A wall clock | **below 285 s**, because the dispatches in this plan have no dependencies between them |
| A cost | **within noise of $1.1465** — parallelism reorders work, it does not remove any |
| B cost | **below A**, by roughly the difference between an opus and a sonnet planning pass |
| B quality | the risk lives here: a weaker planner may produce a worse plan, and the checker is what says so |

**What refutes what.** A not beating 285 s means the workers were not the serial bottleneck and the coordinator is.
A costing materially more than $1.15 means parallel dispatch carries an overhead this account does not model. B failing
the checker while A passes isolates the planner as the cause, and is a result about how far down the planning tier can
go — not a reason to keep opus without measuring.

Checks first. If a cell fails the twelve-module checker its cost is not compared, and the failure is the finding.

One repetition each. These can settle direction and whether the work still gets done; they cannot settle magnitude.
