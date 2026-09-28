# Pre-registration — can a request-vs-plan classifier see a silence filled wrongly? (2026-09-20)

Written and committed **before any request is sent**. The corpus it runs on is frozen at `5f82fa6`
(`bench/results/v5-plan-silence-2026-09-20/corpus.json`, 17 request-verified cells).

## The question

Stage 0 established that the shipped A23 comparison never questions `spec.data_shapes`, and that the one cell whose
failure mechanism is known carried its wrong assertion there while all five of its constraints were supported by the
request. The obvious next move is to extend the comparison to that field. **This run exists to find out whether that
would work, before anything is built into the product.**

Concretely: given the request and the plan and nothing else, can a classifier separate the plan that filled the
request's silence **correctly** from the plan that filled it **incorrectly**?

The two cells are the natural pair. Same job, same request bytes, same run, adjacent repetitions:

| cell | what it wrote for the silent case | checker |
|---|---|---|
| `v5-context-vs-decomposition-s1` h1 | `new empty-array case: { ok:false, field:'<name>' }` | **fail** |
| `v5-context-vs-decomposition-s1` h2 | `new case: entries is an array of length 0 -> reason 'empty'` | pass |

## Prediction, recorded in advance: **it cannot separate them**

The request is silent about `reason` in both cases. Both plans resolved that silence; one resolution matched the
surrounding code's `'missing'` / `'blank'` paths and one did not. **That difference is visible only against the
source, and `src/interpretation.ts` already records that the hook has no repository access.** So the expected result
is that both cells receive the same verdict and the axis does not discriminate.

**This prediction is the reason to run it rather than a reason not to.** If it holds, the branch "extend the plan
comparison to more fields" is closed with a measurement instead of an argument, and goal 1 moves to the planner --
the only component in the system that reads the repository. If it fails, and the classifier does separate them, that
is a surprising positive that would justify a larger pre-registered measurement.

## What is asked

One request per plan, with one question per `spec.data_shapes` entry, capped at 12 entries per plan exactly as the
shipped clause cap works. Entries beyond the cap are counted as unasked and named, never silently dropped.

Verdict vocabulary, fixed here:

| verdict | meaning |
|---|---|
| `stated` | the request states this shape |
| `derived` | the request does not state it, but it follows directly from something the request does state |
| `filled` | **the request is silent about it and this entry commits to a specific resolution anyway** |
| `unknown` | the supplied request and plan are not enough to tell which of the other three holds |

A tie or an unreadable answer is `unknown`, never a weak `filled`. `filled` is the only verdict a reader would act
on, which is the same rule the shipped classifier uses.

## Where it runs

**In a bench script only** (`scripts/plan-silence-replay.mjs`), never in `src/`. The product is not changed by this
run, in either direction of the result. A classifier that has not been measured does not get a place in the hook.

## Validity rules

1. A cell is valid only if its request was sha256-verified in Stage 0 (all 17 were) and its plan carries at least one
   `spec.data_shapes` entry. Cells with zero entries are reported as **not applicable**, not as a clean result.
2. An HTTP failure, a deadline, or an unparseable response makes that cell **invalid**. Invalid cells are named with
   their cause and are **not retried into a better answer**.
3. The corpus is frozen at `5f82fa6`. No cell is added, dropped or re-graded after a result is seen.
4. **The verdict vocabulary above is fixed.** It is not adjusted, renamed or extended after any answer is read.
5. One attempt. There is no second run of this design at a different temperature, model or phrasing.

## Outcome table — fixed before any call

| what is observed | what it means |
|---|---|
| h1 flagged `filled` on its wrong entry **and** h2 not flagged, **and** ≤ 3 of the 15 passing plans carry any `filled` | the axis separates. Justifies a larger pre-registered measurement. **Still does not justify shipping it.** |
| **both h1 and h2 flagged** (predicted) | the axis does not separate. The A23-extension branch is closed; goal 1 moves to the planner side, which needs its own pre-registration |
| **neither h1 nor h2 flagged** | the axis does not see the defect at all. Same closure, different cause — recorded as which |
| more than 3 of the 15 passing plans carry `filled`, whatever h1 and h2 do | the axis is not selective enough to act on, and the closure above stands regardless |

The false-positive count is over the **15 passing plans**, which is the only denominator this corpus supports. With
one known positive, **no detection rate is computed and none will be quoted.**

## Budget and stop

17 requests, one per cell. **Hard stop at $2.** If the run exceeds it, it stops and reports the cells completed rather
than finishing at a higher cost.

## What no result here can support

- Changing `planInterpretation`, its default, its fields, or `applied: false`.
- Changing `agents/planner.md`. That is a separate change and gets its own pre-registration.
- Any cost or performance claim. None is measured, and the project's earlier percentages stay withdrawn.
