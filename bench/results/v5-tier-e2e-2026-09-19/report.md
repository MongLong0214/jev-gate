# jev-gate bench report (schema 5)

run: /Users/isaac/jev-gate-runs/v5-tier-e2e
generated: 2026-09-18T23:06:45.631Z
plan schema: 5 · planned rows: 2 · independent units: 2 jobs / 1 groups

**conclusion: insufficient observation** — no completed jev_hierarchy session in this run

## arms (planned cohort)

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration (diagnostic) | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 3072581 | 2.0704 | 0.000517 | 2.0709 | 1.0355 | 524.0 | 262.0 (2) | true |

## job wide-validators

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration (diagnostic) | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 1282091 | 0.9239 | 0.000312 | 0.9242 | 0.9242 | 235.7 | 235.7 (1) | true |

### V5 gates — wide-validators

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 1 | forced:orchestrated:1 | 0 (0) | 1/1 | deep:1 | claude-opus-5:1 | ready:1 | standard:3(patched 1, preserved 2, pinned 0) | accept:3 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:3 | 1/1 | completed:1 | 0 | 2 |

## job wide-validators-loaded

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration (diagnostic) | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 1790490 | 1.1465 | 0.000205 | 1.1467 | 1.1467 | 288.3 | 288.3 (1) | true |

### V5 gates — wide-validators-loaded

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 1 | forced:orchestrated:1 | 4 (0) | 1/1 | deep:1 | claude-opus-5:1 | ready:1 | standard:1(patched 0, preserved 1, pinned 0) | accept:1 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:1 | 1/1 | completed:1 | 0 | 1 |

## gate activity per arm

| arm | Agent calls | owned | pinned | eligible attempted | patched | preserved (reasons) | skipped (codes) | attempt unknown | missing pre records | hint delivered | target/actual mismatches | validity problems |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 6 | 6 | 0 | 6 | 1 | 3 (route_low_confidence:3) | unknown:2 | 0 | 0 | 0 | 3 | - |

## V5 gates per arm (observed)

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 2 | forced:orchestrated:2 | 4 (0) | 2/2 | deep:2 | claude-opus-5:2 | ready:2 | standard:4(patched 1, preserved 3, pinned 0) | accept:4 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:4 | 1/1 | completed:2 | 0 | 3 |

## Jev requests per arm (attempts / input tokens / est $ at the dated price)

| arm | admission | allocation | result | scope | influence (changed/judged) |
|---|---|---|---|---|---|
| jev_forced_orchestration | 0 / 0 / 0.000000 | 6 / 12309 / 0.000517 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/6 |

## worker tier distribution (observed models and root effort)

- jev_forced_orchestration standard: calls 4, proposed standard:4, observed claude-sonnet-5:3 claude-haiku-4-5-20251001:1, root effort high:4

## comparisons (planned cohort; intended common rows)

| treatment vs control | criterion | verdict | reason | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |
|---|---|---|---|---|---|---|---|---|---|---|

## cost by model family (API-equivalent) and Jev cost

- jev_forced_orchestration: haiku 0.1395, sonnet 1.2671, opus 0.6638 · Jev 0.000517 · total 2.0709

## per-model tokens

- jev_forced_orchestration: claude-haiku-4-5-20251001 in=2593 out=7627 cacheRead=597902 cacheCreate=31205; claude-sonnet-5 in=122 out=31150 cacheRead=2032536 cacheCreate=168765; claude-opus-5[1m] in=18 out=13030 cacheRead=145181 cacheCreate=42452

## rows

| job | rep | arm | status | quality | reason | elapsed s | Claude $ | Jev $ | Fable tokens | init model | Agent calls (owned/pinned) | attempted/patched/preserved | hint | mismatches |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wide-validators | 1 | jev_forced_orchestration | completed | pass | - | 235.7 | 0.9239 | 0.000312 | 0 | claude-sonnet-5 | 4 (4/0) | 4/1/2 | 0 | 2 |
| wide-validators-loaded | 1 | jev_forced_orchestration | completed | pass | - | 288.3 | 1.1465 | 0.000205 | 0 | claude-sonnet-5 | 2 (2/0) | 2/0/1 | 0 | 1 |

## notes

- Rows come from plan.json. missing_record means the planned cell has no saved file; it is not "not started" and never cost zero.
- Claude total_cost_usd is an API-equivalent estimate (whole tree incl. children), not subscription billing or quota; Jev cost is list price × input tokens, null when any attempt has unknown usage.
- Totals are over the planned cohort including failures and timeouts; a null total means some consumption is unknown and the known subtotal is shown beside it.
- The complete-case diagnostic is labeled and lists exclusions; it never replaces the planned-cohort headline. Per-row percentages are not averaged.
- A timeout duration is not time-to-success; completed_pass_latency is reported separately with its count.
- Whole jobs are the unit; repetitions and child tasks of one job are clustered observations. Same pass counts are not evidence of equivalence.
- Historical V3/V4 runs lack schema-5 gate fields; those stay unknown rather than being inferred, and the retired fixed_hierarchy arm is still read.
- A verdict is met only against a declared criterion at equal checker pass; different pass counts are printed as a trade-off row and zero passes in both arms never yield met.
- Effort is recorded where the host exposed it (root effort at PostToolUse) and is otherwise unknown; it is never inferred from agent frontmatter.
- Reservation overlap needs the dispatch record a Jev call writes, so arms without Gate B report observed overlap only (post timestamp minus tool_response.totalDurationMs).
- A recorded Gate B decision is authoritative; decision mismatch counts the calls whose observed model family contradicts it, as a cross-check rather than a correction.
- An arm marked diagnostic (A16: jev_forced_orchestration, which skips Gate A and still calls Gate B and C) answers a mechanism question; it carries no product claim and the conclusion category is read from jev_hierarchy.
wrote /Users/isaac/jev-gate-runs/v5-tier-e2e/reports/report-1.md and /Users/isaac/jev-gate-runs/v5-tier-e2e/reports/report-1.json
