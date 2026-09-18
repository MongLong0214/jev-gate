# jev-gate bench report (schema 4)

run: /Users/isaac/jev-gate-runs/v4-run-1
generated: 2026-09-18T01:13:07.934Z
plan schema: 4 · planned rows: 20 · independent units: 4 jobs / 4 groups

## arms (planned cohort)

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| frontier_native | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 1228003 | 1233402 | 4.4477 | 0.000000 | 4.4477 | 1.1119 | 449.0 | 112.2 (4) | true |
| sonnet_native | 4 | 4 | 0 | 0 | 0 | 0 | 3 | 1 | 0 | 0 | 1825427 | 1.1156 | 0.000000 | 1.1156 | 0.3719 | 301.4 | 85.2 (3) | true |
| fixed_hierarchy | 4 | 4 | 0 | 0 | 0 | 0 | 3 | 1 | 0 | 0 | 1692413 | 1.0461 | 0.000000 | 1.0461 | 0.3487 | 249.8 | 66.7 (3) | true |
| jev_hierarchy | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 1825443 | 1.0634 | 0.000000 | 1.0634 | 0.2658 | 251.8 | 62.9 (4) | true |
| native_hierarchy | 4 | 4 | 0 | 0 | 0 | 0 | 3 | 1 | 0 | 0 | 1620435 | 1.0591 | 0.000000 | 1.0591 | 0.3530 | 274.4 | 76.1 (3) | true |

## gate activity per arm

| arm | Agent calls | owned | pinned | eligible attempted | patched | preserved (reasons) | skipped (codes) | attempt unknown | missing pre records | hint delivered | target/actual mismatches | validity problems |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| frontier_native | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |
| sonnet_native | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |
| fixed_hierarchy | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |
| jev_hierarchy | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |
| native_hierarchy | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |

## comparisons (planned cohort; intended common rows)

| treatment vs control | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |
|---|---|---|---|---|---|---|---|
| jev_hierarchy vs native_hierarchy | 4 | 4/3 | 25.0 pts | -0.4% | 8.2% | ok | 4/4 rows: cost -0.4%, runtime 8.2%, pass 4/3 |
| jev_hierarchy vs fixed_hierarchy | 4 | 4/3 | 25.0 pts | -1.7% | -0.8% | ok | 4/4 rows: cost -1.7%, runtime -0.8%, pass 4/3 |
| jev_hierarchy vs sonnet_native | 4 | 4/3 | 25.0 pts | 4.7% | 16.5% | ok | 4/4 rows: cost 4.7%, runtime 16.5%, pass 4/3 |
| jev_hierarchy vs frontier_native | 4 | 4/4 | 0.0 pts | 76.1% | 43.9% | ok | 4/4 rows: cost 76.1%, runtime 43.9%, pass 4/4 |
| native_hierarchy vs sonnet_native | 4 | 3/3 | 0.0 pts | 5.1% | 9.0% | ok | 4/4 rows: cost 5.1%, runtime 9.0%, pass 3/3 |

## per-model tokens

- frontier_native: claude-haiku-4-5-20251001 in=5313 out=86 cacheRead=0 cacheCreate=0; claude-fable-5-1 in=968 out=32309 cacheRead=1067227 cacheCreate=127499
- sonnet_native: claude-haiku-4-5-20251001 in=5313 out=86 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=78 out=28934 cacheRead=1669383 cacheCreate=121633
- fixed_hierarchy: claude-haiku-4-5-20251001 in=5313 out=102 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=74 out=25945 cacheRead=1542965 cacheCreate=118014
- jev_hierarchy: claude-haiku-4-5-20251001 in=5313 out=86 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=80 out=24736 cacheRead=1676525 cacheCreate=118703
- native_hierarchy: claude-haiku-4-5-20251001 in=5313 out=82 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=70 out=27858 cacheRead=1466774 cacheCreate=120338

## rows

| job | rep | arm | status | quality | reason | elapsed s | Claude $ | Jev $ | Fable tokens | init model | Agent calls (owned/pinned) | attempted/patched/preserved | hint | mismatches |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cart-total | 1 | frontier_native | completed | pass | - | 55.1 | 0.8561 | 0.000000 | 187660 | claude-fable-5-1 | 0 (0/0) | 0/0/0 | 0 | 0 |
| cart-total | 1 | sonnet_native | completed | pass | - | 52.4 | 0.2093 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| cart-total | 1 | fixed_hierarchy | completed | pass | - | 35.8 | 0.1857 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| cart-total | 1 | jev_hierarchy | completed | pass | - | 36.9 | 0.2148 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| cart-total | 1 | native_hierarchy | completed | pass | - | 36.3 | 0.1933 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| todo-priority | 1 | fixed_hierarchy | completed | pass | - | 43.7 | 0.2196 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| todo-priority | 1 | native_hierarchy | completed | pass | - | 47.5 | 0.2202 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| todo-priority | 1 | frontier_native | completed | pass | - | 61.9 | 0.7492 | 0.000000 | 196196 | claude-fable-5-1 | 0 (0/0) | 0/0/0 | 0 | 0 |
| todo-priority | 1 | sonnet_native | completed | pass | - | 66.2 | 0.2350 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| todo-priority | 1 | jev_hierarchy | completed | pass | - | 48.2 | 0.2215 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| space-sim | 1 | native_hierarchy | completed | pass | - | 144.6 | 0.4507 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| space-sim | 1 | frontier_native | completed | pass | - | 171.3 | 1.6070 | 0.000000 | 282539 | claude-fable-5-1 | 0 (0/0) | 0/0/0 | 0 | 0 |
| space-sim | 1 | jev_hierarchy | completed | pass | - | 117.8 | 0.4290 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| space-sim | 1 | sonnet_native | completed | pass | - | 136.9 | 0.4675 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| space-sim | 1 | fixed_hierarchy | completed | pass | - | 120.5 | 0.4271 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| job-queue | 1 | native_hierarchy | completed | fail | failed: regression_tests_detect_bug | 46.0 | 0.1949 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| job-queue | 1 | sonnet_native | completed | fail | failed: regression_tests_detect_bug | 45.9 | 0.2038 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| job-queue | 1 | jev_hierarchy | completed | pass | - | 48.9 | 0.1981 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| job-queue | 1 | fixed_hierarchy | completed | fail | failed: regression_tests_detect_bug | 49.8 | 0.2136 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| job-queue | 1 | frontier_native | completed | pass | - | 160.7 | 1.2354 | 0.000000 | 561608 | claude-fable-5-1 | 0 (0/0) | 0/0/0 | 0 | 0 |

## notes

- Rows come from plan.json. missing_record means the planned cell has no saved file; it is not "not started" and never cost zero.
- Claude total_cost_usd is an API-equivalent estimate (whole tree incl. children), not subscription billing or quota; Jev cost is list price × input tokens, null when any attempt has unknown usage.
- Totals are over the planned cohort including failures and timeouts; a null total means some consumption is unknown and the known subtotal is shown beside it.
- The complete-case diagnostic is labeled and lists exclusions; it never replaces the planned-cohort headline. Per-row percentages are not averaged.
- A timeout duration is not time-to-success; completed_pass_latency is reported separately with its count.
- Whole jobs are the unit; repetitions and child tasks of one job are clustered observations. Same pass counts are not evidence of equivalence.
- Historical V3 runs lack V4 gate fields; those stay unknown rather than being inferred.
