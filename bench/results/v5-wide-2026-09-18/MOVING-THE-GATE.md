# Moving the question to a surface that exists — 2026-09-18

The measurements in this directory say the routing never engages and the search filter has no surface. The obvious
response is to ask Jev somewhere else. This records that attempt and its result, which is negative, and corrects a
diagnosis that was made too confidently on the way.

## The surface

Stop-gate goal evaluation. It was chosen over the alternatives on three grounds that the other candidates failed:

- **A measured, expensive failure.** One session (`repo-factory`, 12 days, 25,716 turns, 13.62 B prompt tokens) held a
  goal open for five days. 466 Stop-hook firings on that goal, longest unbroken burst 197, and **51 % of the session's
  entire token consumption fell in those five days**. Across the machine: 17 distinct goals, **2,158 firings**.
- **Jev's native shape.** "Classify this condition" is a choice question with a confidence, which is the only thing
  Jev is asked to do anywhere in this project.
- **Offline verification.** The goal text is carried verbatim in every `Stop hook feedback:` line, so every goal this
  machine ever armed can be replayed with its firing count as evidence of whether it terminated.

## The question, and the result

Asked once when a goal is armed rather than on every stop: *can this goal ever be observed as met, so the gate releases
the session?* — `terminating` / `non_terminating` / `unclear`.

Replayed over all 17 recorded goals (9,200 Jev tokens, 296 ms mean):

| firings | answer | confidence |
|---|---|---|
| 466 | `terminating` | 0.64 |
| 411 | `terminating` | 0.87 |
| 374 | `terminating` | 0.45 |
| 242 | `terminating` | 0.92 |
| 232 | `terminating` | 0.49 |
| 111 | `terminating` | 0.67 |
| 85 | `non_terminating` | 0.75 |

**It does not discriminate.** The six goals that fired most — the ones that demonstrably never released a session — all
come back `terminating`. The single `non_terminating` answer in the top group is a goal that fired 85 times, fewer than
five above it. Firing count and answer are unrelated.

## The diagnosis that was wrong

The attempt rested on a claim made earlier in this investigation: that the 466-firing goal was **structurally**
unsatisfiable because its third clause reads "계속 이어나가" — keep going. Jev disagreed, and on re-reading Jev is
right. The goal is:

> 남은 이슈 전수 해결해야돼 / 실제 프로덕션레디 운영상태가 목표야 / Ceo랑 논의하면서 작업 계속 이어나가

The first two clauses name observable end states — every remaining issue closed, a production-ready operating state.
The third describes *how* to work while getting there, not a condition to satisfy. Nothing about it is unsatisfiable.
It was simply not satisfied in five days, which is a fact about the size of the work.

So the expensive failure was not a malformed goal. **It was a gate with no ceiling**: the only bound anywhere is the
host's "a hook blocked the turn from ending 9 consecutive times", which caps one turn and not the nine days. A goal that
is legitimately far from met will hold a session open for as long as it takes, at whatever the context costs by then —
788 K tokens a turn, in that session's case.

That is a missing bound, not a missing judgment, and Jev has nothing to offer it.

One substitution could not be evaluated at all. Replacing the gate's own per-stop evaluation with a Jev call would be a
straight cost swap, and 2,158 firings is a lot of them — but the goal gate is a built-in feature whose evaluation is not
billed inside the session transcript, so what each firing spent is not observable from here and no saving can be
quantified. It is recorded as unmeasured rather than as small.

## Four surfaces, one pattern

| surface | result |
|---|---|
| `Grep` output filter | the tool is never called here — 0 of 120,756 |
| Gate A on the bench jobs | answered `direct` five times, correctly; no exposure |
| Gate A on 110 real prompts | 0 admitted; max confidence 0.67 against a 0.8 floor |
| goal termination | does not discriminate; the premise was wrong |

Each time the mechanism was sound and the judgment defensible. Each time the decision it informs either was not being
made, or was already being made correctly without it.

What the four have in common is visible in the cost structure measured in `v5-context-viability-2026-09-18`: **82 % of
this operator's bill is cache read — a mechanical consequence of how much context a turn carries, not the outcome of
any decision.** A classifier, however cheap and however accurate, cannot reduce a quantity that nothing chooses. The
two changes that did reduce it — the auto-compact window and the static prefix — are both settings.

## What would have to be true

For Jev to pay here, there has to be a decision in the hot path that (a) is actually taken often, (b) has a materially
cheaper and a materially more expensive branch, and (c) is currently taken wrongly or not at all. Nothing measured in
this investigation satisfies all three. The nearest candidate left untested is orchestration on work with **distinct
outcomes and dependencies**, which `README.md` §2 explains is still unbuilt — that is the one place where a branch with
a real cost difference plausibly exists and has never been put in front of the gate.

Data: `goal-termination-replay.json` (firing counts, answers, confidences; goal text withheld), `goals.mjs` and
`goalgate.mjs` for reproduction.
