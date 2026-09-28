# Trying to open Gate A — three inputs, a different question, and what the confidences say — 2026-09-19

`README.md` in this directory measured a −57 % saving from delegation at the depth this operator works at, and a
+182 % penalty at the depth the bench had always used. The saving came from the diagnostic arm, which orchestrates
without asking. `jev_hierarchy` answered `direct` and captured none of it, as it has on every job and every prompt ever
put to it. This file is the attempt to change that, and it fails in a way that is worth more than the attempt.

## The hypothesis, and its refutation

`README.md` proposed a narrow cause: Gate A's state is `{ request, available_execution }`, so **it is never shown how
full the context is** — the variable that decides which branch is cheaper by a factor of four.

Tested by replaying 61 real prompts, each paired with the context its session was actually carrying when it was typed
(p10 245,379 · median **657,393** · p90 961,765 — and **61 of 61 above the 45K crossing point**):

| arm | input | `orchestrated` | admitted at 0.8 | top confidence |
|---|---|---|---|---|
| A | as shipped | 12 / 61 | **0** | 0.65 |
| B | + `context_tokens` | 12 / 61 | **0** | 0.68 |
| C | + `context_tokens` + what each shape costs | **7 / 61** | **0** | 0.62 |

Adding the number changed nothing. Adding the number *and* an explanation of why it matters made Gate A **less** likely
to orchestrate. The hypothesis is refuted.

The reason is in the criterion, which never mentioned cost:

> `orchestrated`: *A compound deliverable with distinct outcomes and dependencies for which explicit planning and
> handoffs are plausibly useful.*

Gate A asks whether the **work is compound**. The decision that matters is whether **this shape is cheaper here**. Those
are different questions, and the first one's answer does not depend on context depth, so no amount of depth information
can move it. Jev was answering the question it was asked, correctly, the whole time.

## Asking the question that the decision turns on

Arm D replaces the shape question with a cost question — same prompts, same floor, `delegate_cheaper` /
`direct_cheaper` / `uncertain`, with the context size and the cost properties of each shape supplied:

| | result |
|---|---|
| `delegate_cheaper` | 18 / 61 (29.5 %), against `orchestrated` at 12 / 61 |
| top confidence | **0.78**, against 0.65 for the shape question |
| admitted at the 0.8 floor | **0 / 61** |

Better, and still short. One answer reached 0.78 and stopped there.

## The pattern in the confidences, across everything measured today

| question | highest confidence seen |
|---|---|
| "does this request need every match?" (`keep_all`) | **0.99** |
| "is this block relevant?" | **0.98 – 1.00** |
| "is this work compound?" | 0.68 |
| "can this goal ever be met?" | 0.45 – 0.92 |
| "is delegating cheaper?" | 0.78 |

Jev is not short of confidence in general — it produced 0.99 and 1.00 on this same day, through the same client. It is
confident **when the answer is present in the input** and hedges when the answer requires a forecast. "The user said
they need the complete list" is read off. "This job will take enough turns to be worth delegating" is a prediction
about work not yet done, and no restatement of the question removes that.

## What that means for where Jev pays

The decision this repository built Gate A for turns out to be dominated by a number rather than a judgement. From the
measured relationship — `saving ≈ (T − 2)·X − T·P`, with `P ≈ 45,000` — at this operator's median depth of 657K:

| job length | delegation |
|---|---|
| 3 turns or more | wins, by 522K token-equivalents at T = 3 and more above |
| 2 turns | loses by about 90K, a small bounded penalty |

Every one of the 61 sampled prompts was above the crossing point. **A threshold on a measured number — delegate when
context exceeds it — captures essentially the whole saving**, and it captures it *because* the penalty case is both
rare here and small. A classifier asked to predict job length instead contributes uncertainty: at 0.78 it admits
nothing, and at a floor low enough to admit it would be guessing.

This is not a statement that Jev classifies badly. It is a statement about this particular decision: the thing that
decides it is observable at decision time, and a measurement beats an estimate of it.

## Not settled here

- The arithmetic above is derived from measured constants, not itself measured. The decisive test is a short job run at
  high context, to see whether delegation still wins where the model says the margin is thinnest. That is unbuilt.
- The 61 prompts are one operator. An operator who works in short fresh sessions sits on the other side of the crossing
  point, where the +182 % is what they would get.
- Arm D's question is a probe, not a proposal: `OMIT_CONFIDENCE_FLOOR` and the admission criterion are declared values
  and nothing here moves them.
- Replacing a gate with a threshold removes Jev from this decision. Whether Jev pays somewhere in the *execution* of an
  orchestrated job — Gate B's tier choice, which was never exercised because no job was ever admitted — remains open
  and is now the only untested branch of the original design.
