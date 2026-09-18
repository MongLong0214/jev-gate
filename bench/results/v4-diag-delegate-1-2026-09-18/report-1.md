# jev-gate bench report (schema 4)

run: /Users/isaac/jev-gate-runs/v4-diag-delegate-1
generated: 2026-09-18T01:36:14.507Z
plan schema: 4 · planned rows: 8 · independent units: 4 jobs / 4 groups

## arms (planned cohort)

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 2070834 | 2.3736 | 0.000531 | 2.3741 | 0.5935 | 541.4 | 135.3 (4) | true |
| native_hierarchy | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 1946990 | 1.7235 | 0.000000 | 1.7235 | 0.4309 | 512.8 | 128.2 (4) | true |

## gate activity per arm

| arm | Agent calls | owned | pinned | eligible attempted | patched | preserved (reasons) | skipped (codes) | attempt unknown | missing pre records | hint delivered | target/actual mismatches | validity problems |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_hierarchy | 4 | 4 | 0 | 4 | 2 | 2 (route_low_confidence:2) | - | 0 | 0 | 2 | 0 | - |
| native_hierarchy | 4 | 4 | 0 | 0 | 0 | 0 (-) | mode_native:4 | 0 | 0 | 0 | 0 | - |

## comparisons (planned cohort; intended common rows)

| treatment vs control | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |
|---|---|---|---|---|---|---|---|
| jev_hierarchy vs native_hierarchy | 4 | 4/4 | 0.0 pts | -37.7% | -5.6% | ok | 4/4 rows: cost -37.7%, runtime -5.6%, pass 4/4 |

## per-model tokens

- jev_hierarchy: claude-haiku-4-5-20251001 in=5777 out=100 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=86 out=35412 cacheRead=1319070 cacheCreate=178360; claude-opus-5[1m] in=34 out=16471 cacheRead=476993 cacheCreate=38531
- native_hierarchy: claude-haiku-4-5-20251001 in=5777 out=78 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=112 out=51392 cacheRead=1672452 cacheCreate=217179

## rows

| job | rep | arm | status | quality | reason | elapsed s | Claude $ | Jev $ | Fable tokens | init model | Agent calls (owned/pinned) | attempted/patched/preserved | hint | mismatches |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| cart-total | 1 | jev_hierarchy | completed | pass | - | 75.2 | 0.3047 | 0.000097 | 0 | claude-sonnet-5 | 1 (1/0) | 1/1/0 | 1 | 0 |
| cart-total | 1 | native_hierarchy | completed | pass | - | 80.3 | 0.3104 | 0.000000 | 0 | claude-sonnet-5 | 1 (1/0) | 0/0/0 | 0 | 0 |
| todo-priority | 1 | jev_hierarchy | completed | pass | - | 101.6 | 0.3774 | 0.000126 | 0 | claude-sonnet-5 | 1 (1/0) | 1/0/1 | 0 | 0 |
| todo-priority | 1 | native_hierarchy | completed | pass | - | 92.5 | 0.3407 | 0.000000 | 0 | claude-sonnet-5 | 1 (1/0) | 0/0/0 | 0 | 0 |
| space-sim | 1 | native_hierarchy | completed | pass | - | 232.8 | 0.6937 | 0.000000 | 0 | claude-sonnet-5 | 1 (1/0) | 0/0/0 | 0 | 0 |
| space-sim | 1 | jev_hierarchy | completed | pass | - | 282.5 | 1.3460 | 0.000194 | 0 | claude-sonnet-5 | 1 (1/0) | 1/1/0 | 1 | 0 |
| job-queue | 1 | jev_hierarchy | completed | pass | - | 82.1 | 0.3454 | 0.000114 | 0 | claude-sonnet-5 | 1 (1/0) | 1/0/1 | 0 | 0 |
| job-queue | 1 | native_hierarchy | completed | pass | - | 107.3 | 0.3787 | 0.000000 | 0 | claude-sonnet-5 | 1 (1/0) | 0/0/0 | 0 | 0 |

## notes

- Rows come from plan.json. missing_record means the planned cell has no saved file; it is not "not started" and never cost zero.
- Claude total_cost_usd is an API-equivalent estimate (whole tree incl. children), not subscription billing or quota; Jev cost is list price × input tokens, null when any attempt has unknown usage.
- Totals are over the planned cohort including failures and timeouts; a null total means some consumption is unknown and the known subtotal is shown beside it.
- The complete-case diagnostic is labeled and lists exclusions; it never replaces the planned-cohort headline. Per-row percentages are not averaged.
- A timeout duration is not time-to-success; completed_pass_latency is reported separately with its count.
- Whole jobs are the unit; repetitions and child tasks of one job are clustered observations. Same pass counts are not evidence of equivalence.
- Historical V3 runs lack V4 gate fields; those stay unknown rather than being inferred.
