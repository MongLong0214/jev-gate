# Pre-registration — does the tier multiply the delegation saving? 2026-09-19

Written before the run.

## What is already measured

- Delegation at depth: `sonnet_native` $6.2851 against `jev_forced_orchestration` $2.6922 on the loaded job, all cells
  passing the twelve-module checker (`v5-context-locality-2026-09-19`).
- In that run **every worker ran on `sonnet`**: Gate B fired seven times, patched nothing, six preserved for
  `route_low_confidence`.
- One of those dispatches re-run by hand: `haiku` produced the same result as `sonnet` — 4/4 assigned modules correct,
  unassigned untouched, four tests — at $0.1202 against $0.2320 (`v5-fanout-2026-09-19`).

Those are two separate single observations. Nothing has measured them together.

## The run

One cell: the loaded job, `jev_forced_orchestration`, with the frozen config's `models.standard` set to `haiku` so
every worker dispatch lands on the cheap tier. Everything else identical — same fixture, same request, same checker,
same 300,000 auto-compact window.

This is deliberately *more aggressive than the fan-out's decision*, which routed 3 of 6 dispatches to `fast` and left
3 at `standard`. Forcing all of them measures the ceiling and, more usefully, finds out whether the selectivity is
load-bearing.

## Prediction

| outcome | reading |
|---|---|
| passes the checker and costs **under $2.69** | the two savings compose; report the product and the margin |
| passes the checker and costs **$2.69 or more** | the tier does not compound with delegation; the single-dispatch result was not representative |
| **fails the checker** | indiscriminate `haiku` is too aggressive, and the fan-out's 3-of-6 selectivity is doing real work — which is a result about the gate, not about the tier |

The twelve-module checker grades the whole job, so output equality is decided by it and not by inspection. Pass rate is
checked first: if it fails, cost is not compared.

One repetition. A single cell cannot establish a magnitude, so what this run can settle is the sign and whether the
work still gets done — not how big the product is.
