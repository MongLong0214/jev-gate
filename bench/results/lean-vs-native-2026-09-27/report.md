# jev-gate bench report (schema 5)

run: /Users/isaac/jev-gate-runs/lean-vs-native-2026-09-27-r2
generated: 2026-10-12T05:23:40.680Z
plan schema: 5 · planned rows: 18 · independent units: 3 jobs / 3 groups

**conclusion: no dispatch exposure** — lean selected 24 time(s) over 24 answered request(s) and proposed no packet (no_effect:20 work_shape_unusable:4); the arm ran as native and no handoff was measured

## arms (planned cohort)

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_lean | 6 | 6 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 3318176 | 1.6830 | 0.007644 | 1.6907 | 0.2818 | 475.6 | 79.3 (6) | true |
| recent_packet | 6 | 6 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 3532059 | 1.6961 | 0.000000 | 1.6961 | 0.2827 | 455.3 | 75.9 (6) | true |
| native_auto | 6 | 6 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 3078031 | 1.5952 | 0.000000 | 1.5952 | 0.2659 | 399.0 | 66.5 (6) | true |

## job ep-inventory

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_lean | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1133606 | 0.5695 | 0.002711 | 0.5722 | 0.2861 | 183.4 | 91.7 (2) | true |
| recent_packet | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1083729 | 0.5378 | 0.000000 | 0.5378 | 0.2689 | 163.2 | 81.6 (2) | true |
| native_auto | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 992348 | 0.5287 | 0.000000 | 0.5287 | 0.2643 | 133.6 | 66.8 (2) | true |

### V5 gates — ep-inventory

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_lean | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| recent_packet | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| native_auto | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## job ep-durations

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| native_auto | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 918758 | 0.4723 | 0.000000 | 0.4723 | 0.2362 | 108.5 | 54.2 (2) | true |
| jev_lean | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 985506 | 0.5061 | 0.002371 | 0.5085 | 0.2542 | 127.7 | 63.9 (2) | true |
| recent_packet | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1043966 | 0.5267 | 0.000000 | 0.5267 | 0.2633 | 129.5 | 64.7 (2) | true |

### V5 gates — ep-durations

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| native_auto | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| jev_lean | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| recent_packet | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## job ep-slugs

| arm | planned | completed | timed out | cancelled | not started | missing | pass | fail | unknown | Fable tokens | all tokens | Claude est $ | Jev est $ | total est $ | $/pass | runtime total s | pass latency mean s (n) | usage complete |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| recent_packet | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1404364 | 0.6316 | 0.000000 | 0.6316 | 0.3158 | 162.6 | 81.3 (2) | true |
| native_auto | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1166925 | 0.5943 | 0.000000 | 0.5943 | 0.2971 | 156.9 | 78.5 (2) | true |
| jev_lean | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 1199064 | 0.6074 | 0.002563 | 0.6100 | 0.3050 | 164.5 | 82.3 (2) | true |

### V5 gates — ep-slugs

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| recent_packet | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| native_auto | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| jev_lean | 2 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## gate activity per arm

| arm | Agent calls | owned | pinned | eligible attempted | patched | preserved (reasons) | skipped (codes) | attempt unknown | missing pre records | hint delivered | target/actual mismatches | validity problems |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_lean | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |
| recent_packet | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |
| native_auto | 0 | 0 | 0 | 0 | 0 | 0 (-) | - | 0 | 0 | 0 | 0 | - |

## V5 gates per arm (observed)

| arm | rows with records | admission | guard denials (continue false) | planner req/done | planner tier proposed | planner model | plan status | worker tiers | receipts | advisory | parallel res/obs | outcomes | orphan records | decision mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_lean | 6 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| recent_packet | 6 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |
| native_auto | 6 | - | 0 (0) | 0/0 | - | - | - | - | accept:0 incomplete:0 invalid:0 unknown:0 rework:0 replan:0 | accept:0 rework:0 replan:0 abstain:0 none:0 | 0/0 | - | 0 | 0 |

## lean selection and dispatch (observed)

| arm | selections | policy | Jev attempts (HTTP) | Jev input tokens: complete (known subtotal / responses, possibly sent) | Jev cost: complete (known) | action | reasons | packets proposed | dispatched | not taken | denied | groups retained/omitted/unassessed | mandatory B | optional B | packet B | composed B | coverage | observed model | terminal |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| jev_lean | 24 | jev:24 | 24 (http_200:24) | 182011 (182011 / 24, 0) | 0.007644 (0.007644) | direct:24 | no_effect:20 work_shape_unusable:4 | 0 | 0 | 0 | - | 0/0/0 | 2115 | 22225 | null | null | complete:24 | - | - |
| recent_packet | 24 | recent_packet:24 | 0 (-) | 0 (0 / 0, 0) | 0.000000 (0.000000) | handoff:24 | - | 24 | 0 | 18 | - | 0/0/0 | 3085 | 20053 | 23102 | null | complete:24 | - | - |
| native_auto | 0 | - | 0 (-) | 0 (0 / 0, 0) | 0.000000 (0.000000) | - | - | 0 | 0 | 0 | - | 0/0/0 | null | null | null | null | - | - | - |

- A proposed packet is what the root was offered; a dispatched one is what it actually used; "not taken" is the gap it chose. They are not the same number and are never collapsed.
- Byte columns are the largest observed in the arm, not an average, and a packet byte difference is a diagnostic — never a token count or a saving.
- An attempt whose usage never came back is unknown, not zero: the known-rows count beside the token total says how many contributed.
- Unassessed groups are source Jev never judged: groups past the enumeration window, groups withheld as credentials, tool results that could not be attributed to a call, and groups the provider’s token bound kept out of the request. None of them was judged irrelevant.

## Jev requests per arm (attempts / input tokens / est $ at the dated price)

| arm | admission | allocation | result | plan (scope or interpretation) | influence (changed/judged) |
|---|---|---|---|---|---|
| jev_lean | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/0 |
| recent_packet | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/0 |
| native_auto | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0 / 0 / 0.000000 | 0/0 |

## worker tier distribution (observed models and root effort)


## comparisons (planned cohort; intended common rows)

| treatment vs control | criterion | verdict | reason | rows | pass T/C | Δ success | cost reduction | runtime reduction | validity | complete-case diagnostic |
|---|---|---|---|---|---|---|---|---|---|---|
| jev_lean vs native_auto | none | not_comparable | descriptive row: no declared criterion | 6 | 6/6 | 0.0 pts | -6.0% | -19.2% | ok | 6/6 rows: cost -6.0%, runtime -19.2%, pass 6/6 |
| jev_lean vs recent_packet | none | not_comparable | descriptive row: no declared criterion | 6 | 6/6 | 0.0 pts | 0.3% | -4.5% | ok | 6/6 rows: cost 0.3%, runtime -4.5%, pass 6/6 |
| recent_packet vs native_auto | none | not_comparable | descriptive row: no declared criterion | 6 | 6/6 | 0.0 pts | -6.3% | -14.1% | ok | 6/6 rows: cost -6.3%, runtime -14.1%, pass 6/6 |

## episodes: jev_lean vs native_auto (pre-registered rules)

**jev_lean did not cost more than 15% less than native_auto on these episodes** — 3 of 3 episodes valid under rules 1-3; 2 needed. Median cost saving below 15%, not quoted; tokens below 15%; time -17.7%; follow-up cost increase below 15%.

| episode | valid | excluded | T $ (median) | C $ (median) | saving | paired Δ$ by rep | T follow-up $ | C follow-up $ | T tokens | C tokens | T s | C s | T quality loss |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ep-inventory | true | - | 0.2861 | 0.2643 | -8.2% | 0.0161, 0.0275 | 0.0300 | 0.0290 | in 32 / create 33300 / read 544265 / out 9823 | in 28 / create 32621 / read 459093 / out 9477 | 92 | 67 | false |
| ep-durations | true | - | 0.2542 | 0.2362 | -7.7% | 0.0302, 0.0059 | 0.0270 | 0.0257 | in 28 / create 30939 / read 455610 / out 8838 | in 28 / create 29647 / read 442340 / out 8072 | 64 | 54 | false |
| ep-slugs | true | - | 0.3050 | 0.2971 | -2.6% | 0.0012, 0.0145 | 0.0338 | 0.0369 | in 34 / create 33626 / read 564225 / out 11043 | in 34 / create 32826 / read 557533 / out 10560 | 82 | 78 | false |

## episodes: jev_lean vs recent_packet (pre-registered rules)

**jev_lean did not cost more than 15% less than recent_packet on these episodes** — 3 of 3 episodes valid under rules 1-3; 2 needed. Median cost saving below 15%, not quoted; tokens 15.2%; time below 15%; follow-up cost increase below 15%.

| episode | valid | excluded | T $ (median) | C $ (median) | saving | paired Δ$ by rep | T follow-up $ | C follow-up $ | T tokens | C tokens | T s | C s | T quality loss |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ep-inventory | true | - | 0.2861 | 0.2689 | -6.4% | 0.0212, 0.0132 | 0.0300 | 0.0276 | in 32 / create 33300 / read 544265 / out 9823 | in 30 / create 32948 / read 501393 / out 8972 | 92 | 82 | false |
| ep-durations | true | - | 0.2542 | 0.2633 | 3.5% | 0.0161, -0.0343 | 0.0270 | 0.0277 | in 28 / create 30939 / read 455610 / out 8838 | in 32 / create 33181 / read 541621 / out 9688 | 64 | 65 | false |
| ep-slugs | true | - | 0.3050 | 0.3158 | 3.4% | -0.0219, 0.0002 | 0.0338 | 0.0502 | in 34 / create 33626 / read 564225 / out 11043 | in 42 / create 34755 / read 735013 / out 11199 | 82 | 81 | false |

## episodes: recent_packet vs native_auto (pre-registered rules)

**recent_packet did not cost more than 15% less than native_auto on these episodes** — 3 of 3 episodes valid under rules 1-3; 2 needed. Median cost saving below 15%, not quoted; tokens -21.8%; time -19.4%; follow-up cost increase below 15%.

| episode | valid | excluded | T $ (median) | C $ (median) | saving | paired Δ$ by rep | T follow-up $ | C follow-up $ | T tokens | C tokens | T s | C s | T quality loss |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ep-inventory | true | - | 0.2689 | 0.2643 | -1.7% | -0.0051, 0.0143 | 0.0276 | 0.0290 | in 30 / create 32948 / read 501393 / out 8972 | in 28 / create 32621 / read 459093 / out 9477 | 82 | 67 | false |
| ep-durations | true | - | 0.2633 | 0.2362 | -11.5% | 0.0141, 0.0402 | 0.0277 | 0.0257 | in 32 / create 33181 / read 541621 / out 9688 | in 28 / create 29647 / read 442340 / out 8072 | 65 | 54 | false |
| ep-slugs | true | - | 0.3158 | 0.2971 | -6.3% | 0.0231, 0.0143 | 0.0502 | 0.0369 | in 42 / create 34755 / read 735013 / out 11199 | in 34 / create 32826 / read 557533 / out 10560 | 81 | 78 | false |

## cost by model family (API-equivalent) and Jev cost

- jev_lean: sonnet 1.6830 · Jev 0.007644 · total 1.6907
- recent_packet: sonnet 1.6961 · Jev 0.000000 · total 1.6961
- native_auto: sonnet 1.5952 · Jev 0.000000 · total 1.5952

## per-model tokens

- jev_lean: claude-sonnet-5-5 in=184 out=58780 cacheRead=3062051 cacheCreate=197161
- recent_packet: claude-sonnet-5-5 in=194 out=57481 cacheRead=3276058 cacheCreate=198326
- native_auto: claude-sonnet-5-5 in=176 out=56038 cacheRead=2834040 cacheCreate=187777

## rows

| job | rep | arm | status | quality (follow-up) | reason | elapsed s | Claude $ | Jev $ | Fable tokens | init model | Agent calls (owned/pinned) | attempted/patched/preserved | hint | mismatches |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ep-inventory | 1 | jev_lean | completed | pass (pass) | - | 112.5 | 0.2859 | 0.001374 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-inventory | 1 | recent_packet | completed | pass (pass) | - | 98.9 | 0.2661 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-inventory | 1 | native_auto | completed | pass (pass) | - | 75.3 | 0.2712 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-inventory | 2 | recent_packet | completed | pass (pass) | - | 64.3 | 0.2717 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-inventory | 2 | native_auto | completed | pass (pass) | - | 58.3 | 0.2574 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-inventory | 2 | jev_lean | completed | pass (pass) | - | 70.9 | 0.2836 | 0.001337 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-durations | 1 | native_auto | completed | pass (pass) | - | 51.9 | 0.2287 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-durations | 1 | jev_lean | completed | pass (pass) | - | 64.7 | 0.2578 | 0.001209 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-durations | 1 | recent_packet | completed | pass (pass) | - | 53.5 | 0.2428 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-durations | 2 | jev_lean | completed | pass (pass) | - | 63.1 | 0.2483 | 0.001161 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-durations | 2 | recent_packet | completed | pass (pass) | - | 76.0 | 0.2838 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-durations | 2 | native_auto | completed | pass (pass) | - | 56.6 | 0.2436 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-slugs | 1 | recent_packet | completed | pass (pass) | - | 84.1 | 0.3246 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-slugs | 1 | native_auto | completed | pass (pass) | - | 81.2 | 0.3015 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-slugs | 1 | jev_lean | completed | pass (pass) | - | 81.2 | 0.3014 | 0.001291 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-slugs | 2 | recent_packet | completed | pass (pass) | - | 78.5 | 0.3070 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-slugs | 2 | jev_lean | completed | pass (pass) | - | 83.3 | 0.3060 | 0.001272 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |
| ep-slugs | 2 | native_auto | completed | pass (pass) | - | 75.8 | 0.2927 | 0.000000 | 0 | claude-sonnet-5-5 | 0 (0/0) | 0/0/0 | 0 | 0 |

## notes

- Rows come from plan.json. missing_record means the planned cell has no saved file; it is not "not started" and never cost zero.
- Claude total_cost_usd is an API-equivalent estimate (whole tree incl. children), not subscription billing or quota; Jev cost is list price × input tokens, null when any attempt has unknown usage.
- Accounting 2 (L6): Jev cost adds every producer a row used -- the legacy gate, lean, and (#45) Router, whose records are disjoint -- joining intents to results per request. An intent without a result leaves the total unknown; a lean block from an older ingestion keeps only its known subtotal.
- #45: the Router producer prices only its own Jev assessment calls (root/spawn/late `usage`), never the routed Claude call’s own usage (root_result/spawn_result), which stays a per-step observational record and is already priced as ordinary Claude spend elsewhere. Router arms carry no declared comparison criterion and no savings headline; zero Jev attempts on a host `hostSupported` accepts (any `2.1.N`, N>=282, per PR #49) is not the expected reading and needs its own explanation (e.g. no TypeSafe key, or the plugin disabled) -- only an unsupported host makes it a structural no-op.
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
wrote /Users/isaac/jev-gate-runs/lean-vs-native-2026-09-27-r2/reports/report-1.md and /Users/isaac/jev-gate-runs/lean-vs-native-2026-09-27-r2/reports/report-1.json
