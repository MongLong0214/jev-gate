# Where a plan's assertions go unquestioned (2026-09-20)

**No pre-registration, because nothing was spent.** This is a census of artifacts already on disk: every adopted plan
this project has kept, and what the shipped A23 comparison would and would not ask about each one. It sends no
request, runs no cell, and states no cost. Reproduce with `node scripts/plan-corpus.mjs --out corpus.json`.

The script imports `interpretationClauses` and `proposedInterfaces` from `dist/`, so the clause counts below are the
ones the shipped code builds, not a re-implementation of it.

## The corpus

17 cells across 7 runs carry an adopted plan. **Every one has its request bytes recovered from that run's own frozen
inputs and verified by sha256 against the cell's recorded `request_sha256`** — a case id alone is not evidence the
bytes match, since ids are reused across runs and manifests change. 0 cells failed that check.

| | |
|---|---|
| cells with an adopted plan | 17 |
| request-verified | 17 |
| checker grade | **pass 15, fail 2** |

## Result — A23 questions 93 plan clauses and leaves 701 unquestioned

| what the plan asserts | count | does A23 ask about it |
|---|---|---|
| `constraints` within the clause cap | **93** | **yes**, one question each |
| `constraints` over the cap | 0 | no — but the cap never binds on this corpus |
| `spec.interfaces` | **233** | **no.** Sent to the gate as `proposed`, never the subject of a question |
| `spec.data_shapes` | **217** | **no.** Not sent at all |
| `spec.invariants` | **251** | **no.** Not sent at all |

`MAX_INTERPRETATION_CLAUSES` is 12 and no plan in the corpus carries more than 8 constraints, so **the clause cap is
not what limits coverage. The field selection is.**

This is not an argument that all 794 should be asked about. Most of those entries are unremarkable and asking about
each one would cost more than it returns. The finding is narrower and it is about one field in particular.

## The one defect whose mechanism is known lives in the unquestioned part

`v5-context-vs-decomposition-s1 / wide-validators-primed-30 / jev_hierarchy / 1`, the cell that failed
`empty_rejected_everywhere`:

| | |
|---|---|
| `constraints` A23 would ask about | **5 — and all 5 are supported by the request** |
| `spec.interfaces` sent but unasked | 12 |
| `spec.data_shapes` not sent | 8 |
| `spec.invariants` not sent | 7 |

The wrong assertion was `"new empty-array case: { ok:false, field:'<name>' }"` in `spec.data_shapes`, repeated
identically in both worker tasks, and `returns { ok:false, field:'email' } when the array is empty` in
`spec.interfaces`. Neither is a constraint. **Run today, A23 would ask its five questions, receive five clean answers,
record `applied: false`, and the plan would be adopted exactly as it was.**

The `spec.interfaces` half is the sharper version: that text *was* in the payload, inside `proposed`. The gate was
holding the evidence and had no question pointing at it.

## Why the request's own words are not enough either

The request is silent about `reason` for the new case. It says only `반환값에 field 는 그대로 두고 ok:false 로`. So the
correct verdict for that clause under the current vocabulary is `omitted`, and `omitted` is a verdict no reader acts
on. The answer the passing cell used — `reason:'empty'`, matching the existing `'missing'` and `'blank'` paths — is in
the **source**, and `src/interpretation.ts` already records the limit that matters here: *"The hook has no repository
access, so the comparison sees the request, the plan and the proposed interfaces and no source evidence at all."*

So there are three independent reasons the shipped comparison cannot catch this defect, and closing any one of them
alone does not close it.

## What this does not establish

- **Not a detection rate.** One cell in this corpus failed by this mechanism. One cell is one cell, and a rate cannot
  be estimated from it. The second failing cell (`v5-job2-orbit` h1) failed 10 checks with 6 more not evaluated and is
  the cell that reached the replan bound — a different mechanism, not counted as this one.
- **Not a reason to change A23, `applied: false`, or `agents/planner.md`.** This says where the gap is, not that any
  particular question would close it. A classifier asked about 233 more entries per plan is an unvalidated classifier
  asked more often.
- **No cost claim of any kind.** None was measured and the project's earlier percentages remain withdrawn.

## What it does make possible

A labelled corpus that did not exist before, at no cost: 17 adopted plans, each paired with the exact request bytes
that produced it and the checker's verdict on what the workers built from it. The decision-relevant number for any
candidate detector is its **false-positive rate on the 15 passing plans**, and that can now be measured against a
fixed set rather than argued about.

**A run that spends anything to measure that gets a pre-registration first**, declaring which cells are valid and
which outcome becomes which conclusion, before any call is made.
