# Codex OAuth model-route regression (#399 final candidate)

2026-10-29. **One predeclared before/after pair, 2/2 completed with complete usage and quality pass.** Released v0.8.68 Router ON versus source commit `74c03f4` (cost veto removal plus the earlier guidance repair). Gate/Compact OFF. Both use the existing native OAuth login; no inference API key or account changes.

| Metric | Before | After |
| --- | ---: | ---: |
| Submitted and observed provider model | gpt-6.1-sol | gpt-6.1-terra |
| Submitted effort | high | high |
| Total tokens, provider + Jev | 128,174 | 98,621 |
| Provider tokens | 124,115 | 94,562 |
| Jev tokens | 4,059 | 4,059 |
| Provider requests | 5 | 4 |
| Uncached input | 24,102 | 51,854 |
| Cached input | 96,384 | 40,704 |
| Cache writes | 0 | 0 |
| Output, including reasoning | 3,629 | 2,004 |
| Tool calls / failures / unfinished | 7 / 0 / 0 | 3 / 1 / 0 |
| Independent checker and npm test | pass | pass |

Observed total raw-token decrease: **23.06% (29,553 tokens)**. Cached input and Jev usage are included. Reasoning is already included in output and is not added again. This is one task-level observation, not a general reduction guarantee or subscription-quota measurement.

## Mechanism

Before: Jev returned a valid route but `cost_unknown_hold` retained Sol. After: the eligible Terra/high route reached every provider request; speculative prices and cache scenarios are diagnostic only. Four after requests carried the repaired execution guidance, versus zero before. The same plan, prompt, fixture, checker, permissions, native hooks and Codex executable were used. The measurement covers the combined repair; it does not isolate each contribution.

The fixture (`atomic-ledger`) was selected before outcomes because a prior trace had chosen Terra and then held Sol. This reused development fixture is not held-out data. The plan fixed one pair with no retries or expansion; both outcomes are reported. Arm order was before then after, server cache was not cleared, and cache effects are not controlled away. One recovered tool failure remains included in the after result. No provider attempt or usage was excluded. Both runs retained a post-turn SessionEnd bridge-closure warning, separated from successful inference accounting.

The runtime comparison uses export-only released-source instrumentation before and a fresh source bundle after. It is not an installed-release observation. Existing sessions and global plugin installation were preserved. No release/publish.

[summary.json](summary.json) includes the route receipts, complete usage breakdown, every planned cell, source hashes and quality outcomes. Raw materials and the frozen plan: `~/.jev-gate/bench/2026-10-29-issue399-model-route/`. Earlier unsuccessful/incomplete candidates remain in [candidate A](../codex-guidance-399/README.md) and [stopped candidate B](../codex-guidance-399-batch/README.md).
