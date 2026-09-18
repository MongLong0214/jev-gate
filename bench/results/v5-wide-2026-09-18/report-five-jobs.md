# jev-gate bench report (schema 5)

run: /Users/isaac/jev-gate-runs/v5-wide-0918
generated: 2026-09-18T13:29:01.156Z
plan schema: 5 · planned rows: 10 · independent units: 5 jobs / 5 groups

**conclusion: no admission exposure** — Gate A never admitted a prompt as orchestrated

## arms (planned cohort)

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 5 | 5 | 0 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 1301820 | 0.9467 | 0.000146 | 0.9468 | 0.1894 | 161.3 | 32.3 (5) | true |
| sonnet_native | 5 | 5 | 0 | 0 | 0 | 0 | 5 | 0 | 0 | 0 | 1231033 | 0.9191 | 0.000000 | 0.9191 | 0.1838 | 153.8 | 30.8 (5) | true |

## job search-race

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 260609 | 0.1787 | 0.000029 | 0.1788 | 0.1788 | 36.6 | 36.6 (1) | true |
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 259452 | 0.1870 | 0.000000 | 0.1870 | 0.1870 | 34.3 | 34.3 (1) | true |

### V5 gates — search-race

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 1 | direct:1 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:1 | 0 | 0 |
| sonnet_native | 1 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## job quote-pricing

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 254055 | 0.1586 | 0.000028 | 0.1586 | 0.1586 | 16.8 | 16.8 (1) | true |
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 249312 | 0.1536 | 0.000000 | 0.1536 | 0.1536 | 25.5 | 25.5 (1) | true |

### V5 gates — quote-pricing

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 1 | direct:1 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:1 | 0 | 0 |
| sonnet_native | 1 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## job status-count

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 165387 | 0.1320 | 0.000000 | 0.1320 | 0.1320 | 12.3 | 12.3 (1) | true |
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 167881 | 0.1343 | 0.000030 | 0.1343 | 0.1343 | 16.1 | 16.1 (1) | true |

### V5 gates — status-count

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 1 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| jev_hierarchy | 1 | direct:1 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:1 | 0 | 0 |

## job ttl-cache

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 166061 | 0.1348 | 0.000000 | 0.1348 | 0.1348 | 14.6 | 14.6 (1) | true |
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 168291 | 0.1361 | 0.000028 | 0.1361 | 0.1361 | 18.6 | 18.6 (1) | true |

### V5 gates — ttl-cache

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 1 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| jev_hierarchy | 1 | direct:1 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:1 | 0 | 0 |

## job wide-validators

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 390821 | 0.3117 | 0.000000 | 0.3117 | 0.3117 | 67.1 | 67.1 (1) | true |
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 450984 | 0.3390 | 0.000031 | 0.3390 | 0.3390 | 73.1 | 73.1 (1) | true |

### V5 gates — wide-validators

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 1 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| jev_hierarchy | 1 | direct:1 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:1 | 0 | 0 |

## gate activity per arm

| arm | Agent calls | owned | pinned | eligible attempted | patched | preserved (reasons) | skipped (codes) | attempt unknown | missing pre records | hint delivered | target/actual mismatches | validity problems |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |
| sonnet_native | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |

## V5 gates per arm (observed)

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 5 | direct:5 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:5 | 0 | 0 |
| sonnet_native | 5 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## Jev requests per arm (attempts / input tokens / est $ at the dated price)

| arm | admission | allocation | result | scope | influence (changed/judged) |
|---|---|---|---|---|---|
| jev_hierarchy | 5 / 3465 / 0.000146 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/5 |
| sonnet_native | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/0 |

## worker tier distribution (observed models and root effort)


## comparisons (planned cohort; intended common rows)

| treatment vs control | criterion | verdict | reason | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |
|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy vs sonnet_native | pass_not_below | met | pass 5 is not below 5 | 5 | 5/5 | 0.0 pts | -3.0% | -4.9% | ok | 5/5 rows: cost -3.0%, runtime -4.9%, pass 5/5 |

## cost by model family (API-equivalent) and Jev cost

- jev_hierarchy: haiku 0.0060, sonnet 0.9407 · Jev 0.000146 · total 0.9468
- sonnet_native: haiku 0.0060, sonnet 0.9131 · Jev 0.000000 · total 0.9191

## per-model tokens

- jev_hierarchy: claude-haiku-4-5-20251001 in=5366 out=120 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=58 out=14589 cacheRead=1140011 cacheCreate=141676
- sonnet_native: claude-haiku-4-5-20251001 in=5366 out=123 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=56 out=14663 cacheRead=1072870 cacheCreate=137955

## rows

| job | rep | arm | status | quality | reason | elapsed s | Claude $ | Jev $ | Fable tokens | init model | Agent calls (owned/pinned) | attempted/patched/preserved | hint | mismatches |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search-race | 1 | jev_hierarchy | completed | pass | - | 36.6 | 0.1787 | 0.000029 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| search-race | 1 | sonnet_native | completed | pass | - | 34.3 | 0.1870 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| quote-pricing | 1 | jev_hierarchy | completed | pass | - | 16.8 | 0.1586 | 0.000028 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| quote-pricing | 1 | sonnet_native | completed | pass | - | 25.5 | 0.1536 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| status-count | 1 | sonnet_native | completed | pass | - | 12.3 | 0.1320 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| status-count | 1 | jev_hierarchy | completed | pass | - | 16.1 | 0.1343 | 0.000030 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ttl-cache | 1 | sonnet_native | completed | pass | - | 14.6 | 0.1348 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ttl-cache | 1 | jev_hierarchy | completed | pass | - | 18.6 | 0.1361 | 0.000028 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| wide-validators | 1 | sonnet_native | completed | pass | - | 67.1 | 0.3117 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| wide-validators | 1 | jev_hierarchy | completed | pass | - | 73.1 | 0.3390 | 0.000031 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |

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
wrote /Users/isaac/jev-gate-runs/v5-wide-0918/reports/report-1.md and /Users/isaac/jev-gate-runs/v5-wide-0918/reports/report-1.json
