# Stage 1 — the run asked about cost and answered about reliability (2026-09-19)

Pre-registration: `bench/results/v5-context-vs-decomposition-2026-09-19/PREREGISTRATION.md`, committed before the
run (`eba6a98`, `3a18348`, `fecbc15`). Plugin build: `2042170`. Six cells, one job, three arms, two repetitions.
Owner approved stage 1 directly before any cell ran.

## Result — no cost comparison is reported, by rule 3

| arm | cells | valid | checker | plan | workers |
|---|---|---|---|---|---|
| `sonnet_native` | 2 | 2 | **2/2 pass** | — | 0 |
| `jev_single` | 2 | 2 | **2/2 pass** | none by construction | 1, 1 |
| `jev_hierarchy` | 2 | 2 | **1/2 pass** | 3 tasks, 2 tasks | 3, 2 |

All six cells are valid: `context_at_job_prompt` 387,539–388,579 (rule 1 floor is 250,000), no truncation, no
environment error, `exit=0` everywhere, usage complete.

**The arms differ in pass count on this job, so rule 3 withholds the cost comparison for it.** Rule 4's prediction
table cannot be adjudicated either: every row of it is a statement about all three arms, and one of the three is
quality-broken here. The table is not extended, reinterpreted, or partially filled.

One reading of rule 3 would allow a `jev_single` vs `sonnet_native` comparison on its own, since all four of those
cells passed. **That reading was considered and rejected rather than taken**, because choosing between two readings
of a rule after seeing which one pays is exactly what rule 9 forbids. Claiming that comparison legitimately needs a
new pre-registration that declares it in advance, or a `jev_hierarchy` arm that reaches 2/2.

## What the failure actually was — not dropped scope

The failing cell (`jev_hierarchy` r1) did **not** miss a module. All twelve modules reject an empty array. The
checker's `empty_rejected_everywhere` requires `{ ok:false, field:'<name>', reason:<non-empty string> }`, and all
twelve returned `{ ok:false, field:'<name>' }` with **no `reason`** — a uniform miss, not a scattered one.

The cause is in the plan, verbatim. Its `spec.data_shapes`, repeated identically in both worker tasks:

```
"new empty-array case: { ok:false, field:'<name>' }"
```

and its interfaces: `validateEmail(submission) … returns { ok:false, field:'email' } when the array is empty`.

The request never mentions `reason` for the new case — it says "반환값에 field 는 그대로 두고 ok:false 로". It is
silent, and the surrounding code answers the question: the two existing failure paths return `reason:'missing'` and
`reason:'blank'`. `sonnet_native` and `jev_single` both wrote `reason:'empty'` in all twelve modules. The r1 planner
instead wrote the request's literal words into the contract, and the workers implemented the contract exactly.

The passing `jev_hierarchy` cell (r2) shows the same machinery getting it right, and shows what the difference was —
its plan says:

```
"failure: { ok: false, field: <name>, reason: 'missing' | 'blank' | 'empty' }"
"new case: entries is an array of length 0 -> reason 'empty'"
```

**So the mechanism is not "splitting drops scope". It is "the plan resolves what the request leaves open, and freezes
that resolution".** A request that is silent stays silent for an executor reading the code; for a planner it becomes
a line in a contract, and whichever way it is resolved, every worker then implements that resolution uniformly.
Task count is not the discriminator: r1 split 12 modules 6/6 plus a final gate task, r2 split them 6/6, and the
difference between them is a line of `data_shapes`, not a number of tasks.

## The acceptance check cannot catch this

`jev_hierarchy` r1: **receipts `accept: 3`**, plan status `ready`, job outcome `completed`. Every worker reported
done, every receipt was accepted, and the plan's own third task was a "final gate" whose check was `npm test` — which
passed, because the tests the workers wrote assert what the contract said. The job called itself finished and the
checker disagreed.

This is not a bound that was hit or a receipt that was too generous. **The contract was satisfied and the contract
was wrong**, so there is no acceptance rule at the receipt layer that would have caught it. Anything that catches it
has to compare the plan against the request, which is the gap `r-replanbound` already named and which is still open.

## Mechanism counts (rule 6 — recorded whatever the cost shows)

| arm | rep | Read calls | distinct paths | Bash calls | test-suite runs | Write | Edit | workers | plan size | planner $ |
|---|---|---|---|---|---|---|---|---|---|---|
| `sonnet_native` | 1 | 14 | 14 | 33 | 1 | 11 | 13 | 0 | — | — |
| `sonnet_native` | 2 | 14 | 14 | 32 | 1 | 11 | 13 | 0 | — | — |
| `jev_single` | 1 | 16 | 16 | 36 | 2 | 11 | 13 | 1 | none | $0 |
| `jev_single` | 2 | 17 | 14 | 33 | 2 | 11 | 13 | 1 | none | $0 |
| `jev_hierarchy` | 1 | 42 | 26 | 44 | 10 | 11 | 13 | 3 | 3 tasks | $0.4157 |
| `jev_hierarchy` | 2 | 30 | 16 | 39 | 6 | 11 | 13 | 2 | 2 tasks | $0.3773 |

Every arm produced the same 11 writes and 13 edits: the work itself is the same size in all three shapes.

**The `DIAGNOSIS.md` duplication mechanism reproduces cleanly and is ungated by rule 3.** `jev_single` reads 16 files
across 16 distinct paths — one worker, no duplication. `jev_hierarchy` r1 reads 42 across 26 — three workers each
rediscovering shared context. Test-suite runs scale the same way: 1 (native), 2 (single), 6 and 10 (hierarchy), one
suite run per worker plus the gate task's own.

`chain_depth`: 1 for r2 (two independent tasks), 2 for r1 (t3's final gate depends on t1 and t2).

Gate A admitted the job on its own in all four plugin cells (`orchestrated:2` per arm, no forcing). Gate B patched
both `jev_single` dispatches and preserved all five `jev_hierarchy` dispatches (`route_low_confidence:5`).

## Job-turn dollars — a record, not a comparison

Preserved under rule 8 because failures and their causes are published with their numbers. **No percentage is quoted
from them and no pair of them is a comparison**, for the reason in the first section.

| arm | rep | priming (cumulative) | job turn | wall s | turns |
|---|---|---|---|---|---|
| `sonnet_native` | 1 / 2 | $2.8479 / $2.8418 | $2.7092 / $2.6237 | 144.8 / 329.3 | 42 / 41 |
| `jev_single` | 1 / 2 | $2.8471 / $2.8522 | $0.7255 / $0.9927 | 173.3 / 188.4 | 5 / 8 |
| `jev_hierarchy` | 1 / 2 | $2.8474 / $2.8472 | $1.6297 / $1.3324 | 440.3 / 283.1 | 8 / 7 |

## `jev_single` behaved as defined

Per cell: `execution: "single"`, `plan: null`, exactly one `jev-gate:worker` agent call, no planner call, no receipt
path, config override sha256 `c24c3ef72691` identical in both cells and differing from the frozen config in
`admittedShape` alone.

**Defect found in its instrumentation, not fixed here:** the single shape has no receipts, so the job outcome stays
`incomplete` after a successful run and the report counts its two worker records as orphans. The work finished and
passed; the bookkeeping has no way to say so. Recording it, not repairing it after seeing results.

## What this does and does not support

- It does **not** support changing `admittedShape`'s default to `single`. The evidence is four cells of reliability
  and a cost comparison that rule 3 forbids reporting.
- It does **not** leave the shipped `hierarchy` default well-supported either. On this build, on the job this
  repository's headline came from, it failed the checker in one of two cells while both other shapes passed twice.
  Neither default is supported by this run; that symmetry is the accurate statement.
- Earlier recorded `jev_hierarchy` cells on this same job passed 2/2, on a build three commits older
  (`v5-gate-a-live-2026-09-19/run-deep.json`). Counting only this run's cells would overstate the failure rate;
  counting across builds would compare different products. Both are stated rather than merged.

## Not settled here

- Whether the r1 contract's silence about `reason` is a planner-prompt problem, a spec-vocabulary problem, or noise
  in one sample. One failing cell is one failing cell.
- Whether `jev_single` is cheaper than either other arm. Rule 3 withholds it, and this run cannot say.
- Stage 2 (`orbit-core`) is not run. It needs its own approval, and after this result it needs a different question
  first: a run designed around cost cannot be the run that answers a reliability question.
