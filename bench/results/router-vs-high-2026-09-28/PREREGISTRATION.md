# Pre-registration — Router vs native `xhigh` vs fixed `high`, three repetitions (2026-09-28)

Issue #38 (JGR-PRD), "Evidence and cost". Written **before any cell of this run exists**, on the build `c97ee5a`
(`dev` after #60). Nothing here may be edited once a cell has run; a change means a new pre-registration and a new run.

**Authorised.** The owner, directly in the session on 2026-09-28, chose "Router만 유료 측정" from the option
"턴마다 모델·effort를 낮춰 출력 토큰을 줄일 수 있는 유일한 경로인 Router를 측정합니다. 약 $30 한도가 필요하고,
품질까지 비교합니다." That approves one Router measurement under $30 with quality compared. The arms below are the
implementer's design under that approval; the owner did not pick `high` or the repetition count.

## Why a second run

`router-vs-native-2026-09-27` (30 cells, $9.81, same five cases, two repetitions) found the Router not more than
15 % cheaper than native `xhigh`, and per-step choice no better than a fixed `medium`. That result stands; this run
does not re-litigate it. It asks what the first could not:

1. **Is the first null stable?** Two repetitions could not separate a 15 % line from the 10–25 % spread between cells
   of one arm (search-race `router` cells were $0.29 and $0.37). Three repetitions narrow that, on the same cases.
2. **Does the mildest fixed step down pay?** The owner runs every session at `xhigh`. Output is about 16 % of the
   owner's cost-weighted tokens (2026-09-20..27 main sessions, 23,478 calls), and effort is the one setting that
   moves it. `medium` is a large quality step for the owner's real work; `high` is the smallest one. Whether `high`
   keeps quality and still saves is the question that decides the owner's `effortLevel`, which is the owner's call
   (rule 10), not this run's.

## The question

> On the same task, does a session with the `jev-gate-router` plugin cost less per completed task, including the
> Router's own Jev requests, than the owner's plain configuration, and less than a fixed `high` chosen up front with
> no Jev at all? And does that fixed `high` itself cost less than `xhigh` without failing a check `xhigh` passes?

- `router` against `router_native`: does the whole Router policy save anything on the owner's configuration?
- `router` against `router_fixed`: does *choosing* an effort per step add anything over running at `high`?
- `router_fixed` against `router_native`: does a fixed `high` save anything, and at what quality?

## Arms

| arm | model | plugin | effort |
|---|---|---|---|
| `router_native` | `--frontier-model opus` | none | `--base-effort xhigh` |
| `router` | `--frontier-model opus` | `jev-gate-router` (Function Hooks), frozen copy of `mods/router` | starts at `xhigh`; the Router may lower it per step |
| `router_fixed` | `--frontier-model opus` | none | `--fixed-effort high` |

**Why `high`, and when it was chosen.** It is the mildest effort below the owner's `xhigh`, chosen before any cell of
this run from the reasoning above, and not tuned afterwards. The 2026-09-27 run already measured `medium`, so this run
measures `high` instead of repeating it.

## Cells

| cases (`bench/cases.json`) | arms | repetitions | cells |
|---|---|---|---|
| `search-race`, `quote-pricing`, `status-count`, `ttl-cache`, `wide-validators` | 3 | 3 | 45 |

```sh
TYPESAFE_API_KEY=... \
node dist/bench/run.js --cases bench/cases.json --out ~/jev-gate-runs/router-vs-high-2026-09-28 \
  --arms router --frontier-model opus --base-effort xhigh --fixed-effort high \
  --repetitions 3 --max-sessions 45 --max-cost-usd 29 --timeout-ms 600000 --seed 20260928 --execute
```

The key reaches the plugin only through the environment variable, never through a file the runner writes.

**These five cases are development data**, as in 2026-09-27: small, familiar fixtures, one per failure group, and
`ttl-cache` failed its checker in all three arms there. None of them delegates, so the Router's subagent-model
routing is not exercised here and nothing below speaks to it. A fixed "subagents on Sonnet" arm is left out rather than
built: the runner strips `CLAUDE_CODE_SUBAGENT_MODEL`, and none of these cases would spawn one. What this run can establish is a paired, per-task
difference on these tasks, not a claim about the owner's own work.

## What is measured

**Primary: complete cost per task**: Claude's cost plus the Router's Jev cost, as `report.js` sums it. Reported per
case as the paired difference between arms, and summarised as the median across the cases that pass rule 2. Never
pooled into one ratio.

**Co-reported under the same rules:** wall time per task and total Claude tokens per task (input, cache creation,
cache read and output in separate columns). **Recorded for every valid cell:** checker results, root steps with
assessed/proposed/applied/observed effort, skip and stop reasons, Router Jev attempts/known responses/cost, output
tokens (to recheck 2026-09-27's observation 2: a Router per-step `medium` behaved like `xhigh`, while a launch-time
`medium` cut calls and output four- to five-fold).

## Rules — fixed before the run

1. **Validity.** A cell with an environment error, a non-zero exit, a timeout or a cancel is invalid for comparison.
   Its spend is still counted in the run's total and its row is kept.
2. **Quality gates cost, per case and per pair.** A pair's cost comparison on a case is reported only if **every**
   cell of both arms on that case passes its checker. Otherwise that pair on that case reports no cost comparison,
   and its per-cell numbers stay in the record.
3. **Unknown is not zero.** A cell counts in a cost comparison only if its complete cost is known: Claude's cost
   from its result, and for `router` also the Router's Jev cost (unknown on a missing or damaged log or a request
   whose usage never arrived, `bench/README.md` "What stays unknown"). A cell of any arm whose cost is unknown makes
   that case's comparison unreportable for every pair that includes its arm. A known subtotal is never substituted.
4. **Headline needs three cases.** A headline for a pair is adjudicated only if at least 3 of the 5 cases pass rules
   2 and 3 for that pair. Otherwise the pair is "not adjudicated" and what was measured is still published.
5. **Nothing under 15 % is quoted**, in either direction. A median paired difference smaller than that is "no
   difference this bench can resolve".
6. **The order is the runner's seeded order** (`--seed 20260928`). There is no treatment-only warm-up, no prompt
   salting and no artificial priming. Auto-compact stays on.
7. **Spend stop.** The run stops at a cumulative $29 (so that the one-cell overshoot the runner allows stays inside the owner's $30): before starting each cell, the runner sums the complete cost
   of every row written so far and starts no cell once that sum reaches the cap (`--max-cost-usd`, precondition 1).
   A row whose cost is unknown stops the run too. Rows already written are kept, including incomplete ones. A stop
   never turns into a cheaper "result".
8. **No post-hoc changes.** Not the arms, the efforts, the cases, the 15 %, rule 2's "every cell", or rule 4's three
   cases. A different design is a different pre-registration.
9. **The negative result is the deliverable.** These apply only to a pair that rule 4 adjudicates; a pair that is
   not adjudicated is reported as that, with no conclusion either way.
   - If `router` is not more than 15 % cheaper than `router_native` on the median across adjudicated cases, the
     README's first line says the Router did not make these tasks more than 15 % cheaper for the owner's
     configuration. Under rule 5 no smaller difference is quoted.
   - If `router` is not more than 15 % cheaper than `router_fixed`, it says that choosing an effort per step showed
     no value over running at `high` without Jev that this bench can resolve.
   - If `router_fixed` is more than 15 % cheaper than `router_native` on the median across adjudicated cases **and**
     no `router_fixed` cell failed its checker on a case where every `router_native` cell passed, the README says
     that a fixed `high` cut cost on these tasks with no quality loss this bench detected. If it is not more than 15 %
     cheaper, it says a fixed `high` saved nothing this bench can resolve. If such a failure exists, the README
     reports it first and recommends no effort change.
10. **This run changes no default.** Enabling the Router on the owner's real host, or by default, is a separate
    decision by the owner, recorded separately. A bench result is not a release.
11. **The build is frozen and recorded.** The commit sha and `frozen_inputs.router_sha256` go in the results README.
    Cells from any other build are not mixed in.

## Falsification

Each claim is tested only on a pair that rule 4 adjudicates; otherwise it is reported as untested. "Not supported"
means no difference above 15 %, which under rule 5 is not the same as finding none.

| claim | not supported when, on an adjudicated pair |
|---|---|
| the Router saves on the owner's configuration | median paired cost saving against `router_native` not above 15 % |
| per-step selection adds value over a fixed `high` | median paired cost saving against `router_fixed` not above 15 % |
| a fixed `high` saves against `xhigh` | median paired cost saving of `router_fixed` against `router_native` not above 15 % |

| claim | falsified by |
|---|---|
| the Router is quality-neutral | a `router` cell failing its checker on a case where every `router_native` cell passes |
| a fixed `high` is quality-neutral | a `router_fixed` cell failing its checker on a case where every `router_native` cell passes |

## Estimate

From 2026-09-27's cells: mean $0.352 (native), $0.358 (Router), $0.271 (fixed `medium`); the largest cell $0.592.
Fifteen cells per arm with `high` between `medium` and `xhigh`: **about $14–16**. The worst case at every arm's
largest cell is about $27, inside the $29 stop.

## Preconditions

1. The spend stop exists (`--max-cost-usd`, #55).
2. Gates green on the frozen build: `npm run typecheck`, `npm run build`, `npx vitest run`, `claude plugin validate .`.
3. A plan-only run of the command above without `--execute` (0 inference) lists 45 cells.
4. The owner's approval above. It covers these 45 cells and the $29 stop. It does not cover a relaxed rule, another
   effort, a second attempt after a bad result, enabling the Router on the real host, changing the host's effort, or
   any release or tag.
