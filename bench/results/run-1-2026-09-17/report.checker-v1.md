# jev-gate bench report

run: /Users/isaac/jev-gate-runs/run-1
generated: 2026-09-17T08:46:33.074Z

| arm | planned | started | pass | fail | unknown | timed out | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | mean elapsed s | mean gate ms | fallback cells | match/mismatch | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| frontier_raw | 4 | 4 | 3 | 1 | 0 | 0 | 657473 | 661814 | 2.3940 | 0.000000 | 2.3940 | 0.7980 | 50.9 | null | 0 | 0/0 | true |
| frontier_enriched | 4 | 4 | 3 | 1 | 0 | 0 | 770218 | 774552 | 2.4949 | 0.000228 | 2.4951 | 0.8317 | 51.9 | 642 | 0 | 0/0 | true |
| sonnet_native | 4 | 4 | 3 | 1 | 0 | 0 | 0 | 856554 | 0.5781 | 0.000000 | 0.5781 | 0.1927 | 22.2 | null | 0 | 0/0 | true |
| sonnet_gated | 4 | 4 | 4 | 0 | 0 | 0 | 259205 | 1037917 | 1.4239 | 0.000290 | 1.4242 | 0.3560 | 41.5 | 667 | 0 | 4/0 | true |

complete case set (4): quote-pricing, search-race, status-count, ttl-cache

| comparison | Fable volume change | total est. cost change | elapsed change |
|---|---|---|---|
| sonnet_gated vs frontier_raw | 60.6% | 40.5% | 18.5% |
| sonnet_gated vs sonnet_native | null | -146.4% | -86.8% |

## per-model tokens

- frontier_raw: claude-haiku-4-5-20251001 in=4242 out=99 cacheRead=0 cacheCreate=0; claude-fable-5-1 in=552 out=9599 cacheRead=559119 cacheCreate=88203
- frontier_enriched: claude-haiku-4-5-20251001 in=4242 out=92 cacheRead=0 cacheCreate=0; claude-fable-5-1 in=648 out=10169 cacheRead=669001 cacheCreate=90400
- sonnet_native: claude-haiku-4-5-20251001 in=4242 out=88 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=42 out=6190 cacheRead=755933 cacheCreate=90059
- sonnet_gated: claude-haiku-4-5-20251001 in=4242 out=97 cacheRead=0 cacheCreate=0; claude-sonnet-5 in=38 out=4704 cacheRead=676770 cacheCreate=92861; claude-fable-5-1 in=290 out=4766 cacheRead=225770 cacheCreate=28379

## cells

| case | arm | quality | elapsed s | exit | Fable tokens | total est $ | Jev est $ | recommended | actual agents | match | fallback | init model | plugins |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| quote-pricing | frontier_raw | pass | 28.5 | 0 | 120160 | 0.5010 | 0.000000 | - | - | n/a | 0 | claude-fable-5-1 | - |
| quote-pricing | frontier_enriched | pass | 26.6 | 0 | 90815 | 0.4981 | 0.000056 | main | - | n/a | 0 | claude-fable-5-1 | jev-gate |
| quote-pricing | sonnet_native | pass | 25.6 | 0 | 0 | 0.1547 | 0.000000 | - | - | n/a | 0 | claude-sonnet-5 | - |
| quote-pricing | sonnet_gated | pass | 15.6 | 0 | 0 | 0.1464 | 0.000072 | main | - | match | 0 | claude-sonnet-5 | jev-gate |
| search-race | frontier_raw | pass | 79.0 | 0 | 230048 | 0.7669 | 0.000000 | - | - | n/a | 0 | claude-fable-5-1 | - |
| search-race | frontier_enriched | pass | 83.0 | 0 | 333233 | 0.7977 | 0.000057 | main | - | n/a | 0 | claude-fable-5-1 | jev-gate |
| search-race | sonnet_native | fail | 26.8 | 0 | 0 | 0.1683 | 0.000000 | - | - | n/a | 0 | claude-sonnet-5 | - |
| search-race | sonnet_gated | pass | 121.5 | 0 | 259205 | 1.0066 | 0.000073 | delegate→jev-gate:frontier | jev-gate:frontier | match | 0 | claude-sonnet-5 | jev-gate |
| status-count | frontier_raw | pass | 42.7 | 0 | 152711 | 0.5402 | 0.000000 | - | - | n/a | 0 | claude-fable-5-1 | - |
| status-count | frontier_enriched | pass | 36.3 | 0 | 155346 | 0.5464 | 0.000058 | main | - | n/a | 0 | claude-fable-5-1 | jev-gate |
| status-count | sonnet_native | pass | 14.5 | 0 | 0 | 0.1252 | 0.000000 | - | - | n/a | 0 | claude-sonnet-5 | - |
| status-count | sonnet_gated | pass | 15.0 | 0 | 0 | 0.1470 | 0.000074 | main | - | match | 0 | claude-sonnet-5 | jev-gate |
| ttl-cache | frontier_raw | fail | 53.5 | 0 | 154554 | 0.5859 | 0.000000 | - | - | n/a | 0 | claude-fable-5-1 | - |
| ttl-cache | frontier_enriched | fail | 61.5 | 0 | 190824 | 0.6529 | 0.000057 | main | - | n/a | 0 | claude-fable-5-1 | jev-gate |
| ttl-cache | sonnet_native | pass | 22.0 | 0 | 0 | 0.1299 | 0.000000 | - | - | n/a | 0 | claude-sonnet-5 | - |
| ttl-cache | sonnet_gated | pass | 14.0 | 0 | 0 | 0.1241 | 0.000072 | main | - | match | 0 | claude-sonnet-5 | jev-gate |

## notes

- Claude total_cost_usd is an API-equivalent estimate, not subscription billing or quota; Jev cost is list price × input tokens, null when unknown.
- Deltas use only the complete case set (all four arms started, finished without timeout, with whole-tree modelUsage and known Jev cost). Per-case savings are not averaged.
- A Fable-free arm that fails its behavior check is not a saving; pass/fail/unknown are reported next to every cost figure.
- Recommendation/actual match is observed from the hook trace and the Agent tool calls in the stream; mismatches and fallbacks are product results and stay in every total.
