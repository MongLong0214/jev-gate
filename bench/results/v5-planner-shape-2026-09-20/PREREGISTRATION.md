# Pre-registration — does naming the rule change what the planner writes? (2026-09-20)

Written and committed **before any run and before `agents/planner.md` is edited**, because `r-silencenull` ruled out
changing that file on the strength of the silence run: *"this run did not test a planner change and cannot stand in
for one."* This registration is that test. Nothing below is adjusted after seeing a result.

## The mechanism, restated more precisely than before

Earlier readings of `v5-context-vs-decomposition-s1-2026-09-19` called this "the request is silent and only the code
knows". Reading the frozen request shows that is not what happened.

The request (sha256 `7da6dd0a3d49742d0e067df99f1f2192613c0c5633def2cca31895c657ca8396`, 554 bytes, case
`wide-validators` in that run's own `inputs/bench/cases.json`) says, in consecutive sentences:

```
지금은 빈 배열이 통과되는데, 항목이 하나도 없으면 실패해야 해. 반환값에 field 는 그대로 두고 ok:false 로.
이미 맞는 동작(항목이 있으면 통과, 빈 문자열이면 blank, 키가 없으면 missing)은 바꾸지 마.
```

**The request names `blank` and `missing` one line after the new case.** And every module in the fixture returns
`{ ok:false, field, reason }` on every failure path:

```js
if (!Array.isArray(entries)) return { ok: false, field: 'country', reason: 'missing' };
```

So the failure shape is established twice over — in the request and in all twelve modules. The failing plan's
`data_shapes` still read:

```
"new empty-array case: { ok:false, field:'<name>' }"
```

**The planner wrote the new case's shape by transcribing the sentence that introduced it.** That sentence describes
what *changes*, not the whole shape. The passing cell's plan instead wrote
`failure: { ok: false, field: <name>, reason: 'missing' | 'blank' | 'empty' }`.

This is a sharper hypothesis than "silence", and a narrower one: **a new case of an existing shape lost a field its
sibling cases carry.**

## The change under test

One paragraph added to `agents/planner.md`, immediately after the sentence beginning "When you do supply `spec`".
Its exact text, fixed here before it is written to the file:

> A `data_shapes` entry for a new case of an existing shape carries every field the existing cases carry. The
> sentence in the request that introduces a new case describes what changes, not the whole shape: writing only the
> fields that sentence names turns an omission into a specification, and every worker then implements it uniformly
> and writes tests that agree with it. Read the existing cases in the code and complete the shape from them. If you
> leave a field out deliberately, say so in `assumptions` and name the field.

Nothing else in the file changes. No default, no config value, no floor.

## Instrument

Direct `jev-gate:planner` invocations against a copy of the frozen fixture, one plan per invocation, plan JSON only.
No workers run and no checker runs, so no cell can pass or fail a job here.

- arms: `shipped` (`agents/planner.md` at sha256 `fb6350bd36f26fde…`) and `amended` (that file plus the paragraph above)
- 4 invocations per arm, 8 total
- the request is the 554 frozen bytes above, verbatim; the fixture is copied read-only and not modified

**Fidelity limit, stated before the run:** the coordinator composes more around the request than a direct invocation
carries. `r-reqcarry` and `r-tiersite` record that the coordinator pasted the full spec to the planner on call 1 and
not on a 771-char replan, so the request reaching the planner is the same text on a first call and this instrument
matches that case and not the replan case. A result here is about the planner's own prompt, not about the pipeline.

## Primary outcome, scored by a rule fixed now

For each plan, take every string in `constraints`, `tasks[].constraints`, `tasks[].spec.data_shapes` and
`tasks[].spec.interfaces`. Consider the ones that mention the new case (matching `빈 배열`, `empty array`, `empty`,
or `length === 0`). Score the plan:

| score | condition |
|---|---|
| `carries_reason` | at least one such string contains the token `reason` |
| `drops_reason` | such strings exist and none contains `reason` |
| `no_shape` | no such string exists |

`carries_reason` does not require a particular reason value. The checker accepts any non-empty string
(`wide-validators.mjs:50`), so requiring `'empty'` specifically would be a stricter rule than the job's own.

## Decision table

| shipped `drops_reason` | amended `drops_reason` | reading |
|---|---|---|
| ≥ 2 of 4 | 0 of 4 | the paragraph moves the mechanism at plan level; **Stage B is worth asking for** |
| ≥ 2 of 4 | ≥ 2 of 4 | it does not move it; **stop, record, and do not edit `agents/planner.md`** |
| ≥ 2 of 4 | exactly 1 of 4 | moved but not closed; record the count and ask before anything further |
| 0–1 of 4 | any | **the mechanism does not reproduce at plan level on this job; Stage A cannot answer.** Stop |

The last row is expected to be live: the original run failed 1 of 2 hierarchy cells, so the base rate may be near a
half, and 4 repetitions cannot separate a half from a third. If the shipped arm drops the field 0 or 1 times, this
registration has measured that its own sample is too small and says so rather than reading the amended arm against it.

## Validity

- The request bytes, the fixture and the scoring rule are frozen by this commit. None is adjusted afterwards.
- An invalid invocation — `blocked`, `needs_context`, or no JSON object — is **named, not retried and not replaced**.
- One attempt at the whole thing. An arm is not re-run because its numbers were unwelcome.
- The amended paragraph is the text above, verbatim. If the file ends up with different words, the run is void.
- Stop at **$6**. If the eighth invocation would cross it, the run stops short and reports how many cells it has.

## What this cannot establish, whatever it shows

- **That a plan carrying `reason` produces a passing job.** Only execution and the checker can, and neither runs here.
  A plan that says the right thing is not a job that did the right thing.
- **Anything about other jobs.** This is the job that generated the hypothesis. A result here is necessary, not
  sufficient, and a second job would be a different registration.
- **That the paragraph is the best wording.** It tests one wording once. A better one is not ruled out by this.
