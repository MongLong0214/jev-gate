# The single shape is cheaper below the floor too — one rung of three (2026-09-19)

Pre-registration: `PREREGISTRATION.md`, committed at `7c67c66` before the first cell.
Run: `~/jev-gate-runs/v5-depth-ladder`. Rules applied mechanically by `apply-rules.cjs`, whose output is
`rules-applied.txt`. That script was written and validated **before this run's cells finished**: run against
`v5-single-vs-native` it reproduces that run's published 71.0 % and 20.4 % and, with no hand intervention, sorts
`wide` into a separation and `orbit` into direction-only — the caveat that run had to add after the fact.

> **Follow-up (2026-09-20), two parts:**
> 1. The two rungs this run lost to the session limit were re-run whole: 21-note −43.1 %, 30-note −56.6 %
>    (`RESULTS-RERUN-2026-09-20.md`).
> 2. **This run's own headline did not reproduce.** The 13-note rung was re-run with byte-identical inputs and
>    came back with the sign reversed — `single` 72.5 % *more* expensive. The cause is in the metric, not the
>    arms: the stream shows both arms doing the same work on both days, and the host reporting a different
>    fraction of it. See `RESULTS-13NOTE-RERUN-2026-09-20.md` and `METRIC-DEFECT-2026-09-20.md`.
>    **Read those before quoting anything below.**
>
> 3. **Withdrawn whole, 2026-09-20 (run 4).** The 21-note and 30-note rungs were re-run under a new
>    pre-registration with the work unit co-primary. **Neither reproduced in any unit, and the 30-note rung
>    reversed sign: `single` 67.2 % MORE expensive, a separation.** Two rungs x three units = six comparisons,
>    zero reproductions. **No percentage from this ladder is quotable.** See
>    `RESULTS-WORK-RERUN-2026-09-20.md`.
>
> The table below is this run's own result and is left as it was measured. It is a record of what was measured,
> not a claim about the shapes.

## What was asked

Is the `single` shape's saving **bound to depth**? The 71.0 % came from sessions at ~390K, and the mechanism that
run identified was root turns taken at depth. If that is the mechanism, the saving should fade as sessions get
shallower, and the shipped `delegationDepthFloor` of 300,000 should be drawing the line in about the right place.

## What came back

**At 193K — a depth the shipped floor refuses outright — `single` separated from `sonnet_native` by 41.8 %.**

| rung | measured depth | `sonnet_native` job turn | `jev_single` job turn | difference | rule 5 |
|---|---|---|---|---|---|
| **13-note** | 192,332–193,553 | $1.4204, $1.4118 (spread 0.6 %) | $0.7374, $0.9119 (spread 23.7 %) | **−41.8 %** | **separation** |
| 21-note | 284,780–285,516 | $2.0684 (one cell; the second was lost) | $0.9142, $0.9392 | — | **no percentage quoted** |
| 30-note | — | no cell ran | no cell ran | — | nothing |

All seven cells that produced work passed their checkers, so rule 3 is satisfied wherever a number is quoted.
Every `jev_single` cell was admitted by Gate A on its own, and every one produced an accepted receipt and
`outcome: completed`.

**The answer to the question is: not down to 193K.** The saving does not need a ~390K session. It is smaller than
at 390K — 41.8 % against 71.0 % — which is consistent with depth mattering, but it is nowhere near gone at a depth
where the product currently refuses to act at all.

That is about the `single` shape and nothing else. The 300,000 floor was set from **hierarchy** measurements,
where the same fixture measured −10.5 % at ~180K — indistinguishable. This run says the shape that has been
proposed as the default does not behave like the shape the floor was derived from.

**Rule 8 stands: `delegationDepthFloor` is unchanged at 300,000.** One rung, one fixture, two repetitions is not
the evidence a floor moves on, and the floor is a decision about which errors to prefer against the real-prompt
depth distribution. What this run does is remove the assumption that the question was already answered.

## What the run did not deliver, and why

**The account hit its session limit.** The last five cells returned HTTP 429 with
`You've hit your session limit · resets 9:50pm (Asia/Seoul)` and exited in under four seconds each:
the 21-note `sonnet_native` r2 cell and all four 30-note cells. They are recorded as invalid under rule 1
(context 0, outside every band) and cost nothing.

This is an external resource running out, not a finding, and it is not a reason to relax anything:

- The **21-note rung has one valid native cell**, so its arm spread cannot be computed and rule 5 cannot be
  evaluated. **No percentage is quoted for it**, even though the surviving cells sit far apart. Rule 11 forbids
  deciding after the fact that one cell is enough.
- The **30-note rung produced nothing**, so this run does not contain its own reproduction of the 71.0 %, and
  rule 6 forbids borrowing it from the previous run, which froze a different floor. The ladder is therefore
  **two rungs with one usable comparison**, not the three-point ladder that was pre-registered.

Spend: **$18.88** against a ~$40 estimate, because five cells never ran.

## The floor was lowered safely, and that is now measured rather than assumed

Rule 2 asked whether lowering the bench floor to 50,000 would let Gate A hijack a priming turn — the failure that
made `jev_forced_orchestration` unusable for this question. It did not, in any cell:

```
prompt 1 (priming, 13 notes)   depth_unknown          direct   — no request is sent at all
prompt 2 ("say ready", 45 ch)  admission_answer_only  direct   — asked at 193,206 and refused by Gate A itself
prompt 3 (the job, 322 ch)     orchestrated                    — admitted at 193,553
```

The same three lines appear at the 21-note rung (asked at 285,169, admitted at 285,516). **Gate A's own judgement,
not the floor, is what keeps priming turns out of the delegation path**, and that now has end-to-end evidence
instead of an argument.

## A product defect this run found

`wide-validators-primed-21 / jev_single / r2` dispatched **two** workers. The cause is not the coordinator
deciding to split the work:

```
attempt 1  invalid  check_id must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$   86.6s, 43 tool calls, discarded
attempt 2  accept                                                          48.7s, 21 tool calls
```

`parseWorkerReply` rejects the **entire reply** when any `check_id` fails the id grammar. On the hierarchy path
that grammar is right, because the ids are declared in the contract and the worker is echoing them back. **The
single shape has no contract**, so the worker names its own checks, and an ordinary name with a space in it throws
away everything it did. This is the same class of defect as the missing receipt repaired in `ed2a419`:
contract-era machinery still running on a contractless path.

Counted across every `single` cell in every run to date — this run, `v5-single-vs-native`, and
`v5-context-vs-decomposition-s1` — **this is the only cell that dispatched more than one worker.** The others were
one, so the earlier runs' one-dispatch reading holds as an observation. It was never an enforced guarantee, and
nothing on this path caps attempts; that is now a known gap rather than an assumption.

Direction of the error on this run's numbers: the discarded worker's 86.6 seconds and 43 tool calls are **inside**
the `single` arm's cost at the 21-note rung, so the defect inflates `single`, and the rung whose percentage is
quoted (13-note) is not affected at all.

## Not settled

- **Two repetitions, one fixture, one rung with a quotable number.** The 13-note native arm's 0.6 % spread is
  unusually tight for two cells, and rule 5 was met partly because of it.
- **The 13-note rung landed at 193K here, not the 179–181K measured earlier** on the same case. The two are not
  the same point and are not compared.
- **No `hierarchy` arm.** Whether splitting adds or subtracts at these depths is untouched.
- **`single` is still slower**: 26.9 % more wall clock at the 13-note rung, in line with the 40–48 % measured at
  390K.
- **The 21-note and 30-note rungs are owed.** They need a re-run with the account's limit in hand, under this same
  pre-registration, and the rules on that page apply to them unchanged.
