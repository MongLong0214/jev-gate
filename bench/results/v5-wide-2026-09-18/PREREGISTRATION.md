# Pre-registration — does orchestration ever win? 2026-09-18

Written **before the run**, because the criterion is the thing that must not move afterwards.

## Why this run exists

The four existing bench jobs are single-file bug fixes. Run on 2026-09-18 (`v5-dogfood-0918`), `jev_hierarchy` and
`sonnet_native` each passed 4/4, and the report's own conclusion was **"no admission exposure — Gate A never admitted a
prompt as orchestrated."** Jev answered `direct` on all four, which is the right answer for those jobs, so the two arms
ran the same execution shape and the 5 % cost gap between them is sampling noise, not routing.

V4's recorded result points the same way from the other side: forced delegation cost **37.7 % more**. With
`maxParallelWorkers: 1` orchestration buys no parallelism, so on a short single-outcome job it can only add planning and
handoff overhead.

So the open question is not "is Jev's judgment good" — it answered correctly four times out of four. It is **whether a
job exists where orchestration is the cheaper shape, and whether Gate A finds it.** Nothing in this repository has
tested that, because nothing in the fixture set is compound.

## The job

`wide-validators`: twelve independent modules sharing one latent defect — an empty array is accepted where at least one
entry is required. Twelve outcomes, no coupling between them, each verifiable on behaviour. Also realistic for the
operator whose sessions motivated this: a consistent change applied across many files is what their transcripts are
full of.

Checker: `bench/checkers/wide-validators.mjs`, eight checks. Three of them assert the behaviours that were already
correct still hold in all twelve modules, so a candidate cannot pass by loosening the validators. `tests_detect_bug`
runs the candidate's own tests against the unfixed source and requires them to fail, so adding an empty test file does
not count. Verified before the run: fails on `bench/fixtures/wide-validators`, passes on
`bench/reference/wide-validators`, and `tests/bench-fixtures.test.ts` is green at 15 tests.

## Arms

`sonnet_native` (no plugin) and `jev_hierarchy` (plugin, `mode=auto`). Defaults elsewhere — no floor, checker or
threshold is touched for this run. `maxParallelWorkers` stays at 1: raising it would change the mechanism under test.

## What counts as which result, decided now

| outcome | reading |
|---|---|
| Gate A admits `orchestrated` **and** `jev_hierarchy` costs less at equal pass rate | routing pays on compound work; report the size and the conditions |
| Gate A admits `orchestrated` **and** `jev_hierarchy` costs the same or more | the shape Gate A identifies is not the cheaper shape — a negative result about orchestration, not about Jev's judgment |
| Gate A answers `direct` again | Gate A does not classify twelve independent outcomes as compound; a negative result about Gate A's criterion, and the admission question is where the work goes next |
| pass rates differ | cost is not comparable; say so and compare nothing else |

**One repetition per arm.** A single sample cannot separate a small effect from noise — the 2026-09-18 run showed a 5 %
gap between two identical mechanisms. So anything under roughly 20 % is reported as "not distinguishable at n=1"
regardless of its sign, and a real effect gets repetitions before it gets a claim.

The Jev calls themselves are not a cost question: the four-job run spent **$0.000115** across all of Gate A, or 0.019 %
of the Claude bill. Asking is free; the only thing that can be expensive is the shape the answer chooses.
