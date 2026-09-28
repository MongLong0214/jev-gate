# jev-gate bench report (schema 5)

run: /Users/isaac/jev-gate-runs/v5-ctx-0919
generated: 2026-09-18T22:12:45.832Z
plan schema: 5 · planned rows: 6 · independent units: 2 jobs / 1 groups

**conclusion: no admission exposure** — Gate A never admitted a prompt as orchestrated; the diagnostic arm jev_forced_orchestration carries the Gate B/C observation for this run

## arms (planned cohort)

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration (diagnostic) | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 4746123 | 3.5810 | 0.000847 | 3.5819 | 1.7909 | 585.3 | 292.7 (2) | true |
| jev_hierarchy | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 18048714 | 5.4730 | 0.000066 | 5.4731 | 2.7365 | 353.0 | 176.5 (2) | true |
| sonnet_native | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 23767766 | 6.5999 | 0.000000 | 6.5999 | 3.3000 | 415.2 | 207.6 (2) | true |

## job wide-validators

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration (diagnostic) | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 911598 | 0.8888 | 0.000177 | 0.8890 | 0.8890 | 199.3 | 199.3 (1) | true |
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 398573 | 0.3285 | 0.000031 | 0.3286 | 0.3286 | 78.7 | 78.7 (1) | true |
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 390633 | 0.3148 | 0.000000 | 0.3148 | 0.3148 | 90.6 | 90.6 (1) | true |

### V5 gates — wide-validators

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 1 | forced:orchestrated:1 | 2 (0) | 1/1 | deep:1 | claude-opus-5:1 | ready:1 | standard:1(patched 0, preserved 1, pinned 0) | accept:1 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:1 | 1/1 | completed:1 | 0 | 0 |
| jev_hierarchy | 1 | direct:1 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:1 | 0 | 0 |
| sonnet_native | 1 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## job wide-validators-loaded

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration (diagnostic) | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 3834525 | 2.6922 | 0.000670 | 2.6929 | 2.6929 | 386.0 | 386.0 (1) | true |
| sonnet_native | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 23377133 | 6.2851 | 0.000000 | 6.2851 | 6.2851 | 324.6 | 324.6 (1) | true |
| jev_hierarchy | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 17650141 | 5.1444 | 0.000035 | 5.1445 | 5.1445 | 274.3 | 274.3 (1) | true |

### V5 gates — wide-validators-loaded

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 1 | forced:orchestrated:1 | 0 (0) | 1/1 | deep:1 | claude-opus-5:1 | ready:1 | standard:6(patched 0, preserved 6, pinned 0) | accept:6 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:6 | 1/1 | completed:1 | 0 | 0 |
| sonnet_native | 1 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| jev_hierarchy | 1 | direct:1 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:1 | 0 | 0 |

## gate activity per arm

| arm | Agent calls | owned | pinned | eligible attempted | patched | preserved (reasons) | skipped (codes) | attempt unknown | missing pre records | hint delivered | target/actual mismatches | validity problems |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 9 | 9 | 0 | 9 | 0 | 7 (route_low_confidence:7) | unknown:2 | 0 | 0 | 0 | 0 | - |
| jev_hierarchy | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |
| sonnet_native | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |

## V5 gates per arm (observed)

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 2 | forced:orchestrated:2 | 2 (0) | 2/2 | deep:2 | claude-opus-5:2 | ready:2 | standard:7(patched 0, preserved 7, pinned 0) | accept:7 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:7 | 1/1 | completed:2 | 0 | 0 |
| jev_hierarchy | 2 | direct:2 | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | completed:2 | 0 | 0 |
| sonnet_native | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## Jev requests per arm (attempts / input tokens / est $ at the dated price)

| arm | admission | allocation | result | scope | influence (changed/judged) |
|---|---|---|---|---|---|
| jev_forced_orchestration | 0 / 0 / 0.000000 | 9 / 20171 / 0.000847 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/9 |
| jev_hierarchy | 2 / 1570 / 0.000066 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/2 |
| sonnet_native | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/0 |

## worker tier distribution (observed models and root effort)

- jev_forced_orchestration standard: calls 7, proposed fast:7, observed claude-sonnet-5:7, root effort high:7

## comparisons (planned cohort; intended common rows)

| treatment vs control | criterion | verdict | reason | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |
|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy vs sonnet_native | pass_not_below | met | pass 2 is not below 2 | 2 | 2/2 | 0.0 pts | 17.1% | 15.0% | ok | 2/2 rows: cost 17.1%, runtime 15.0%, pass 2/2 |
| jev_forced_orchestration vs jev_hierarchy | none | not_comparable | descriptive row: no declared criterion | 2 | 2/2 | 0.0 pts | 34.6% | -65.8% | ok | 2/2 rows: cost 34.6%, runtime -65.8%, pass 2/2 |

## cost by model family (API-equivalent) and Jev cost

- jev_forced_orchestration: haiku 0.0026, sonnet 2.7984, opus 0.7800 · Jev 0.000847 · total 3.5819
- jev_hierarchy: haiku 0.0026, sonnet 5.4704 · Jev 0.000066 · total 5.4731
- sonnet_native: haiku 0.0027, sonnet 6.5973 · Jev 0.000000 · total 6.5999

## per-model tokens

- jev_forced_orchestration: claude-haiku-4-5-20251001 in=2391 out=40 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=170 out=43881 cacheRead=3890104 cacheCreate=587485; claude-opus-5[1m] in=20 out=16164 cacheRead=158412 cacheCreate=47456
- jev_hierarchy: claude-haiku-4-5-20251001 in=2391 out=40 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=134 out=23010 cacheRead=17592769 cacheCreate=430370
- sonnet_native: claude-haiku-4-5-20251001 in=2391 out=52 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=164 out=22681 cacheRead=23315728 cacheCreate=426750

## rows

| job | rep | arm | status | quality | reason | elapsed s | Claude $ | Jev $ | Fable tokens | init model | Agent calls (owned/pinned) | attempted/patched/preserved | hint | mismatches |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wide-validators | 1 | jev_forced_orchestration | completed | pass | - | 199.3 | 0.8888 | 0.000177 | 0 | claude-sonnet-5 | 2 (2/0) | 2/0/1 | 0 | 0 |
| wide-validators | 1 | jev_hierarchy | completed | pass | - | 78.7 | 0.3285 | 0.000031 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| wide-validators | 1 | sonnet_native | completed | pass | - | 90.6 | 0.3148 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| wide-validators-loaded | 1 | jev_forced_orchestration | completed | pass | - | 386.0 | 2.6922 | 0.000670 | 0 | claude-sonnet-5 | 7 (7/0) | 7/0/6 | 0 | 0 |
| wide-validators-loaded | 1 | sonnet_native | completed | pass | - | 324.6 | 6.2851 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| wide-validators-loaded | 1 | jev_hierarchy | completed | pass | - | 274.3 | 5.1444 | 0.000035 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |

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
wrote /Users/isaac/jev-gate-runs/v5-ctx-0919/reports/report-1.md and /Users/isaac/jev-gate-runs/v5-ctx-0919/reports/report-1.json
