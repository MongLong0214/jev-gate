# The 13-note rung did not reproduce — it reversed, and the reason is the metric (2026-09-20)

Conditions: `RERUN2-13NOTE-2026-09-20.md` (`40fe616`), committed before the run. Pre-registration
`PREREGISTRATION.md` (`7c67c66`), unamended. Run: `~/jev-gate-runs/v5-depth-ladder-3`. Rules applied by the same
unedited `apply-rules.cjs`; output in `rules-applied-3.txt`.

## What came back

4/4 cells valid, 4/4 passed their checkers, both `jev_single` cells admitted by Gate A.

| rung | measured depth | `sonnet_native` job turn | `jev_single` job turn | direction |
|---|---|---|---|---|
| 13-note, **run 1** (`7c67c66`, 09-19) | 192,332–193,553 | $1.4204, $1.4118 | $0.7374, $0.9119 | single **41.8 % cheaper** |
| 13-note, **run 3** (`b2c4548`, 09-20) | 192,759–193,429 | $0.4775, $0.4404 | $0.8469, $0.7362 | single **72.5 % more expensive** |

**The sign flipped.** Under the conditions file, the new measurement is the ladder entry and the published run-1
result stands unamended as what that run measured. Both stand; they disagree.

`apply-rules.cjs` prints `not quotable: under the 15% floor` for this rung. That verdict string is wrong here —
the script was written assuming `single` would be the cheaper arm, so it tests a signed difference against the
floor instead of a magnitude. Its arithmetic is correct and is what the table above quotes. The script is left
unedited: changing it after seeing a number is exactly what rule 11 forbids, and the defect is reported instead.

## The arms did not change. The metric did.

Every input was byte-identical across the two runs — `request_sha256`, both `prime_sha256` values and
`fixture_sha256` all match. So did the work: native ran 42/41 turns in run 1 and 40/41 in run 3, emitting
11,166/10,718 output tokens then 10,985/10,886.

The cost moved because **cache reads** moved:

| arm, rung | run | depth | turns | cache reads | per turn | job turn |
|---|---|---|---|---|---|---|
| native 13-note | 1 (09-19) | ~193K | 41–42 | 7.92M, 7.90M | **~193K** | $1.42 |
| native 13-note | 3 (09-20) | ~193K | 40–41 | 3.25M, 3.05M | **~78K** | $0.46 |
| native 21-note | 2 (09-19) | ~285K | 42, 42 | 12.72M, 12.45M | ~300K | $1.96 |
| native 30-note | 2 (09-19) | ~388K | 42, 42 | 19.02M, 19.81M | ~460K | $2.71 |

> **Corrected 2026-09-20, later the same day.** The paragraph below read the `modelUsage` aggregate and concluded
> the native root had *re-read less context*. The stream itself says otherwise: per-message usage shows the same
> traffic on both days (9.98M vs 9.26M cache reads in the job turn, −7 %). What fell 2.5× is the figure the host
> **reported**, not the context actually re-read. See `METRIC-DEFECT-2026-09-20.md`. The conclusion of this file —
> that the arms did not change and the metric did — survives; this sentence about *why* did not. The `Limit:` on
> record `r-depth13reverse` carries the same superseded wording; `r-metricdefect` follows it with the correction.

~~On 2026-09-19 the native root re-read its whole context every turn — 193K per turn at a 193K depth, and more at
the deeper rungs. On 2026-09-20 it re-read about 40 % of it.~~ Same request, same turns, same output, 2.5× less
**reported** cache read, and the job-turn dollar figure fell with it.

`jev_single` moved far less (123K per turn in run 1, 115–167K in run 3) because its root takes fewer turns and
the work happens in a worker with its own smaller context. So when the fraction of the root's traffic that is
reported halves, the `single` shape's measured advantage halves with it — and at this rung it went past zero.

**Why the caching behaviour differed between the two days is not established here.** Host-side cache behaviour,
TTL, load, and anything else that decides how much of a prompt is served from cache are outside what this bench
records. Identifying it is the next question, not an answer this run has.

## What this does to the ladder

Per the conditions file, the three-point ladder claim is **withdrawn to what survives**:

| depth | status |
|---|---|
| 193K | **not established.** Measured twice with identical inputs; the two measurements disagree in sign. |
| 285K | −43.1 %, **provisional** — measured once, on 09-19, under that run's reporting regime. |
| 389K | −56.6 %, **provisional** — same run, same regime. In work terms it is 27.1 %. |

Rule 6 bars differencing savings across runs and that is not what the table above does: it records that one
pre-registered cell, repeated with byte-identical inputs, did not reproduce. A rule against confounded
comparisons cannot also forbid noticing that a measurement failed to repeat.

**The two-repetition design does not detect this.** Both runs were internally tight — the run-1 native arm spread
0.6 % across its cells and the run-3 native arm 8.4 % — while the between-run gap was 3×. Rule 5 tests a
difference against an arm's own **within-run** cell-to-cell spread, and this rung shows that spread badly
understating the variation that matters. Every rung in this bench was measured that way.

That reaches further than this ladder. Every job-turn dollar figure this bench has published measures the regime
its run happened in. None has been repeated on a different day except this rung, and this rung reversed.

## What does not change

- **The product floor stays at 300,000** (rule 8) and no default, planner or release change follows (rule 10).
  The case for a default flip is weaker than it was this morning, not stronger.
- The quality record is untouched: 4/4 checkers passed, and every `jev_single` cell dispatched one worker,
  recorded `accept:1` and `outcome: completed`.
- Rule 2 held again: priming turns recorded `depth_unknown` and `admission_answer_only` at 193,082 and 192,822;
  only the job prompt was `orchestrated`.

## Spend

$6.69 across 4 sessions (estimate ≈ $9). Depth-ladder question to date: **$58.19**.
