# Codex Router contract regression diagnostic — 2026-10-23

Issue [#381](https://github.com/MongLong0214/jev-gate/issues/381), candidate v0.8.63.
This is a **known regression fixture and a quality repair diagnostic**, not a representative token-savings benchmark or a measurement of subscription allowance deductions.

The original v0.8.61 Router execution accepted an aggregated object where the contract required a records array. Its frozen checker passed turn 1 and failed turns 2–3. The original native transcript shows the correct contract read on turn 1 and the invented interface implemented on turn 2 without recovering the original source. The original smoke check did not cover this interface. Native compaction happened before turn 3, after the first failure. No submitted input/history loss was established. This identifies observed model contract drift and a weak execution instruction; it does not prove that instruction caused the failure or that Luna is generally unreliable.

The candidate changes only Codex's request-local routed execution guidance: establish original public signatures, input types, validation and invariants, recover missing/buried requirements using native tools, and verify the interface against the contract. Self-authored/smoke tests do not substitute for it. Native input, history, tools, permissions, route eligibility and model fallback are preserved. Claude routing is unchanged.

## Frozen comparison

- Codex CLI 0.163.0; actual OAuth account type `chatgpt`, baseline `gpt-6.1-sol` / `xhigh`.
- OFF / before / after × three repetitions × three turns: **9 planned cells, 27 planned turns**. Rotated order was fixed before results. No cell retries, replacements or checker changes.
- Original context fixture, prompts and checker retained. Turn 1 reads synthetic historical telemetry; turn 2 extends the original API; turn 3 recovers audit facts after one native compaction. Original `contract.md` and `smoke.cjs` stay unchanged in every cell.
- Separate persistent threads, workspaces and request-cache keys; shared backend warmth remains unknown.
- Gate and Jev Compact disabled. Child native plugins/hooks/memory disabled; the real adapter runs an isolated manual lifecycle. This is **not** proof of installed automatic hooks, which are verified separately.
- Source baseline `34c9a5b58e42b09dae9abaa422954eb309654867`. Its Codex pipeline is identical to the v0.8.61 bundle used in the original failing diagnostic. Full hashes, plan completeness, route outcomes, model mix and per-cell counters are in [summary.json](summary.json). Raw conversations, private IDs and credentials stay outside the repository.

## Every planned cell

Codex raw = uncached input + cached input + cache write + output. Reasoning is included within output, never added twice. Native compaction consumption is included. Jev tokens are a separate external service and are not converted to OpenAI tokens, currency or subscription usage.

| Order | Arm | Repetition | Turn checker results | Ordinary + native compact requests | Codex raw tokens | Known Jev tokens | Jev calls with unknown usage |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| 0 | off | 1 | pass/pass/pass | 16 + 1 | 491,833 | 0 | 0 |
| 1 | before | 1 | pass/pass/FAIL | 11 + 1 | 396,996 | 44,722 | 1 |
| 2 | after | 1 | pass/pass/pass | 19 + 1 | 645,686 | 79,583 | 0 |
| 3 | before | 2 | pass/pass/pass | 14 + 1 | 451,611 | 57,291 | 0 |
| 4 | after | 2 | pass/pass/pass | 21 + 1 | 685,899 | 75,457 | 3 |
| 5 | off | 2 | pass/pass/pass | 17 + 1 | 533,692 | 0 | 0 |
| 6 | after | 3 | pass/pass/pass | 18 + 1 | 589,240 | 74,781 | 0 |
| 7 | off | 3 | pass/pass/pass | 16 + 1 | 494,571 | 0 | 0 |
| 8 | before | 3 | pass/pass/pass | 18 + 1 | 553,500 | 74,707 | 0 |

## Result and limits

- Candidate: **3/3 cells, 9/9 turns passed**, with actual response model counts `{"gpt-6-luna": 54, "gpt-6.1-sol": 4}`. Actual route outcomes: `{"http_529": 1, "selected": 55, "timeout": 2}`. Native fallback is retained on Jev failure; the candidate is not forced to one model.
- OFF: all three cells passed. Before: see every result above, including any failure and its full consumption. The original exact array/object mismatch did not recur in the new before repetitions; the before failure concerned a missing audit artifact. This small comparison does **not** establish a causal effect size or a universal fix for model errors.
- Equal-quality candidate vs OFF aggregate Codex raw: **1,920,825 vs 1,520,096, +26.36%**. In this stress fixture, stronger contract verification **increased** raw consumption. No token-saving claim is made. A failed before/OFF pair has no equal-quality percentage; its observed consumption remains in the report.
- All ordinary request/response identities match; every Codex usage record is complete; native final totals agree with the ordinary-plus-native-compaction sum in all nine cells. Archived and unarchived descendants were checked. No usage gap is replaced with zero.
- Jev timeout/HTTP errors and unknown usage remain recorded. Known Jev totals are lower bounds where a call has unknown usage. They are not part of OpenAI's native total.
- Jev Compact performed no selection or transformation. No Compact effect, general reliability rate, included-plan saving, 40% saving or regression against a representative held-out workload is established.

Manifest canonical SHA-256: `fb757c02f492de8399821c91b876099b0dbf9cb63e2a385207974d340ba508c0`. Checker SHA-256: `458e2c2959479f4ee5173ec7b9b314f1a20dcebe09107d458695f55e620f8977`. All frozen fixture/checker/manifest/order integrity checks passed. The original failing diagnostic is retained in #381; it is not replaced by this repeated result.
