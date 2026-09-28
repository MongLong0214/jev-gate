# The shape of the question: option order, and asking whether it can answer — 2026-09-19

Two claims from a field write-up the owner passed on, tested against **this repository's own shipped question** and the
same 61 real prompts used elsewhere in these results. Both reproduce, and one of them weakens a conclusion drawn
earlier in this investigation.

## 1. Option order changes the answer

Same question, same instructions, same prompts — only the order the four options are written in differs:

| ordering | answers | admitted at 0.8 |
|---|---|---|
| shipped (`direct, orchestrated, needs_context, abstain`) | direct 36 · orchestrated 9 · needs_context 13 · abstain 1 · unparseable 2 | 0 / 61 |
| reversed | direct 34 · orchestrated 5 · needs_context 20 · unparseable 2 | 0 / 61 |
| swapped pairs | direct 40 · orchestrated 7 · needs_context 13 · abstain 1 | 0 / 61 |

| | answers that changed |
|---|---|
| shipped vs reversed | **11 / 61 (18 %)** |
| shipped vs swapped | **7 / 61 (11 %)** |

The write-up reported 7 of 120 (5.8 %) from a four-option reshuffle. On this question it is two to three times that.

**This weakens an earlier claim here.** `v5-wide-2026-09-18/GATE-A-ON-REAL-WORK.md` reports a choice distribution —
"Jev answered `orchestrated` on 8.2 % of typed prompts" — from a single ordering. That distribution moves by 11–18 %
under reordering and should not be read as a property of the model. What *is* stable is the number that mattered:
**every ordering admitted 0 of 61 at the 0.8 floor.** The headline survives; the breakdown behind it does not.

## 2. The escape hatches absorb answers the model can make

`admission.ts` offers `needs_context` and `abstain` alongside the two real options, and `allocation.ts` offers
`abstain` as a fifth tier. Those are the "can you answer this?" options the write-up says not to ask for, on the
grounds that a model does not know what it does not know.

On these 61 prompts, **14 (23 %) took an escape hatch**, plus 2 more that came back unparseable. Removing the hatches
entirely, leaving only the two options code can act on:

| | result |
|---|---|
| where the 14 went | **`direct` 10, `orchestrated` 4** |
| their confidence, now that they had to answer | max **0.99**, median 0.55 |
| unparseable answers | 2 → **0** |
| admitted at the 0.8 floor | 0 → **1** |

They could answer. One of them at 0.99. The hatch was not protecting the decision, it was collecting answers that the
floor would have sorted — and the two-option arm is the only one in this file that admits anything at all.

That matches the mechanism the write-up describes and the design the docs describe: every option should be something
code can execute, and *whether to trust the answer* is the confidence's job, not another option's.

## What this suggests, and what it does not

It suggests three changes to how the questions are written, none of which touches a declared floor:

1. **Drop `needs_context` and `abstain`** from the option sets; let the confidence and the code decide what to do with
   a weak answer. `decideAdmission` already maps both to `direct` — the same place a low-confidence answer goes — so
   the options buy nothing that the floor does not already provide.
2. **Fix the option order deliberately**, and record that a reordering changes 11–18 % of answers so nobody treats the
   current order as neutral.
3. **Never quote a choice distribution from one ordering** without saying which ordering produced it.

It does not suggest that any of the savings measured elsewhere in these results depend on this. Those came from the
forced arm, which asks Gate A nothing.

## Not settled here

- One question, one model version, 61 prompts, one repetition per ordering. Order sensitivity of 11–18 % is itself a
  single measurement and could be lower or higher on a rerun.
- Only two of the six orderings of four options were tried, plus one two-option variant. The spread across all 24 is
  unknown, and the two sampled differ from each other as much as from the shipped one.
- Removing the hatches was measured on the admission question only. `ROUTE_QUESTION`'s `abstain`, and the result
  gate's, are untested.
- Nothing in `src/` changed. `ADMISSION_ANSWERS` and `ROUTE_ANSWERS` are part of the declared contract.
