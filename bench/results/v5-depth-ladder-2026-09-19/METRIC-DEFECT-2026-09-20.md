# The reversal was the accounting, not the work — and the bench was measuring the accounting (2026-09-20)

The 13-note rung reversed sign on a repeat (`RESULTS-13NOTE-RERUN-2026-09-20.md`). This file is the follow-up
the owner asked for: find the cause, and fix what is broken. Both were possible without spending anything,
because every cell keeps its `stream.jsonl`.

## The work did not change. It reproduced exactly.

Summing every message in the job turn that carries a usage block — subagent messages included — gives what the
transcript says actually happened, independent of any cost the host reports:

| 13-note rung | cache reads, native | cache reads, single | single uses |
|---|---|---|---|
| run 1 (09-19) | 9.97M | 8.96M | **10.1 % less** |
| run 3 (09-20) | 9.35M | 8.40M | **10.1 % less** |

**Identical to the decimal**, while the dollar figure for the same cells swung from −41.8 % to +72.5 %, a
114-point reversal. The arms behaved the same way on both days.

## What moved was the fraction of that traffic the host reported

`stream.jsonl` carries both numbers: the per-message usage, and the aggregate on each turn's `result` event.
They disagree, and the size of the disagreement changed:

| arm | run | stream cache reads (job turn) | host-reported | reported fraction |
|---|---|---|---|---|
| native 13-note | 1 (09-19) | 9.98M, 9.95M | 6.26M, 6.24M | **63 %, 63 %** |
| native 21-note | 2 (09-19) | 14.28M, 14.01M | 9.10M, 8.83M | 64 %, 63 % |
| native 30-note | 2 (09-19) | 19.77M, 21.35M | 12.33M, 13.12M | 62 %, 61 % |
| native 13-note | **3 (09-20)** | 9.26M, 9.43M | 1.59M, 1.39M | **17 %, 15 %** |
| single (every rung, both days) | 1–3 | — | — | 16–37 % |

The reported cost tracks the reported usage, not the traffic. On 09-19 the host attributed ~62 % of the native
arm's cache reads and ~22 % of the single arm's; on 09-20 it attributed ~16 % of both. **The measured "saving"
was substantially the gap between those two fractions, and it closed.**

Why the host's attribution changed is still not established — that is outside what this bench can see, and it is
not guessed here. What *is* established is that the quantity the bench was reporting is not the quantity it
believed it was reporting.

## Defect 1 — the analyzer called a reversal "under the floor"

`apply-rules.cjs` tested the **signed** difference against the 15 % floor, so a rung where `single` came out more
expensive printed as `not quotable: under the 15% floor`. The floor is a precision question and therefore a
magnitude question. Fixed to compare magnitude and name the direction.

**The fix moves no number.** Re-run against all three runs, the only lines that change are these:

```
run 1:  difference **41.8%**              →  difference **41.8%** (single cheaper)
run 2:  difference **43.1%** / **56.6%**  →  same, (single cheaper)
run 3:  difference **-72.5%**             →  difference **72.5%** (single MORE EXPENSIVE)
        not quotable: under the 15% floor →  SEPARATION (rule 5 met) — single MORE EXPENSIVE
```

So run 3 was not an unquotable near-tie. In dollars it was a separation **against** the single shape: 72.5 %
against a widest arm spread of 15.0 %.

## Defect 2 — the bench recorded cost and not work

The runner kept `turn_totals_usd` and nothing that could contradict it. It now also keeps
`turn_totals_stream`: per turn, cumulative like the dollar list, the summed `cache_read`, `cache_creation`,
`input`, `output` and message count over every message in the stream. Two tests cover it — cumulative
snapshotting across turns, and counting subagent messages while ignoring messages with no usable usage.
Gates after: typecheck 0, build 0, vitest **548** (from 546).

`stream-usage.cjs` does the same for runs already on disk, so nothing already measured is lost.

*(A third, smaller defect surfaced while writing that script: it averaged in the cells the session limit killed,
reporting a dead arm as zero work. Fixed before any number here was taken from it.)*

## What the ladder looks like in work terms

**This is post-hoc re-analysis, not the pre-registered rule.** Rule 7 fixed the unit as the job turn in dollars,
and rule 11 forbids swapping a unit after seeing results. It is published because refusing to compute it would
hide what the same cells say:

| rung | dollars (pre-registered) | cache reads (post-hoc) |
|---|---|---|
| 13-note, run 1 | single 41.8 % cheaper | single 10.1 % less |
| 13-note, run 3 | single 72.5 % **more expensive** | single 10.1 % less |
| 21-note, run 2 | single 43.1 % cheaper | single **12.4 % more** |
| 30-note, run 2 | single 56.6 % cheaper | single 27.1 % less |

In work terms the single shape's advantage is small at 193K, absent at 285K, and real but roughly half the
advertised size at 389K. Output tokens are reported alongside in `stream-usage.txt`; they are in the hundreds
against cache reads in the tens of millions, so they cannot change this ordering.

**No price model is applied.** The repository prices only the Jev model, and inventing a Sonnet price to convert
tokens back into dollars would replace one unverified number with another. Cache reads are quoted as what they
are: the dominant token class at these depths, counted from the transcript.

## What this does to everything already published

Every job-turn dollar figure this bench has produced measures the host's attribution on the day it ran. That
includes the figures in `HANDOFF.md` and the decision document. They are not withdrawn as measurements — they
are what those runs recorded — but none of them is evidence of a stable saving until it is repeated, and the one
figure that was repeated reversed.

**Unchanged: the floor stays at 300,000, the default stays `hierarchy`, no planner or release change follows.**
The quality record is also untouched — every cell in every one of these runs passed its checker.

## The next measurement

A rung re-run today in work terms, not dollars, would say whether the 21-note and 30-note results survive the
change of unit. That is a paid run and it is not authorised here.
