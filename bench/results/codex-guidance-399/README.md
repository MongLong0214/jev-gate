# Codex App Server execution guidance (#399)

2026-10-29. Same six existing validation tasks, two repetitions each, paired before/after. Both arms have Router ON and Gate/Compact OFF. This is a source-runtime comparison in fresh native sessions; the global installation was preserved. These are development fixtures, not an independent held-out corpus.

| Metric | Before | After |
| --- | ---: | ---: |
| Total tokens including Jev | 1,320,034 | 1,383,754 |
| Provider requests | 54 | 56 |
| Jev tokens | 48,484 | 48,484 |
| Quality pass | 12/12 | 12/12 |
| Guidance added to requests | 0 | 56 |

Total raw-token reduction versus the pre-fix Router ON arm: **-4.83%**. All 24 planned cells are included. Complete usage: 24/24; quality pass: 24/24.

Raw tokens include cached inputs and Jev classification usage. Reasoning is already included in output. This does not establish subscription-quota savings, price savings, or a population-wide effect. Native server cache was not cleared; paired arm order alternates. Timing overlaps other verification and is not used for a speed claim.

| Task (two repetitions) | Before tokens | After tokens | Reduction |
| --- | ---: | ---: | ---: |
| atomic-ledger | 252,626 | 254,085 | -0.58% |
| bounded-map | 217,564 | 246,160 | -13.14% |
| csv-records | 190,914 | 217,164 | -13.75% |
| dependency-order | 220,051 | 247,021 | -12.26% |
| interval-subtract | 217,741 | 195,277 | 10.32% |
| lru-expiry | 221,138 | 224,047 | -1.32% |

## Accounting and limits

Failures and missing usage remain unknown, never zero. See [summary.json](summary.json) for all cells, cache/input/output splits, quality, failed tool calls and accounting issues. SessionEnd bridge-closure warnings are preserved separately from inference accounting.

The before arm uses official v0.8.68 with export-only instrumentation. The after arm bundles the same source plus the Codex-only patch. Both use the same native Codex executable, baseline model/effort, prompts, independent checkers, permissions and native hooks; no trust bypass was added. The export/build wrappers differ, and this is not an installed-release claim.

Raw materials and frozen plan: `~/.jev-gate/bench/2026-10-29-issue399/`. Sources and SHA-256 hashes are in the summary. The runner, source patch, per-request traces, native events, fixture snapshots and checker results are preserved there.

Validation: `npm run typecheck`, `npm test` (21,025 passed / 105 skipped), `npm run build`, `claude plugin validate . --strict` all passed. No release/publish.
