# The atomic Gate A, replayed offline — the composition refuses almost everything — 2026-09-19

Step 3 of `DECISION-depth-gate-2026-09-19.md`, offline half. The shipped `decideAdmissionAtomic` was run against 63
real prompts paired with the context depth each was actually typed at, through `scripts/gate-a-atomic-replay.mjs`,
which imports the decider from `dist/` rather than re-implementing it.

## Result

| | |
|---|---|
| prompts | 63 (p10 296K, median 657K, p90 925K) |
| **admitted** | **1** |
| refused: `admission_needs_context` (missing_reference veto) | **45** |
| refused: `admission_answer_only` | 9 |
| refused: `depth_below_floor` | 8 |

Fable predicted "a similar count" to the offline rule's 43/61. The composition admits **1 of 63**.

## Why: one of the four questions is nearly a constant

| question | min | p25 | median | p75 | max | ≥ 0.6 |
|---|---|---|---|---|---|---|
| `missing_reference` | 0.52 | 0.72 | **0.77** | 0.81 | 0.89 | **61 / 63** |
| `answer_only` | 0.04 | 0.10 | 0.19 | 0.43 | 0.84 | 10 / 63 |
| `forbids_delegation` | 0.04 | 0.12 | 0.14 | 0.17 | 0.47 | **0 / 63** |
| `size` (0–4) | 0.13 | — | 1.97 | — | 3.98 | 14 below 1.0 |

`missing_reference` never drops below 0.52 and sits above the veto on 61 of 63 prompts. The answer is not wrong: a
real prompt in a working session nearly always points at something the prompt text does not contain — the file just
discussed, the run just finished, "이거", "계속". Gate A sees only the prompt, so "it points at something not included
here" is simply true almost always, and as a veto it closes the gate.

The decision table in the guide already carried the warning — *"8/61, never below 0.52"* — but read it as a question
that rarely fires. It rarely fires **decisively**; it is almost always mildly true, and `FACT_TRUE = 0.6` sits below
where it lives.

`forbids_delegation` never reached the veto in 63 prompts either. It does no harm, and the sharpened wording is still
the right one, but nothing in this sample exercised it.

## What this does and does not settle

- **The thresholds were not moved after seeing this.** `FACT_TRUE = 0.6` and `SIZE_FLOOR = 1.0` were fixed before the
  replay and stay fixed; this file records a refuted prediction, not a retuned gate. `admissionQuestionShape` remains
  `composite` by default, so nothing shipped changes behaviour.
- **It does not show the atomic shape is wrong**, only that this composition of it is. Three of the four questions
  behave; one is a constant in this population and is being used as a veto.
- **It does not compare against the composite gate end to end.** Offline, the composite admitted 0 of 61 when depth
  was supplied; this admits 1 of 63. Neither opens the gate.
- The eight `depth_below_floor` refusals are the depth test working as designed and are not a Gate A judgement at all.

The next decision — whether `missing_reference` should be dropped, re-worded, or given a different threshold — is not
one to make by adjusting a number against this result. It goes back to Fable with the measurement.
