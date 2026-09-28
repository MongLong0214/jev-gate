# Result — the classifier answered correctly and the correct answers point the wrong way (2026-09-20)

Pre-registration: [PREREGISTRATION.md](PREREGISTRATION.md), committed at `7b0702d` **before any request was sent**.
Corpus frozen at `5f82fa6`. Replay: `scripts/plan-silence-replay.mjs`. Raw: [replay.json](replay.json).

17 cells, **17 valid, 0 invalid, 0 not applicable**. 17 requests, 68,144 input and 7,537 output tokens. The API
reports tokens and not dollars, so **no dollar figure is stated here** — the registered `$2` stop was never the
operative bound; the request count was, and it was fixed at 17 by the corpus.

## The registered outcome

| row of the outcome table | fires |
|---|---|
| axis separates (h1 flagged, h2 not, FP ≤ 3/15) | no — none of the three held |
| both h1 and h2 flagged (the prediction) | no |
| neither h1 nor h2 flagged | no |
| **more than 3 of the 15 passing plans carry `filled`, whatever h1 and h2 do** | **yes — 11 of 15** |

**The registered conclusion is the fourth row: the axis is not selective enough to act on, and the closure stands
regardless of the pair.** The A23-extension branch is closed.

The pair itself landed outside all three rows that anticipated it — h1 unflagged and h2 flagged. That combination was
not enumerated in advance, so it is recorded as an outcome the table did not cover rather than promoted to a result
the registration would have permitted.

## Why the pair inverted — the classifier was right every time

| cell | entry | verdict |
|---|---|---|
| **h1 (failed)** | `new empty-array case: { ok:false, field:'<name>' }` | **`stated`** |
| **h2 (passed)** | `new case: entries is an array of length 0 -> reason 'empty'` | `derived` |

**Both answers are correct.** The request says `반환값에 field 는 그대로 두고 ok:false 로`, so the entry that produced
the failure is a faithful transcription of it — `stated` is the right verdict. And the request does name the existing
`'missing'` and `'blank'` reasons, so reading `reason:'empty'` as following from it is defensible — `derived` is a
right verdict too.

h2's four `filled` verdicts did not land on the fix. They landed on entries like
`submission keys are naive plurals; countrys and currencys are misspelled on purpose` — a fact about the codebase the
request never mentions. **On this corpus `filled` marks repository knowledge the planner brought in, which is nearer
to why the passing plan passed than to any defect.** 11 of 15 passing plans carry at least one.

## What this closes, and what it opens

The defect is not that the plan departed from the request. **The defect is that the plan was faithful to the request
where the request was wrong to be trusted**, because the answer lived in the code. So the failure is invisible to any
comparison between request and plan, however the question is phrased and whatever fields it covers. This is not a
finding about one classifier being weak; it is a property of the pair of documents being compared.

`src/interpretation.ts` already records the limit that predicts this: *"The hook has no repository access, so the
comparison sees the request, the plan and the proposed interfaces and no source evidence at all."* This run is that
limit measured rather than asserted.

What it opens is the planner. **`agents/planner.md` governs the only component in this system that reads the
repository before the work starts**, and the passing plan differed from the failing one precisely by carrying a
codebase fact the request did not state. Whether a planner instructed to mark such resolutions explicitly produces
fewer failures is a different question, on a different component, and **it gets its own pre-registration before
anything is changed.**

## What no part of this supports

- Changing `planInterpretation`, its fields, its default or `applied: false`. The measurement argues against extending
  it, and an argument against extending is not an argument for removing.
- Changing `agents/planner.md` now. This run did not test a planner change and cannot stand in for one.
- Any cost, latency or quality claim about the product. None was measured; the project's earlier percentages remain
  withdrawn.
- A detection rate. One cell in this corpus failed by this mechanism, and one cell cannot estimate a rate.
