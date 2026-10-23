# Codex cache changes: held-out four-condition observation

2026-10-23, issues #362–#369. The new cases below were frozen before the first request. This is one observation per condition, not a savings guarantee. Raw Codex consumption and published credit estimates are different measures. **No Compact input transformation was applied in this run.**

## Protocol and coverage

- Native Codex CLI 0.163.0; ordinary OAuth authentication; baseline `gpt-6.1-sol` / `xhigh`; Gate off. OFF, Router, Compact and both use the same original fixtures, tools and native settings. Each cell starts an independent workspace and persistent thread. Shared backend cache warmth is unknown. No warm-up inference or quota polling.
- Twelve planned cells, three turns each. Condition order rotates: graph OFF/Router/Compact/both; ranges Router/Compact/both/OFF; context Compact/both/OFF/Router. No cell was replaced after seeing its outcome.
- Limits frozen before execution: 180 seconds per ordinary turn, 90 seconds per explicit compact, 80 normal requests and 100 commands per cell. The checker was unchanged. Failed commands, repair work, retries and native compaction belong to the same cell.
- 11/12 cells completed all three turns and passed all quality checks. The graph Compact cell timed out on turn 2, despite its intermediate code checks passing. Its third turn was not started; its one unanswered request has unknown consumption. It is retained below and excluded from equal-quality savings calculations.
- 163 ordinary submitted requests, 162 observed complete-usage responses, four additional native compaction requests/results. No duplicate/orphan ordinary response IDs or native compaction receipts were found. Descendant discovery covered archived and unarchived threads for the 11 complete cells, with none found. Discovery for the timed-out cell remains unverified.
- 83 Jev Router calls have observed usage; zero paid Compact selections and zero applied Compact input changes. Jev is reported separately in `summary.json`. Actual observed response models were Sol in OFF/Compact and Luna in Router/both; the four native compactions remained Sol.
- Child CLI plugins/hooks and memory extraction were disabled only for this finite diagnostic. Isolated lifecycle registration exercised the actual request pipeline. This does not establish installed automatic-plugin behavior.

The two representative coding tasks were new multi-turn implementations of graph ordering/critical paths and interval normalization/set operations, with validation, immutability, edge cases and final recovery of original task facts. The context case is **synthetic stress**: nine full evidence reads in three parallel batches, heterogeneous large outputs, validation and safe-key behavior, native compaction, then a new task requiring original facts and previous functions together. Re-reads and recovery consumption count. It is not pooled with representative coding without an explicit label.

## Every planned cell

Raw = uncached input + cached input + cache write + output. Cached input is not added twice; reasoning is already included in output. The JSON contains each category, actual model mix, commands, latency, Jev consumption and coverage.

| Case | Condition | Final quality | Whole observed raw | Requests, including native compact | Raw change vs OFF |
| --- | --- | --- | ---: | ---: | ---: |
| Graph | OFF | pass | 276,182 | 13 | — |
| Graph | Router | pass | 286,705 | 15 | +3.81% |
| Graph | Compact | timeout / incomplete | 111,631 subtotal; further consumption unknown | 8 submitted / 7 answered | unknown |
| Graph | Both | pass | 270,073 | 15 | −2.21% |
| Ranges | OFF | pass | 234,518 | 13 | — |
| Ranges | Router | pass | 189,805 | 11 | −19.07% |
| Ranges | Compact | pass | 236,606 | 13 | +0.89% |
| Ranges | Both | pass | 164,409 | 10 | −29.89% |
| Context stress | OFF | pass | 512,533 | 17 | — |
| Context stress | Router | pass | 545,785 | 17 | +6.49% |
| Context stress | Compact | pass | 538,013 | 18 | +4.97% |
| Context stress | Both | pass | 540,604 | 17 | +5.48% |

Representative coding totals: Router 510,700 → 476,510 (**6.69% lower**); both 510,700 → 434,482 (**14.92% lower**). Compact has no complete two-case total because graph timed out. Across all three planned cases, including synthetic stress, Router is **0.09% lower** and both **4.71% lower**. These are single-run workload totals, not estimates of a population mean. There is insufficient replication for confidence intervals or p95.

The largest observed raw increase in a completed comparison was **6.49%**, on the Router context stress case; graph Router used two more requests than OFF. A smaller model does not ensure fewer tokens. All Compact changes were held/ineligible: eight context preparations recorded `prefix_reprocessing_risk`, with a long retained suffix. This validates that the safeguard ran, but does not measure the counterfactual cost avoided. The different Compact/both totals therefore do not establish a causal Compact benefit or a combined interaction. No negative-result tuning or favorable rerun followed this experiment.

For reference only, applying the [published standard credit rates](https://learn.chatgpt.com/docs/pricing#token-rates) to complete observed usage gives representative coding estimates of 9.125720 OFF, 0.546861 Router and 0.512779 both. These estimates include each actual model, including native Sol compaction where applicable. They are **not raw tokens, actual included-plan allowance deductions or Jev usage**. Current rates were checked on 2026-10-23; the exact rates and per-cell estimates are in the JSON.

## Reproducibility and limits

Raw traces, native IDs, candidates, frozen fixture/checker and diagnostic script remain outside the repository at `/tmp/jev-cache-heldout-v2-20261023`. Only safe aggregates are committed.

- Base source: `2865af4f085719a635786bbc8b05693cfb32db95` plus the frozen candidate bundle.
- Manifest SHA-256: `17eee1622300167e1c33397adb98f29249498f787524a0d7bf065f60137c44e9`.
- Bundle SHA-256: `329fa37524f5a104e4a847b9d47bb96b65a8b628503dadce38666ee6ecfc4793`.
- Checker SHA-256: `458e2c2959479f4ee5173ec7b9b314f1a20dcebe09107d458695f55e620f8977`.
- The measured bundle predates final account-change and nonstandard-service-tier safeguards. No account/tier changes occurred in these cells; those later boundaries are covered by fake/native contract tests, not silently presented as measured here.

An earlier protocol (`8aff3ac0e2ca176e24ea0ece037ab33d9f0da59c4568eea1cba60b4819ae7231`) was stopped because native startup memory extraction contaminated the OFF cell and its requests were misattributed to root connection affinity. Its completed cell, interrupted cell, ten unexecuted cells and observed consumption are preserved separately; none are evidence of efficacy and missing consumption remains unknown. The correction disabled memory only in diagnostic children and repaired auxiliary request attribution. The replacement reused the same fixture, checker and condition order, frozen before all twelve replacement cells. See `invalidated_protocol` in the JSON.

The previous #300 development-corpus **20.90%**, #317 synthetic Compact **43.81%**, and paper **27.7%** remain separate historical results. This experiment neither adds those figures nor establishes 40%/50% savings.
