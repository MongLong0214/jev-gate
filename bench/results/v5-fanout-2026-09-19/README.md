# Gate A rebuilt the way the vendor documents it — 2026-09-19

Prompted by the owner pointing at `docs.typesafe.ai` and saying the usage was wrong. It was. This records what the
documentation says, where this repository departs from it, and what changes when the departure is corrected.

## What the documentation says, against what is shipped

| documented | `src/admission.ts` and `src/context/select.ts` |
|---|---|
| Questions should be **atomic** — "what a knowledgeable person could answer in seconds" | one composite judgement per gate |
| "For complex judgments, **decompose into separate questions and combine results in code**" | the model is asked to do the composing |
| **Speculative fan-out**: many questions in one call; "adding questions barely changes the response time" | one question per call |
| Three primitives — `choice`, `score`, `noul` — "mix question types freely in a single call" | `choice` only, everywhere |
| "**A confidence threshold is not one number**"; a read-only decision "might accept 0.5", destructive ones above 0.9 | a fixed 0.8 admission floor and 0.9 omission floor, whatever the risk |

The 0.6–0.8 ceiling that every measurement in this investigation ran into is explained by the first two rows. Asked
"is this work compound?" — a judgement that requires estimating work not yet done — Jev returned 0.65–0.78. Asked
things that are read off the input, the same model on the same day through the same client returned **0.98–1.00**.
That was never a model limit.

## Fan-out, measured

Six `noul` read-offs plus one `score`, one call, against the shipped single `choice`, over the same 61 real prompts:

| | tokens | latency |
|---|---|---|
| shipped, 1 question | 674 | 264 ms |
| fan-out, 7 questions | 741 | 272 ms |

**+10 % tokens, +3 % latency for seven questions instead of one.** The documentation's claim that adding questions
barely costs anything holds here.

Not every atomic question earns its place. Over 61 prompts, counting answers that reached a decisive 0.85/0.15:

| question | decisive | note |
|---|---|---|
| `forbids_delegation` | 42/61 | after the correction below |
| `answer_only` | 29/61 | separates "just tell me" from "do something" cleanly |
| `multiple_deliverables` | 17/61 | |
| `missing_reference` | 8/61 | never goes below 0.52 — reads as vague on continuations |
| `mechanical` | 5/61 | never above 0.53 |
| `separable` | **0/61** | 0.33–0.79, never decisive; it asks for a forecast, not a read-off |
| `size` (score, 0–4) | — | spans 0.05–3.98, median 2.07; its own confidence spans 0.00–0.99 |

`separable` is the lesson repeating at a smaller scale: "could different people do these parts?" is a prediction, and
it behaves like one.

## Ground truth caught two errors

Two requests have measured answers — `v5-context-locality-2026-09-19` found delegation losing 182 % on one and winning
57 % on the other — so the composed rule can be checked rather than admired.

**First error, mine.** Both jobs came back `forbids_delegation` 0.62–0.67 and were blocked. Neither forbids delegation;
both are full of restrictions on *method* — "no loops, no globs, one cat per file", "do not change the behaviour that
is already correct". The question said "tells the reader to do the work themselves, or not to delegate or hand it off",
and Jev read the prohibitions that were there. Sharpened to name the distinction explicitly, the same two requests
return **0.08 and 0.10**, and decisive answers across the 61 went from 7 to **42**.

**Second error, also mine.** With that fixed the rule said *orchestrate* for both — wrong on the shallow one. The
break-even arithmetic carried over from `v5-context-locality` had **no planner term at all**. Measured from the cells,
the planning pass is `claude-opus-5` at **$0.3608 and $0.4192** — a fixed toll of about **$0.39** that the first model
simply omitted.

## The corrected relationship

```
saving ≈ T · (context − worker_prefix) · cache_read_price  −  planner_toll
         T = turns the job takes          worker_prefix ≈ 45,000
         cache_read_price ≈ $0.30/M       planner_toll  ≈ $0.39
```

Checked against both measured cells, signs match:

| | predicted | measured |
|---|---|---|
| fresh, ctx 55,718 | −$0.26 | −$0.57 |
| loaded, ctx 406,218 | +$7.63 | +$3.59 |

The magnitude is overestimated on the loaded side — workers accumulate their own context and hand off, which this
does not model — but the crossing is where it needs to be. And the crossing is the whole point:

| context depth | turns needed to repay the toll |
|---|---|
| 55,718 (what the bench always used) | **121** |
| 200,000 | 8.4 |
| 406,218 | 3.6 |
| **657,393** (this operator's median) | **2.1** |
| 961,765 | 1.4 |

## The division of labour this settles

Jev answers what can be read off the request — is there anything to do, is delegation refused, how big is this. Code
supplies what code already knows exactly — the current context size, the measured toll, the arithmetic. Neither half
works alone: without Jev there is no size estimate to put in the formula, and without the context number the size
estimate cannot be turned into a decision. An earlier note in this investigation said this decision was "dominated by
a number, so Jev contributes little". That was half right and is corrected here.

Applied to the same 61 real prompts:

| | delegate |
|---|---|
| shipped single-`choice` gate | **0 / 61** |
| corrected fan-out + code | **43 / 61 (70 %)** |

The 18 it declines are declined for stated reasons: 8 ask only for an answer, 2 refuse delegation, and 8 are small
enough that the toll is not repaid even at depth. Predicted saving across the 43 is $143, median $2.20 each, with the
marginal decisions sitting at +$0.05 — exactly where a break-even rule should put them.

## Gate B has the same defect, and more headroom behind it

Gate A was where the investigation started, but the delegated run points somewhere else. Decomposing its cost:

| | cache read | cache write | total |
|---|---|---|---|
| `sonnet_native` | 22,973,645 — **2.30 M** weighted | 388,625 — 0.78 M | $6.2851 |
| `jev_forced_orchestration` | 3,257,720 — **0.33 M** weighted | 537,482 — **1.07 M** | $2.6922 |

Delegation cut cache read sevenfold and cache **write went up**, because each worker writes its own prefix. Write is
now the largest term in the delegated arm. And the workers all ran on `sonnet`, because:

```
gate: eligible=7  patched=0  preserved=6
preserve_reasons: { route_low_confidence: 6 }
```

**Gate B fired seven times and changed nothing.** `ROUTE_QUESTION` is a single five-way `choice` carrying ~900
characters of policy — the same monolith as Gate A, one step further along.

Decomposed into six read-offs about the task contract, run against the seven dispatches that run actually made:

| | result | tokens | latency |
|---|---|---|---|
| shipped `choice` | **1 / 6** clears the 0.8 floor — and it answered `standard`, the default, so it changes nothing | 1,189 | 303 ms |
| fan-out + code | **3 / 6 → `fast`**, 3 → `standard`, 0 → `deep` | **879** | 347 ms |

Here decomposition is **cheaper**, not just nearly free: the shipped instruction block is larger than six atomic
questions. And the split has a reason — the three routed to `fast` are the validator fixes, where `checks_stated`
reads 0.94 because the task names `npm test`; the three left at `standard` are the file-reading tasks, where it reads
0.33 because nothing would catch a mistake.

### What `fast` is worth, measured

One of the tasks the fan-out routed to `fast`, run unchanged on both models against the same fixture:

| model | assigned modules | unassigned module | tests added | cost | wall |
|---|---|---|---|---|---|
| `sonnet` (what shipped today does) | **4 / 4 correct** | untouched | 4 | $0.2320 | 37.9 s |
| `haiku` (what the fan-out routes to) | **4 / 4 correct** | untouched | 4 | **$0.1202** | **26.0 s** |

Same result, **−48 % cost and −31 % wall clock**, on a decision that is applied mechanically through `updatedInput`
rather than suggested to the model.

This is the one place in the design where Jev's answer cannot be ignored by anything downstream, and it has never once
taken effect.

## Not settled here

- **`T` per size level is uncalibrated.** The mapping `[1, 3, 12, 30, 60]` is a guess fitted to nothing; there are two
  ground-truth points and they do not constrain five levels. Every dollar figure above inherits that.
- **No end-to-end run of the corrected gate.** 43/61 is what the rule decides, not what it would save. The measured
  −57 % came from forcing orchestration, not from this rule choosing it.
- **Nothing in `src/` has changed.** The admission criterion, `OMIT_CONFIDENCE_FLOOR` and the 0.8 floor are declared
  values; this is a measurement of an alternative, not a replacement of one. The documentation's point that a floor
  should scale with the risk of the decision applies to them and is the owner's to act on.
- **One operator, 61 prompts**, all above the crossing point. An operator working in short fresh sessions is on the
  other side of it and would get the +182 %.
