# jev-gate bench report (schema 5)

run: /Users/isaac/jev-gate-runs/v5-dogfood-0918
generated: 2026-09-18T13:09:47.799Z
plan schema: 5 · planned rows: 8 · independent units: 4 jobs / 4 groups

**conclusion: no admission exposure** — Gate A never admitted a prompt as orchestrated

## arms (planned cohort)

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 846595 | 0.5989 | 0.000115 | 0.5990 | 0.1498 | 79.7 | 19.9 (4) | true |
| sonnet_native | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 888240 | 0.6327 | 0.000000 | 0.6327 | 0.1582 | 93.2 | 23.3 (4) | true |

## job search-race

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 258436 | 0.1747 | 0.000029 | 0.1748 | 0.1748 | 25.6 | 25.6 (1) | true |
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 262408 | 0.1934 | 0.000000 | 0.1934 | 0.1934 | 38.5 | 38.5 (1) | true |

### V5 gates — search-race

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 1 | direct:1 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:1 | 0 | 0 |
| sonnet_native | 1 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## job quote-pricing

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 252592 | 0.1564 | 0.000028 | 0.1565 | 0.1565 | 23.6 | 23.6 (1) | true |
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 250710 | 0.1572 | 0.000000 | 0.1572 | 0.1572 | 18.4 | 18.4 (1) | true |

### V5 gates — quote-pricing

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 1 | direct:1 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:1 | 0 | 0 |
| sonnet_native | 1 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## job status-count

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 210272 | 0.1523 | 0.000000 | 0.1523 | 0.1523 | 25.0 | 25.0 (1) | true |
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 167924 | 0.1344 | 0.000030 | 0.1345 | 0.1345 | 18.0 | 18.0 (1) | true |

### V5 gates — status-count

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 1 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| jev_hierarchy | 1 | direct:1 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:1 | 0 | 0 |

## job ttl-cache

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 164850 | 0.1298 | 0.000000 | 0.1298 | 0.1298 | 11.4 | 11.4 (1) | true |
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 167643 | 0.1333 | 0.000028 | 0.1333 | 0.1333 | 12.6 | 12.6 (1) | true |

### V5 gates — ttl-cache

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
| jev_hierarchy | 4 | direct:4 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:4 | 0 | 0 |
| sonnet_native | 4 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## Jev requests per arm (attempts / input tokens / est $ at the dated price)

| arm | admission | allocation | result | scope | influence (changed/judged) |
|---|---|---|---|---|---|
| jev_hierarchy | 4 / 2732 / 0.000115 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/4 |
| sonnet_native | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/0 |

## worker tier distribution (observed models and root effort)


## comparisons (planned cohort; intended common rows)

| treatment vs control | criterion | verdict | reason | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |
|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy vs sonnet_native | pass_not_below | met | pass 4 is not below 4 | 4 | 4/4 | 0.0 pts | 5.3% | 14.5% | ok | 4/4 rows: cost 5.3%, runtime 14.5%, pass 4/4 |

## cost by model family (API-equivalent) and Jev cost

- jev_hierarchy: haiku 0.0047, sonnet 0.5942 · Jev 0.000115 · total 0.5990
- sonnet_native: haiku 0.0047, sonnet 0.6281 · Jev 0.000000 · total 0.6327

## per-model tokens

- jev_hierarchy: claude-haiku-4-5-20251001 in=4242 out=91 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=40 out=4406 cacheRead=737152 cacheCreate=100664
- sonnet_native: claude-haiku-4-5-20251001 in=4242 out=85 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=42 out=6720 cacheRead=775746 cacheCreate=101405

## rows

| job | rep | arm | status | quality | reason | elapsed s | Claude $ | Jev $ | Fable tokens | init model | Agent calls (owned/pinned) | attempted/patched/preserved | hint | mismatches |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search-race | 1 | jev_hierarchy | completed | pass | - | 25.6 | 0.1747 | 0.000029 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| search-race | 1 | sonnet_native | completed | pass | - | 38.5 | 0.1934 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| quote-pricing | 1 | jev_hierarchy | completed | pass | - | 23.6 | 0.1564 | 0.000028 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| quote-pricing | 1 | sonnet_native | completed | pass | - | 18.4 | 0.1572 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| status-count | 1 | sonnet_native | completed | pass | - | 25.0 | 0.1523 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| status-count | 1 | jev_hierarchy | completed | pass | - | 18.0 | 0.1344 | 0.000030 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ttl-cache | 1 | sonnet_native | completed | pass | - | 11.4 | 0.1298 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ttl-cache | 1 | jev_hierarchy | completed | pass | - | 12.6 | 0.1333 | 0.000028 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |

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
wrote /Users/isaac/jev-gate-runs/v5-dogfood-0918/reports/report-2.md and /Users/isaac/jev-gate-runs/v5-dogfood-0918/reports/report-2.json
