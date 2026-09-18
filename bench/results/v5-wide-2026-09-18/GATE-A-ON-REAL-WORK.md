# Gate A, replayed on this operator's own prompts — 2026-09-18

Gate A's entire input is the prompt text: `buildAdmissionRequest` sends `{ request, available_execution }` and nothing
from the repository, transcript or environment. That makes it exactly replayable. So rather than reason about whether
the plugin would engage on real work, the prompts were taken out of the recorded sessions and sent through the shipped
`buildAdmissionRequest → callJev → decideAdmission` path unchanged.

Source: the eleven transcripts over 20 MB — the operator's main interactive sessions. 6,490 typed entries, sampled
evenly across sessions rather than taken in runs. 183 sampled; 110 of those survive a filter for genuine typed requests
(the rest are `Stop hook feedback:` injections, cross-session messages and file attachments, which are `type: user`
entries but not something a person typed). Both sets are reported, because the filter is a judgement.

Prompt text is not published here. `gate-a-replay-*.json` carries the decisions, lengths and confidences only.

## Result

| | all 183 sampled | 110 genuine typed |
|---|---|---|
| Jev answered `direct` | 91 | 60 |
| Jev answered `needs_context` | 60 | 38 |
| Jev answered `orchestrated` | 28 (15.3 %) | 9 (8.2 %) |
| Jev answered `abstain` | 4 | 3 |
| **admitted `orchestrated` after the 0.8 floor** | **0 (0.0 %)** | **0 (0.0 %)** |

The highest confidence Jev ever attached to `orchestrated` was **0.68** across all 183, and **0.67** across the typed
110. The floor is 0.8. Nothing reached it.

Cost of establishing this: 134,089 Jev input tokens for the full sample, about **$0.006**, at a mean of **268 ms** per
gate. Asking is not the expensive part and never was.

## It is not only the floor

The floor is a declared criterion and this run does not move it. But a sensitivity sweep over the same recorded answers
shows the floor is not what is standing in the way:

| floor | admitted `orchestrated` (of 183) |
|---|---|
| 0.8 (shipped) | 0 (0.0 %) |
| 0.7 | 0 (0.0 %) |
| 0.6 | 2 (1.1 %) |
| 0.4 | 9 (4.9 %) |
| **0.0 — no floor at all** | **28 (15.3 %)** |

Even with the gate removed entirely, Jev calls 15.3 % of these prompts compound. The floor turns a small number into
zero; it is not the reason the number is small.

## Why so many `needs_context`

A third of the sample (33 % of all, 35 % of typed) came back `needs_context` — Jev saying the request alone does not
identify the work. That is Gate A behaving correctly on its input. The operator's prompts are conversational
continuations: they refer to what the session was already doing, to a decision two turns ago, to a file mentioned
earlier. Gate A sees one string with none of that, by design (`admission.ts`: "The raw request is the only state;
nothing from the repository, transcript or environment is added").

That design choice is defensible on privacy grounds and it is also what makes the gate blind here. A prompt like
"finish it and then review it before merging" is compound work and unreadable in isolation.

## What Jev does catch

The prompts it did call compound are the right ones. The most confident, at 0.68, asks for repeated deep discussion
with an external reviewer, implementation to an enterprise standard, and a PRD, an ADR and tickets first — several
distinct deliverables with dependencies, stated in one message. Jev's judgment is not the problem in this measurement;
its input is.

## What this means

Together with the run in `report-single-file-jobs.md`, where Gate A answered `direct` on all four single-file jobs and
the report's own conclusion was "no admission exposure", the picture is consistent: **on this operator's work the
routing never engages.** Not because it decides badly — it decided correctly every time it was asked — but because the
prompts it is shown either are direct, or cannot be read without the conversation around them.

This is the second time the same shape has appeared in this investigation. The search-result filter hooks `^Grep$` on a
machine where `Grep` is never called; Gate A reads standalone requests from an operator who writes continuations. In
both cases the mechanism works and the surface is not there.
