# jev-gate bench report (schema 5)

run: /Users/isaac/jev-gate-runs/v5-single-vs-native
generated: 2026-09-19T11:40:53.384Z
plan schema: 5 · planned rows: 8 · independent units: 2 jobs / 2 groups

**conclusion: insufficient observation** — no completed jev_hierarchy session in this run

## arms (planned cohort)

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 77911488 | 22.9332 | 0.000000 | 22.9332 | 5.7333 | 1131.7 | 282.9 (4) | true |
| jev_single | 4 | 4 | 0 | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 48789485 | 17.4634 | 0.000708 | 17.4641 | 4.3660 | 1611.7 | 402.9 (4) | true |

## job wide-validators-primed-30

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 43113546 | 11.8357 | 0.000000 | 11.8357 | 5.9179 | 327.9 | 164.0 (2) | true |
| jev_single | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 20028036 | 7.4762 | 0.000231 | 7.4764 | 3.7382 | 484.1 | 242.1 (2) | true |

### V5 gates — wide-validators-primed-30

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| jev_single | 2 | orchestrated:2 | 2 (0) | 0/0 | - | - | - | standard:2(patched 2, preserved 0, pinned 0) | accept:2 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:2 | 1/1 | completed:2 | 0 | 0 |

## job orbit-core-primed-30

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_single | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 28761449 | 9.9872 | 0.000477 | 9.9877 | 4.9938 | 1127.6 | 563.8 (2) | true |
| sonnet_native | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 34797942 | 11.0975 | 0.000000 | 11.0975 | 5.5488 | 803.8 | 401.9 (2) | true |

### V5 gates — orbit-core-primed-30

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_single | 2 | orchestrated:2 | 1 (0) | 0/0 | - | - | - | standard:2(patched 2, preserved 0, pinned 0) | accept:2 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:2 | 1/1 | completed:2 | 0 | 0 |
| sonnet_native | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## gate activity per arm

| arm | Agent calls | owned | pinned | eligible attempted | patched | preserved (reasons) | skipped (codes) | attempt unknown | missing pre records | hint delivered | target/actual mismatches | validity problems |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |
| jev_single | 4 | 4 | 0 | 4 | 4 | 0 (-) | unknown:4 | 0 | 0 | 0 | 0 | - |

## V5 gates per arm (observed)

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| sonnet_native | 4 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| jev_single | 4 | orchestrated:4 | 3 (0) | 0/0 | - | - | - | standard:4(patched 4, preserved 0, pinned 0) | accept:4 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:4 | 1/1 | completed:4 | 0 | 0 |

## Jev requests per arm (attempts / input tokens / est $ at the dated price)

| arm | admission | allocation | result | scope | influence (changed/judged) |
|---|---|---|---|---|---|
| sonnet_native | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/0 |
| jev_single | 8 / 9908 / 0.000416 | 4 / 6947 / 0.000292 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 4/12 |

## worker tier distribution (observed models and root effort)

- jev_single standard: calls 4, proposed standard:4, observed claude-sonnet-5:4, root effort high:4

## comparisons (planned cohort; intended common rows)

| treatment vs control | criterion | verdict | reason | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |
|---|---|---|---|---|---|---|---|---|---|---|

## cost by model family (API-equivalent) and Jev cost

- sonnet_native: sonnet 22.9332 · Jev 0.000000 · total 22.9332
- jev_single: sonnet 17.4634 · Jev 0.000708 · total 17.4641

## per-model tokens

- sonnet_native: claude-sonnet-5 in=502 out=119203 cacheRead=76164985 cacheCreate=1626798
- jev_single: claude-sonnet-5 in=480 out=132839 cacheRead=46882871 cacheCreate=1773295

## rows

| job | rep | arm | status | quality | reason | elapsed s | Claude $ | Jev $ | Fable tokens | init model | Agent calls (owned/pinned) | attempted/patched/preserved | hint | mismatches |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wide-validators-primed-30 | 1 | sonnet_native | completed | pass | - | 137.9 | 5.4021 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| wide-validators-primed-30 | 1 | jev_single | completed | pass | - | 271.6 | 3.7044 | 0.000120 | 0 | claude-sonnet-5 | 1 (1/0) | 1/1/0 | 0 | 0 |
| wide-validators-primed-30 | 2 | jev_single | completed | pass | - | 212.6 | 3.7718 | 0.000110 | 0 | claude-sonnet-5 | 1 (1/0) | 1/1/0 | 0 | 0 |
| wide-validators-primed-30 | 2 | sonnet_native | completed | pass | - | 190.0 | 6.4337 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| orbit-core-primed-30 | 1 | jev_single | completed | pass | - | 538.8 | 4.7870 | 0.000232 | 0 | claude-sonnet-5 | 1 (1/0) | 1/1/0 | 0 | 0 |
| orbit-core-primed-30 | 1 | sonnet_native | completed | pass | - | 448.0 | 5.8874 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| orbit-core-primed-30 | 2 | sonnet_native | completed | pass | - | 355.8 | 5.2101 | 0.000000 | 0 | claude-sonnet-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| orbit-core-primed-30 | 2 | jev_single | completed | pass | - | 588.7 | 5.2002 | 0.000245 | 0 | claude-sonnet-5 | 1 (1/0) | 1/1/0 | 0 | 0 |

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
