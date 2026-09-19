# Both re-run rungs separate — 43.1 % at 285K, 56.6 % at 389K (2026-09-20)

Pre-registration: `PREREGISTRATION.md` (`7c67c66`), **unamended**. Conditions and limits of this re-run were
written before it started: `RERUN-2026-09-20.md` (`3d1141a`). Run: `~/jev-gate-runs/v5-depth-ladder-2`.
Rules applied mechanically by the same unedited `apply-rules.cjs`; its output is `rules-applied-2.txt`.

The 21-note and 30-note rungs were re-run **whole** — 8 cells, both arms, 2 repetitions. Yesterday's two
surviving 21-note `jev_single` cells were not reused: a rung whose arms ran on different builds is not a rung.

## What came back

All 8 cells exited 0, all 8 passed their checkers, all 4 `jev_single` cells were admitted by Gate A on their
own. Rule 3 (quality gates cost) is satisfied for both rungs, and rule 4's admission threshold is met at 2/2.

| rung | measured depth | `sonnet_native` job turn | `jev_single` job turn | difference | rule 5 |
|---|---|---|---|---|---|
| **21-note** | 284,661–285,764 | $1.9915, $1.9319 (spread 3.1 %) | $0.9656, $1.2681 (spread 31.3 %) | **−43.1 %** | **separation** |
| **30-note** | 388,315–389,183 | $2.6296, $2.7995 (spread 6.5 %) | $1.1899, $1.1656 (spread 2.1 %) | **−56.6 %** | **separation** |

Rule 5 needs the difference to clear 15 % **and** the wider arm's own cell-to-cell spread. At 21-note the
`single` arm is wide — 31.3 %, $0.9656 against $1.2681 — and 43.1 % clears it, but not by much. The 30-note
rung is the clean one: both arms tight, 56.6 % against a widest spread of 6.5 %.

Rule 2 (priming integrity) holds in all four `single` cells. With the floor frozen at 50,000, the priming turns
still never left the session: prompt 1 `depth_unknown` (no transcript yet), prompt 2 `admission_answer_only` —
Gate A refusing on its own judgement at 285,097 / 285,409 / 388,671 / 388,836 — and only the job prompt
`orchestrated`. That is the same end-to-end evidence the 13-note rung produced, now at two more depths:
**what protects the priming turns is Gate A's own admission test, not the floor.**

## The repaired path held

Every `jev_single` cell dispatched exactly one worker (`agents: 1`), recorded one `accept` receipt and
`outcome: completed`. Yesterday's two-worker cell — `parseWorkerReply` discarding a whole reply over a
self-named check id, 86.6 s and 43 tool calls thrown away — did not recur in four cells at these depths.
That is consistent with the `f2b3256` repair but does not prove it: the tests prove the behaviour, and these
cells only show that no cell needed it.

## Wall clock is uniformly worse

| rung | native | single | penalty |
|---|---|---|---|
| 21-note | 133 s | 206 s | **+55.0 %** |
| 30-note | 138 s | 212 s | **+54.1 %** |

Larger than the 13-note rung's +26.9 %, and in the same direction as every run to date. The `single` shape
buys tokens with time. Nothing in this bench has ever shown it going the other way.

## What this answers, and what it does not

The question was whether the `single` shape's saving is **bound to depth**. Three rungs now exist:

| depth | difference | build |
|---|---|---|
| 193K | −41.8 % | `7c67c66` |
| 285K | −43.1 % | `b2c4548` |
| 389K | −56.6 % | `b2c4548` |

The saving rises with depth — which is what the root-turns-at-depth mechanism predicts — and it does **not**
go to zero at the shallow end. At 193K, a depth the shipped floor refuses outright, the shape is still 41.8 %
cheaper. The 300,000 floor falls between the second and third rungs: it refuses a depth measured at 43.1 %.

Limits, all of them pre-recorded:

- **The 21-note and 30-note rungs share a build; the 13-note rung does not** (`RERUN-2026-09-20.md`). So
  43.1 % → 56.6 % across 285K → 389K is a within-run, within-build reading; the three-row table above spans
  two builds. Neither 13-note cell hit the repaired path, and the repair is cheaper-or-equal for `single`,
  which bounds the direction of that gap but does not close it. A single-build ladder needs the 13-note rung
  re-run (≈ $9, not authorised).
- **Rule 6: no cross-run comparison.** `v5-single-vs-native` measured this same 30-note fixture under a
  different frozen config. Its number is not this run's number and the two are not differenced here. What can
  be said without crossing runs: **inside this run, at 389K, the difference is 56.6 %.**
- One fixture (`wide-validators`), one root model, two repetitions per cell. `hierarchy` was not an arm, so
  this says nothing about whether splitting the work adds or subtracts.
- **Rule 8: the product floor stays at 300,000.** Rule 10 likewise — no default, planner or release change
  follows from this run.

## Spend

$32.62 across 8 sessions (estimate ≈ $25; the 30-note cells cost $4.02–$5.65 each). Combined with the first
run's $18.88, the depth-ladder question has cost **$51.50**.
