# Codex discovery/check batching: stopped comparison (#399 candidate B)

2026-10-29. Planned: six reused development tasks × two repetitions × before/after = 24 cells. Router ON, Gate/Compact OFF in both arms. The user stopped this run; it will not be resumed. **There is no full-plan savings result.**

- Finished: 20/24; complete usage and quality: 19/24.
- One after cell failed with provider overload and unknown consumed usage. Four remaining cells have no completed result. These five outcomes remain in the denominator. No missing usage is counted as zero.
- Nine complete quality-passing pairs: **1,053,035 → 948,341 total tokens (9.94% decrease)**, including provider cached input and Jev usage. This is a partial subtotal, with 4 decreases and 5 increases; it cannot establish the planned-suite effect.
- All observed model tokens in completed cells used `gpt-6.1-sol`. This candidate did not remove the model cost veto.

| Planned cell | Status | Usage complete | Quality | Total tokens |
| --- | --- | --- | --- | ---: |
| codex-interval-subtract-1-before | finished | True | True | 96,172 |
| codex-interval-subtract-1-after | finished | True | True | 98,487 |
| codex-atomic-ledger-1-after | finished | True | True | 103,174 |
| codex-atomic-ledger-1-before | finished | True | True | 148,170 |
| codex-dependency-order-1-before | finished | True | True | 122,486 |
| codex-dependency-order-1-after | finished | True | True | 99,345 |
| codex-csv-records-1-after | finished | True | True | 122,979 |
| codex-csv-records-1-before | finished | True | True | 120,962 |
| codex-bounded-map-1-before | finished | True | True | 121,442 |
| codex-bounded-map-1-after | finished | True | True | 75,451 |
| codex-lru-expiry-1-after | finished | True | True | 127,952 |
| codex-lru-expiry-1-before | finished | True | True | 126,126 |
| codex-interval-subtract-2-after | finished | True | True | 98,415 |
| codex-interval-subtract-2-before | finished | True | True | 95,933 |
| codex-atomic-ledger-2-before | finished | True | True | 125,953 |
| codex-atomic-ledger-2-after | finished | True | True | 100,969 |
| codex-dependency-order-2-after | finished | False | False | unknown |
| codex-dependency-order-2-before | finished | True | True | 122,765 |
| codex-csv-records-2-before | finished | True | True | 95,791 |
| codex-csv-records-2-after | finished | True | True | 121,569 |
| codex-bounded-map-2-after | missing_result | False | None | unknown |
| codex-bounded-map-2-before | missing_result | False | None | unknown |
| codex-lru-expiry-2-before | missing_result | False | None | unknown |
| codex-lru-expiry-2-after | missing_result | False | None | unknown |

## Accounting and scope

Both arms preserve the same native OAuth authentication, fixture prompts, frozen checkers, permission policy and Codex executable. Pair order alternates. Raw counts include cached input, cache writes, output (including reasoning), and Jev input/output. They do not measure subscription-quota savings. Fixtures are reused development data, not independent held-out work.

An explicit whole-contract `known_not_sent:true` / `attempted:false` receipt, Gate/Compact OFF, full native lifecycle and no failed trace write can establish zero Jev consumption; missing intent alone cannot. Both candidate reports were rescored with this correction; checker results were unchanged. Earlier report versions remain outside the repository.

Candidate A remains documented in [the complete earlier comparison](../codex-guidance-399/README.md), which consumed 4.83% more total tokens. Final model-veto removal is a separate change and measurement.

[summary.json](summary.json) retains every planned outcome, cache splits, tool failures, model/effort traces, accounting issues and source hashes. Raw materials: `~/.jev-gate/bench/2026-10-29-issue399-batch/`. No installation or release claim.
