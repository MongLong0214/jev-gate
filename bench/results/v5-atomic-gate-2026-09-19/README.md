# The atomic Gate B, end to end — it fires, and the result is conditional — 2026-09-19

The first measurement in this repository where **Jev changed what a dispatch cost**. It is also the first where the
same change made a job substantially worse, and the two happen in the same run.

Both cells ran with `models.standard = sonnet`, the default. Any `haiku` below is the gate choosing `fast`, not a
config forcing it.

## Result

| job | gate | cost | wall | agents | patched | checks |
|---|---|---|---|---|---|---|
| loaded (ctx ~406K) | composite | $2.6922 | 382.6 s | 7 | **0** | all pass |
| loaded | **atomic** | **$1.3315** | 456.6 s | 5 | **4** | all pass |
| | | **−50.5 %** | +19.4 % | | | |
| fresh (ctx ~55K) | composite | $0.8888 | 196.1 s | 2 | **0** | all pass |
| fresh | **atomic** | **$1.7112** | 600.5 s | **13** | **11** | all pass |
| | | **+92.5 %** | **+206 %** | | | |

The model split on the loaded job shows the mechanism directly:

| | sonnet | haiku | opus (planner) |
|---|---|---|---|
| composite | $2.2717 | $0.0013 | $0.4192 |
| atomic | **$0.5714** | **$0.3553** | $0.4048 |

Four dispatches moved off sonnet because the gate said `fast`. The composite question, on the same job, patched
nothing — which is what `patched=0` has meant in every previous run here.

It is also selective rather than indiscriminate. Across the run the trace records `worker|fast|changed=True` eleven
times and `worker|standard|changed=False` once: one task had no evidence for a cheaper tier and was left where the
coordinator put it.

## Why the fresh job got worse

`agents` went from 2 to **13**. With the gate actually routing, the plan came out as roughly one worker per module,
and thirteen workers pay thirteen prefixes into cache. That term has now shown up three times in one day:

| observation | worker count | cost effect |
|---|---|---|
| delegation removes cache reads | — | write becomes the largest term, 1.07 M against 0.33 M weighted |
| `maxParallelWorkers` 1 → 4 | 2 → 6 | **+32.7 %** |
| composite → atomic gate, fresh job | 2 → 13 | **+92.5 %** |

**Worker count is the hidden cost axis of this design**, and these results underestimated it three times running. The
tier saving is real and per-dispatch; the prefix cost is real and per-worker; which one wins depends on how deep the
main session is, because that is what sets the size of the tier saving.

## So the shape is conditional, on the same condition as everything else

| | deep context | shallow context |
|---|---|---|
| atomic Gate B | **−50.5 %** | **+92.5 %** |

The depth condition from `v5-context-locality-2026-09-19` governs here too. `routeQuestionShape` defaulting to
`composite` turns out to be right for reasons this run found rather than the reasons it was chosen for: the atomic
shape should be paired with the depth test, not enabled on its own.

## Two corrections

**"Decomposing is 26 % cheaper in tokens" was wrong.** That figure in `v5-fanout-2026-09-19` came from an experiment
script that sent an abbreviated state. The shipped `buildAtomicWorkerRouteRequest` carries the *same* state as the
composite request, so the real numbers are 1,064–1,843 tokens against the composite's 1,189 — comparable, and larger
on a long task. The claim should never have been made, and it does not matter: a Jev call is ~$0.00003 against ~$0.11
saved per re-routed dispatch, so the token comparison is a rounding error either way. What holds is the reason that
actually mattered — the composite cleared its floor once in six and answered the default when it did.

**The run monitoring was measuring itself.** Every `until ! pgrep -f "dist/bench/run.js"` poll matched its own shell,
whose command line contains that string, so the watch reported RUNNING for about twenty minutes after both cells had
finished and passed. A process check whose pattern appears in its own command line never terminates.

## Not settled here

- One repetition per cell. The loaded −50.5 % and the fresh +92.5 % are each a single observation.
- The plan differing between gates is not explained. The planner does not know Gate B exists, so the 2 → 13 split may
  be ordinary run-to-run variation in planning rather than anything the gate caused, and one run cannot separate them.
- `FACT_TRUE` 0.6 and `FACT_NOT_AGAINST` 0.5 remain uncalibrated, now with one end-to-end run behind them instead of
  none.
- Gate A still admits nothing on its own; every row here sits on the forced arm.


## Update — 2026-09-19, after the primed run

Both rows above are single observations on a case that primed inside the job turn. The primed run
(`bench/results/v5-depth-primed-2026-09-19`) since measured the same job at a real prompt-time depth and found the job
turn **−53.5 %** over two repetitions, and it also found what dominates the spread: **worker count**. The same case
cost $3.0022 with 13 workers and $1.2338–$1.2766 with 4. The −50.5 % and +92.5 % here each came from a cell whose
worker count was not controlled, so they are a direction, not a size — which is what the worker-count limit recorded
in this file's own trailers was already saying.
