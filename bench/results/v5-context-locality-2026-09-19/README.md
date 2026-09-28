# Delegation pays, at the depth it is actually used at — 2026-09-19

`PREREGISTRATION.md` was committed before this run. It predicted that forced orchestration would cost **more** on a
fresh session and **less** on a loaded one, and named the sign flipping between the two as the only thing that would
count at one repetition. It flipped.

## Result

Identical work, identical checker, all six cells passing:

| job | arm | main-session peak | main turns | cost |
|---|---|---|---|---|
| `wide-validators` | `sonnet_native` | 55,718 | 40 | **$0.3148** |
| (fresh, X ≈ 55K) | `jev_hierarchy` | 57,838 | 42 | $0.3285 |
| | `jev_forced_orchestration` | 49,434 | 6 | **$0.8888** — **+182 %** |
| `wide-validators-loaded` | `sonnet_native` | **406,218** | 74 | **$6.2851** |
| (loaded, X ≈ 406K) | `jev_hierarchy` | 407,718 | 71 | $5.1444 |
| | `jev_forced_orchestration` | **127,216** | 8 | **$2.6922** — **−57 %** |

The mechanism is visible in the peak column, not just in the price. Both loaded arms read the same 30 reference files
in the main session. `sonnet_native` then did the job there too and finished at **406,218** tokens a turn.
`jev_forced_orchestration` dispatched seven workers instead and its main session never passed **127,216** — the work
happened in sessions that start at their own prefix and do not inherit the conversation.

That is the arithmetic in the pre-registration doing what it said: `saving ≈ (T − 2)·X − T·P`, which is negative at
X ≈ 55K and strongly positive at X ≈ 406K.

## What this does and does not establish

**It does** establish that the execution layer works and that delegation's cost depends on the depth it is used at, not
just on the job. **Every earlier comparison in this repository, including V4's "forced delegation cost 37.7 % more",
was run at X ≈ 44K** — within noise of the worker's own prefix, where the arithmetic says no saving can exist. That
number was a fact about the harness, not about delegation.

**It does not** establish a magnitude. One repetition per cell, and the 2026-09-18 runs showed ±5 % between two
mechanically identical arms. The 57 % and the 182 % are a direction with a plausible mechanism, not a claim; the sign
flip is the result, and repetitions are the next thing this needs.

**It is also not, by itself, a Jev result.** The saving came from `jev_forced_orchestration`, the diagnostic arm that
starts an orchestrated job *without asking Gate A*. What it shows is that the branch Jev is supposed to choose between
has a real and large cost difference — in both directions.

## Where Jev's value actually sits, now that both branches are measured

+182 % at 55K and −57 % at 406K. Always orchestrating loses on shallow work; never orchestrating loses the 57 %. **The
whole value of the gate is getting that call right**, and the two measurements give it something to be right about for
the first time.

`jev_hierarchy` answered `direct` on both jobs, as it has on every job and every real prompt put to it, so it captured
none of either. And the reason is visible in `admission.ts`:

```js
state: { request: prompt, available_execution: AVAILABLE_EXECUTION }
```

**Gate A is not shown how full the context is.** The variable that decides which branch is cheaper — by a factor of
four, in this run — is not in its input. It is asked to choose between two options whose relative cost it cannot see.

That is a smaller and more specific gap than "Gate A is miscalibrated", and unlike the prompt-visibility problem in
`v5-wide-2026-09-18/GATE-A-ON-REAL-WORK.md` it does not touch what the user's text discloses: context depth is a
number, not content.

## Not settled here

- One repetition. The next run is repetitions of the loaded cell, not a new question.
- Runtime moved the wrong way in both conditions (199 s against 91 s fresh; 386 s against 325 s loaded), so this is a
  token result and not yet a speed one. With `maxParallelWorkers` at 1 the workers run in series, which is the obvious
  place to look.
- The loaded job reaches 406K in the native arm, above the 300K auto-compact window now configured. Compaction did not
  fire before the job finished, but a longer job would have crossed it, and that interaction is untested.
- Whether Gate A given the depth would answer differently is the next experiment and is replayable offline against the
  recorded sessions.


## Update — 2026-09-19, after the primed run

The −57 % row above is a whole-session comparison where priming and work happened in **one turn**, so at
`UserPromptSubmit` the session still looked fresh. `bench/results/v5-depth-primed-2026-09-19` re-ran the same job with
the priming in its own turns, charged to both arms, and compared the job turn alone: **−53.5 %, two repetitions, four
valid cells, all checks passing**. The direction and roughly the size hold, and this time the depth is real at the
moment the gate would be asked.

One reading that turned out to be wrong is worth recording, because it was made here and corrected there: the −57 %
was *not* an artefact of priming cost landing on the native arm. The one run that measured only −10.1 % differed in
worker count (13 against 4), not in how priming was charged. Worker count is what moves this number.

The runtime warning above still holds, and got worse before it got better: +196 % wall in the run with 13 workers,
+47.8 % in the two-repetition run with 4.
