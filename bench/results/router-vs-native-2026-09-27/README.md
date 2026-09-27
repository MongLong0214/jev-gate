# Router vs native vs fixed `medium`, 2026-09-27 — results

**The Router did not make these tasks more than 15 % cheaper for the owner's configuration, and choosing an effort
per step showed no value over running at `medium` without Jev that this bench can resolve. The recommendation under
rule 9 is the fixed setting, which costs no Jev request and no plugin: no `router_fixed` cell failed its checker on a
case where every `router_native` cell passed.**

Preregistered in [`PREREGISTRATION.md`](PREREGISTRATION.md) before any cell ran. **Development data:** five small,
familiar fixtures, two repetitions each; a paired, per-task difference on these tasks, not a claim about the owner's
own work. **This run changes no default** (rule 10): the Router is not enabled on the owner's host, and the host's
effort is not changed by it.

## Build, spend, approval

| | |
|---|---|
| commit (rule 11) | `0ae92797f99055f420eab8d196338bd8ad24c696` |
| `frozen_inputs.router_sha256` | `08873861bdc97e013988037a5991e1afb44a777c0fe9deb0dbb4e71e88ce3b27` (12 files) |
| `config_sha256` / `bench_sha256` | `0de543f8…b4b7be` / `fc5fd510…a9eae` |
| host | Claude Code 2.1.283, `--frontier-model opus`, seed `20260927`, auto-compact on |
| cells | 30 planned, 30 completed, 0 timed out, 0 cancelled |
| spend | **$9.81** known, of the $30 stop (rule 7 never fired; no cell's cost was unknown) |
| approval | the owner, directly in the session: "너가 자율판단해서 진행해 / 목표는 jev활용을 통한 토큰 사용 절감이야", read as delegating this run as written; one run, no second attempt |

Raw data (stream JSON, Router debug logs, each cell's repository, `report-1.md/json`) is in
`~/jev-gate-runs/router-vs-native-2026-09-27/`. [`cells.tsv`](cells.tsv) is one line per cell, extracted from it.

## Rules as applied

| rule | outcome |
|---|---|
| 1 validity | 30/30 valid |
| 2 quality gates cost | `ttl-cache` is excluded from both registered pairs: `router_native` failed both cells, `router` failed rep 2, `router_fixed` failed rep 1 |
| 3 unknown is not zero | every cell's complete cost is known; Router Jev attempts 10, known responses 10, unparsable lines 0 |
| 4 three cases | both pairs adjudicated on 4 cases |
| 5 15 % line | cost medians of both pairs fall under it: "no difference this bench can resolve" |
| 9 negative result | first line above; the recommendation condition holds (`router_fixed` failed only on `ttl-cache`, where `router_native` failed too) |
| 10 no default | nothing enabled or changed on the host |
| 11 frozen build | as recorded above |

Each case's figure is the mean of its two repetitions; saving is `(other − router) / other`, so a negative saving means
the Router cost more.

### `router` against `router_native` (does the Router save on the owner's configuration?)

| case | cost router / native | saving | wall s | saving | tokens | saving |
|---|---|---|---|---|---|---|
| search-race | 0.327 / 0.358 | +8.6 % | 42 / 53 | +19.7 % | 250,016 / 333,644 | +25.1 % |
| quote-pricing | 0.240 / 0.256 | +6.3 % | 23 / 23 | +3.7 % | 188,418 / 188,962 | +0.3 % |
| status-count | 0.306 / 0.303 | −0.8 % | 42 / 42 | −0.7 % | 165,166 / 195,949 | +15.7 % |
| wide-validators | 0.591 / 0.538 | −10.0 % | 86 / 80 | −8.5 % | 408,716 / 356,930 | −14.5 % |
| ttl-cache | excluded (rule 2) | | | | | |
| **median** | | **+2.7 %** | | **+1.5 %** | | **+8.0 %** |

All three medians are under 15 %: no difference this bench can resolve.

### `router` against `router_fixed` (does choosing per step beat a fixed lower effort?)

| case | cost router / fixed | saving | wall s | saving | tokens | saving |
|---|---|---|---|---|---|---|
| search-race | 0.327 / 0.309 | −5.8 % | 42 / 35 | −20.4 % | 250,016 / 245,704 | −1.8 % |
| quote-pricing | 0.240 / 0.234 | −2.5 % | 23 / 18 | −28.3 % | 188,418 / 171,978 | −9.6 % |
| status-count | 0.306 / 0.264 | −15.7 % | 42 / 30 | −38.8 % | 165,166 / 206,492 | +20.0 % |
| wide-validators | 0.591 / 0.296 | −99.7 % | 86 / 33 | −164.9 % | 408,716 / 229,159 | −78.4 % |
| ttl-cache | excluded (rule 2) | | | | | |
| **median** | | **−10.8 %** | | **−33.5 %** | | **−5.7 %** |

The cost median is under 15 % and is not quoted as a difference. The wall-time median is over it: the `router` cells
took longer than the `router_fixed` cells, by a median of 33.5 % of the fixed arm's time.

## Falsification

| claim | result |
|---|---|
| the Router saves on the owner's configuration | **not supported** (median cost saving +2.7 %) |
| per-step selection adds value over a fixed lower effort | **not supported** (median cost saving −10.8 %) |
| the Router is faster | **not supported** (median wall-time saving +1.5 %) |
| the Router is quality-neutral | **not falsified**: its one failure is on `ttl-cache`, where both `router_native` cells failed too |

## What the Router decided (recorded for every cell, rule "What is measured")

One Jev assessment per session, at the root's first step. The effort answer is `[low, medium, xhigh]`, `xhigh`
being the baseline; a move down needs the mass at or below the target to reach `minDowngradeConfidence` 0.9, and the
`task_clear` control to reach the same floor.

| case | effort answer (both reps) | task_clear | patch | reason | steps run at `medium` |
|---|---|---|---|---|---|
| search-race | `[0, .71, .29]`, `[0, .69, .31]` | .96, .97 | none | `low_confidence` | 0 |
| quote-pricing | `[.06, .92, .02]`, `[.07, .92, .01]` | .91, .94 | `medium` | `applied` | 6, 6 |
| status-count | `[.03, .96, .01]`, `[.04, .95, .01]` | .85, .87 | none | `control_low_confidence` | 0 |
| ttl-cache | `[.01, .80, .19]`, `[0, .83, .17]` | .96, .95 | none | `low_confidence` | 0 |
| wide-validators | `[.01, .95, .04]`, `[.01, .94, .05]` | .98, .97 | `medium` | `applied` | 11, 10 |

`medium` was the top label in all ten cells. In six, a floor held the move and the session **fell back to the
baseline `xhigh`**, which is the expensive route, so on those cases the `router` arm is the native arm plus one Jev
request. No spawn was assessed in any cell (`spawn_assessed` 0): these tasks never delegated, so the Router's
subagent-model routing is untested here.

## Observations this run did not register

These are not results. They are recorded because they bear on the next preregistration, and each would need its
own before any decision rests on it.

1. **`router_fixed` against `router_native`** (not a registered pair) on the same 4 cases: median cost saving
   +13.2 % (under the 15 % line), wall time +30.3 %, tokens +17.7 %, output tokens +37.5 %.
2. **A patched `medium` did not behave like a launched `medium` on `wide-validators`.** The Router ran every root step
   of both cells at `medium` (11/11 and 10/10 observed), yet the sessions made 44 and 43 tool calls and wrote
   10,437 and 10,481 output tokens, like `router_native` (42 and 21 calls, 9,534 and 9,897 tokens) and unlike
   `router_fixed`, launched with `--effort medium` (5 and 9 calls, 2,089 and 2,800 tokens). Two cells per arm on one
   case; why is not established. One reading to test: the launch effort shapes the session beyond the per-request
   effort field the Router patches. If that holds, a per-step effort patch cannot reach the saving a launch-time
   effort gets, whatever the selector decides.
3. No counterfactual floor is computed (rule 8). Because `medium` topped every answer, a lower floor could only
   have moved the `router` arm toward what `router_fixed` already measured.

## Reading this against "the extra call has to earn its place"

The owner asked that this work follow
[How to Build Agentic Harness using Jev](https://x.com/av1dlive/status/2102802621664985241) (keel 0.2.0). Its test
for a decision layer is the total task cost (selector, worker, retries, review), not the decision alone. Here the
decision was cheap ($0.00004 a session) and still did not earn its place: the saving it chose (`medium`) is
available with no decision at all, and when its floor abstained it fell back to the costliest option. The same
guide asks that fallbacks be recorded apart from selector wins, and that each hop be traced rather than assumed.
The table above does the first. Observation 2 is the second: the receipt said `medium` and the host confirmed it,
but the work did not change.
