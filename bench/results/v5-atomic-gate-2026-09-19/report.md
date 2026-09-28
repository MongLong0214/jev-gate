# jev-gate bench report (schema 5)

run: /Users/isaac/jev-gate-runs/v5-atomic
generated: 2026-09-19T00:19:16.005Z
plan schema: 5 · planned rows: 2 · independent units: 2 jobs / 1 groups

**conclusion: insufficient observation** — no completed jev_hierarchy session in this run

## arms (planned cohort)

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration (diagnostic) | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 6048298 | 3.0427 | 0.001228 | 3.0439 | 1.5219 | 1061.4 | 530.7 (2) | true |

## job wide-validators

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration (diagnostic) | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 3588259 | 1.7112 | 0.000850 | 1.7121 | 1.7121 | 603.6 | 603.6 (1) | true |

### V5 gates — wide-validators

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 1 | forced:orchestrated:1 | 2 (0) | 1/1 | deep:1 | claude-opus-5:1 | ready:1 | standard:12(patched 11, preserved 1, pinned 0) | accept:12 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:12 | 1/1 | completed:1 | 0 | 0 |

## job wide-validators-loaded

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration (diagnostic) | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 2460039 | 1.3315 | 0.000378 | 1.3318 | 1.3318 | 457.8 | 457.8 (1) | true |

### V5 gates — wide-validators-loaded

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 1 | forced:orchestrated:1 | 3 (0) | 1/1 | deep:1 | claude-opus-5:1 | ready:1 | standard:4(patched 4, preserved 0, pinned 0) | accept:4 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:4 | 1/1 | completed:1 | 0 | 0 |

## gate activity per arm

| arm | Agent calls | owned | pinned | eligible attempted | patched | preserved (reasons) | skipped (codes) | attempt unknown | missing pre records | hint delivered | target/actual mismatches | validity problems |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 18 | 18 | 0 | 18 | 15 | 1 (unknown:1) | unknown:2 | 0 | 0 | 0 | 0 | - |

## V5 gates per arm (observed)

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_forced_orchestration | 2 | forced:orchestrated:2 | 5 (0) | 2/2 | deep:2 | claude-opus-5:2 | ready:2 | standard:16(patched 15, preserved 1, pinned 0) | accept:16 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:16 | 1/1 | completed:2 | 0 | 0 |

## Jev requests per arm (attempts / input tokens / est $ at the dated price)

| arm | admission | allocation | result | scope | influence (changed/judged) |
|---|---|---|---|---|---|
| jev_forced_orchestration | 0 / 0 / 0.000000 | 18 / 29231 / 0.001228 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 15/18 |

## worker tier distribution (observed models and root effort)

- jev_forced_orchestration standard: calls 16, proposed fast:15 standard:1, observed claude-haiku-4-5-20251001:15 claude-sonnet-5:1, root effort high:16

## comparisons (planned cohort; intended common rows)

| treatment vs control | criterion | verdict | reason | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |
|---|---|---|---|---|---|---|---|---|---|---|

## cost by model family (API-equivalent) and Jev cost

- jev_forced_orchestration: haiku 1.0211, sonnet 1.1296, opus 0.8920 · Jev 0.001228 · total 3.0439

## per-model tokens

- jev_forced_orchestration: claude-haiku-4-5-20251001 in=3829 out=59097 cacheRead=3562315 cacheCreate=292469; claude-sonnet-5 in=68 out=20985 cacheRead=1753144 cacheCreate=151743; claude-opus-5[1m] in=18 out=21033 cacheRead=135900 cacheCreate=47697

## rows

| job | rep | arm | status | quality | reason | elapsed s | Claude $ | Jev $ | Fable tokens | init model | Agent calls (owned/pinned) | attempted/patched/preserved | hint | mismatches |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| wide-validators | 1 | jev_forced_orchestration | completed | pass | - | 603.6 | 1.7112 | 0.000850 | 0 | claude-sonnet-5 | 13 (13/0) | 13/11/1 | 0 | 0 |
| wide-validators-loaded | 1 | jev_forced_orchestration | completed | pass | - | 457.8 | 1.3315 | 0.000378 | 0 | claude-sonnet-5 | 5 (5/0) | 5/4/0 | 0 | 0 |

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
wrote /Users/isaac/jev-gate-runs/v5-atomic/reports/report-1.md and /Users/isaac/jev-gate-runs/v5-atomic/reports/report-1.json
