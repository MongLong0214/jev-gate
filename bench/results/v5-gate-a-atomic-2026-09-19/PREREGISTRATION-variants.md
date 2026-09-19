# Pre-registration — what to do about `missing_reference`, written before measuring the variants (2026-09-19)

The shipped composition admits 1 of 63 because `missing_reference` sits above the veto on 61 of 63. The question is
what replaces it. This file fixes the criterion before either variant is measured, so the choice is not made by
picking whichever number looks better afterwards.

## Why a change is in scope at all

The drop rule in the guide was written before any of this was seen, and it is about discriminating power: `separable`
was dropped at 0/61 decisive and `mechanical` at 5/61. `missing_reference` is decisive on 4 of 63 — the same range.
It was kept for a functional reason, that it maps to today's `needs_context`, and the measurement contradicts that
reason: it does not identify requests that lack a reference, it is mildly true of nearly every real prompt, because a
prompt typed in a working session nearly always points at the file, the run or the thread it follows.

So the change is an application of the pre-existing drop rule to a question that now has data, not a threshold moved
to get a nicer count. `FACT_TRUE` and `SIZE_FLOOR` are not touched in either variant.

## The two variants

- **A — drop it.** Vetoes become `forbids_delegation` and `answer_only`, plus the `size` low-end veto.
- **B — re-word it.** Keep the question, but ask what `needs_context` actually needs: whether the request can be
  identified at all from what is here, rather than whether it points outside itself. Wording, fixed now:
  *"What this request is asking for cannot be worked out from the request itself, even by someone who knows the
  project well."*

## The criterion, fixed now

Measured on the same 63 prompts at their recorded depth, plus two ground-truth prompts appended to the set:
`GT-deep` (the wide-validators job text, at 406,000) and `GT-small` (a four-word follow-up, at 657,000).

1. `GT-deep` must be admitted and `GT-small` must be refused, in whichever variant is chosen.
2. Among prompts at or above the depth floor, the admitted share must be **above 20 % and below 95 %**. Below 20 % the
   gate is still closed; above 95 % it is not a gate at all and the depth floor is doing everything.
3. If both variants satisfy 1 and 2, **A is chosen** — fewer questions, and the guide's own drop rule applies to it.
4. If neither satisfies 1 and 2, neither is adopted: the shipped default stays composite and the result is recorded
   as a second refutation rather than a third attempt.
5. Whatever is adopted, `admissionQuestionShape` stays `composite` by default until an end-to-end run at real depth
   shows an admitted job costing no more than the forced arm.
