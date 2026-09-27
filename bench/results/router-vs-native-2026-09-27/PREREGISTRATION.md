# Pre-registration — does the Router make the owner's own sessions cheaper or faster? (2026-09-27)

Issue #45 (JGR-06), section C. Written **before any cell of this run exists**, on the build that merged #51
(`bc44ebc`). Nothing here may be edited once a cell has run; a change means a new pre-registration and a new run.

**Not authorised to run.** The owner's approval for this repository's current spending covers host observations
only, about $10 in total, of which $2.665 is spent (`bench/results/host-obs-2026-09-27/`). This run's estimate is
above what is left. It runs only after the owner approves it directly, as written here (see "Precondition").

## The question

> On the same task, does a session with the `jev-gate-router` plugin cost less per completed task, including the
> Router's own Jev requests, than the owner's plain configuration — and less than a fixed effort chosen up front
> with no Jev at all?

The two comparisons answer different things:

- `router` against `router_native` — does the whole Router policy save anything on the owner's configuration?
- `router` against `router_fixed` — does *choosing* an effort per step add anything over simply running at a lower
  effort all the time? A Router win that is only "the effort went down" is not a win for semantic selection.

## Arms

| arm | root | plugin | effort |
|---|---|---|---|
| `router_native` | `--frontier-model opus` | none | `--base-effort xhigh` |
| `router` | `--frontier-model opus` | `jev-gate-router` (Function Hooks), frozen copy of `mods/router` | starts at `xhigh`; the Router may lower it per step |
| `router_fixed` | `--frontier-model opus` | none | `--fixed-effort medium` |

`router_native` is how the owner runs Claude Code: Opus at `xhigh`, normal auto-compact, normal tools and native
delegation. None of them is disabled in any arm.

**Why `medium`, and when it was chosen.** It is the effort the Router itself applied on a development task in the
host observation (`host-obs-2026-09-27`, session S3b: patched `xhigh` → `medium`, fixture 2/2). It is chosen from
that development observation, before any cell of this run, and it is not tuned afterwards. If `router_fixed` wins,
that is a valid result (rule 9), not a reason to pick another effort and run again.

## Cells

| cases (`bench/cases.json`) | arms | repetitions | cells |
|---|---|---|---|
| `search-race`, `quote-pricing`, `status-count`, `ttl-cache`, `wide-validators` | 3 | 2 | 30 |

```sh
TYPESAFE_API_KEY="$(cat ~/.config/jev-gate/typesafe.key)" \
node dist/bench/run.js --cases bench/cases.json --out ~/jev-gate-runs/router-vs-native-2026-09-27 \
  --arms router --frontier-model opus --base-effort xhigh --fixed-effort medium \
  --repetitions 2 --max-sessions 30 --timeout-ms 600000 --seed 20260927 --execute
```

The key reaches the plugin only through the environment variable, never through a file the runner writes
(`bench/README.md`, "Router arms").

**These five cases are development data**, and the result is labelled that way: they are small, familiar fixtures,
one per failure group. Two repetitions of one task are not two independent projects. What this run can establish is
a paired, per-task difference on these tasks. It is not a general claim, and a follow-up on tasks from the owner's
own work is required before any default changes (rule 10).

## What is measured

**Primary: complete cost per task**: Claude's cost plus the Router's Jev cost, as `report.js` sums it. Reported
per case as the paired difference between arms, and summarised as the median across the cases that pass rule 2.
Never pooled into one ratio.

**Co-reported under the same rules: wall time per task** (seconds, whole session) and **total Claude tokens per
task** (input, cache creation, cache read and output kept in separate columns, as #45 section B requires). The
owner's goal is fewer tokens and faster work, so both are headline columns. Cost is the one the kill criterion
reads, because it weights the token classes by what they cost.

**Recorded for every valid cell, whatever rule 2 does:** checker results, root steps with
assessed/proposed/applied/observed model and effort, skip and stop reasons, spawns with requested/resolved model,
`model_mismatch`, Router Jev attempts/known responses/input tokens/cost, and `unparsable_lines`.

## Rules — fixed before the run

1. **Validity.** A cell with an environment error, a non-zero exit, a timeout or a cancel is invalid for comparison.
   Its spend is still counted in the run's total and its row is kept.
2. **Quality gates cost, per case and per pair.** A pair's cost comparison on a case is reported only if **every**
   cell of both arms on that case passes its checker. Otherwise that pair on that case reports no cost comparison,
   and its per-cell numbers stay in the record.
3. **Unknown is not zero.** A `router` cell whose Router cost is unknown (a missing or damaged log, a request whose
   usage never arrived, `bench/README.md` "What stays unknown") makes that case's comparison for `router`
   unreportable. It is not filled in with the known subtotal.
4. **Headline needs three cases.** A headline for a pair is adjudicated only if at least 3 of the 5 cases pass rules
   2 and 3 for that pair. Otherwise the pair is "not adjudicated" and what was measured is still published.
5. **Nothing under 15 % is quoted**, in either direction. A median paired difference smaller than that is "no
   difference this bench can resolve".
6. **The order is the runner's seeded order** (`--seed 20260927`). There is no treatment-only warm-up, no prompt
   salting and no artificial priming. Auto-compact stays on.
7. **Spend stop.** The run stops at a cumulative $30. Rows already written are kept, including incomplete ones. A stop
   never turns into a cheaper "result".
8. **No post-hoc changes.** Not the arms, the efforts, the cases, the 15 %, rule 2's "every cell", or rule 4's three
   cases. A different design is a different pre-registration.
9. **The negative result is the deliverable.**
   - If `router` is not more than 15 % cheaper than `router_native` on the median across adjudicated cases, the
     README's first line says the Router did not make these tasks cheaper for the owner's configuration.
   - If `router` is not more than 15 % cheaper than `router_fixed`, it says that choosing an effort per step measured
     no value over running at `medium` without Jev. The recommendation is then the fixed setting, which costs no Jev
     request and no plugin.
10. **This run changes no default.** Enabling the Router on the owner's real host, or by default, is a separate
    decision by the owner, recorded separately. A bench result is not a release.
11. **The build is frozen and recorded.** The commit sha and `frozen_inputs.router_sha256` go in the results README.
    Cells from any other build are not mixed in.

## Falsification

| claim | falsified by |
|---|---|
| the Router saves on the owner's configuration | median paired cost difference against `router_native` not above 15 % |
| per-step selection adds value over a fixed lower effort | median paired cost difference against `router_fixed` not above 15 % |
| the Router is quality-neutral | a `router` cell failing its checker on a case where every `router_native` cell passes |
| the Router is faster | median paired wall-time difference against `router_native` not above 15 % |

## Estimate

The host observation's Opus `xhigh` sessions on four-file fixtures cost $0.24–0.47 each. The four small cases give
24 cells, about $6–12. `wide-validators` has not been run on Opus `xhigh` here; at an assumed $1–3 per cell, its 6
cells are $6–18. **Total about $12–30**, capped at $30 by rule 7. That is above the $7.3 left of the current
authorisation.

## Precondition for spending

1. Gates green on the frozen build: `npm run typecheck`, `npm run build`, `npx vitest run`, `claude plugin validate .`.
2. A plan-only run of the command above without `--execute` (0 inference) that lists 30 cells and freezes
   `cli.router_policy`.
3. **The owner's own approval for this run as written, given directly.** A relayed approval is not the owner's
   word. It covers these 30 cells and the $30 stop. It does not cover a relaxed rule, another effort, a second
   attempt after a bad result, enabling the Router on the real host, or any release or tag.
