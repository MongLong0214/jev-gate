# Pre-registration — does lean save anything over native auto-compact, and over a plain recency handoff? (2026-09-27)

Issue #29 (JGL-05). Written **before any cell of this run exists**, on the build that merged #51 (`bc44ebc`).
Nothing here may be edited once a cell has run; a change means a new pre-registration and a new run.

**Not runnable yet, and not authorised.** Three preconditions below are engineering work that does not exist yet (the
episode cases, a follow-up turn in the runner and a spend stop in the runner), and the owner has approved no spending
for this run. The design
is fixed here first so that the cases and the runner change are built to it, not the other way round.

## The question

> On a complete requested coding outcome in an ordinary session, does `jev_lean` use fewer Claude tokens and cost
> less, including its own Jev request, than the same session with no plugin (`native_auto`) — at the same checker
> result and without being slower? And does it beat `recent_packet`, the same handoff filled by recency with no Jev?

- `jev_lean` against `native_auto` asks whether the lean policy is worth installing at all.
- `jev_lean` against `recent_packet` asks whether Jev's choice of history adds anything over "keep the newest
  groups". If it does not, the product is the deterministic handoff, with no Jev request.

## Why the earlier attempts produced nothing, and what this design changes

`v5-lean-measure-2026-09-21` started three runs and got no efficacy number. The last one failed on the fixture, not
the code: every depth case primes with *"이 읽기는 네가 직접 해라. 서브에이전트나 다른 워커에게 넘기지 마라"*.
`v5-lean-scope-probe-2026-09-25` showed that this ban is at most arguably about the later task. Either way, a fixture
whose history contains a delegation ban cannot measure a handoff. #29 also rules out the depth cases' other feature,
artificial priming to a target depth. So this run **does not use `bench/cases-depth.json` or any case with a
delegation instruction in its history**. It uses new episode cases instead (precondition 1).

## Arms (the runner's `--arms lean`)

| arm | plugin | what runs |
|---|---|---|
| `native_auto` | none | Sonnet root, normal tools and native subagents, ordinary auto-compact, same permissions |
| `recent_packet` | lean artifact, `JEV_GATE_BENCH_RECENT=1` | the same executor and bounds; packet filled with mandatory groups, then the newest complete optional groups; no Jev |
| `jev_lean` | lean artifact | the actual lean path: local skips, one Jev batch, `no_effect` fallback, selected groups; the root may ignore the suggestion |

The lean profile is Sonnet-only today, so every arm runs a Sonnet root and the result is labelled Sonnet-only. Both
lean arms use the same packet cap, `LEAN_PACKET_MAX_BYTES` = 64 KiB less the coordinator reserve
(`LEAN_PACKET_BUDGET_BYTES`, `src/lean.ts`), recorded in the run manifest. No force-dispatch instruction is added to
any arm, and a paid `no_effect` or an ignored suggestion is part of `jev_lean`'s cost, not an excluded run.

## Cases: three new episodes (precondition 1)

Each case is one natural episode in a small fixture repository, written as the owner works: in Korean, except that at
least one episode is in English so the result is not Korean-only.

1. **Earlier requests**, 2–4 of them: real work on the same repository (read, change, run its tests). This is the
   history lean chooses from. There is no instruction about delegation, no instruction to read for the sake of depth,
   and no target depth.
2. **The measured request**: a bounded change that builds on what the earlier requests established, with a trusted
   checker.
3. **One ordinary follow-up**, such as a small amendment to the same change, with its own checker. #29 requires it:
   moving detail out of the root can move cost into the next request.

The case files, checker files and their sha256
are committed in an addendum to this file **before the first cell**, and are never changed after it. The cases are
development-authored, so the result is labelled development-set evidence.

## Cells

| cases | arms | repetitions | cells |
|---|---|---|---|
| 3 episodes | `native_auto`, `recent_packet`, `jev_lean` | 2 | 18 |

```sh
TYPESAFE_API_KEY="$(cat ~/.config/jev-gate/typesafe.key)" \
node dist/bench/run.js --cases bench/cases-episodes.json --out ~/jev-gate-runs/lean-vs-native-2026-09-27 \
  --arms lean --plugin-dir "$PWD" --repetitions 2 --max-sessions 18 --max-cost-usd 30 --timeout-ms 1800000 \
  --seed 20260927 --execute
```

## What is measured

**The whole episode is charged**: every earlier request, the measured request and the follow-up, in every arm. The
earlier requests are the same text in every arm, but lean acts on them as history, so separating them out would
exclude part of the treatment's effect. Per-request splits are also reported, as a record.

**Primary: complete cost per episode**, meaning Claude plus lean's Jev cost. Reported per episode as paired
differences and summarised as the median across the episodes that pass rule 2.

**Co-reported under the same rules: total Claude tokens per episode** (input, cache creation, cache read and output
in separate columns) **and wall time per episode.**

**Recorded for every valid cell:** checker results per request, lean outcome (`pending`/`dispatched`/`no_effect`/
skipped and why), retained and omitted groups by cause (source window, provider-unassessed, Jev-selected,
recency-omitted), packet bytes, whether the root used the suggestion, and executor calls.

## Rules — fixed before the run

1. **Validity.** An environment error, non-zero exit, timeout or cancel makes a cell invalid for comparison. Its spend
   still counts, and its row is kept.
2. **Quality gates cost, per episode and per pair.** A pair's comparison on an episode is reported only if every
   cell of both arms passes **both** checkers (the measured request and the follow-up).
3. **Unknown is not zero.** A `jev_lean` cell whose Jev cost is unknown makes that episode's `jev_lean` comparison
   unreportable. A known subtotal is not substituted for it.
4. **Headline needs two of three episodes** passing rules 2 and 3 for that pair. Otherwise the pair is "not
   adjudicated", and what was measured is still published.
5. **Nothing under 15 % is quoted**, in either direction.
6. **Auto-compact stays on.** No artificial priming, no prompt salting, no treatment-only warm-up. Order is the
   runner's seeded order.
7. **Spend stop** at a cumulative $30, or the owner's approved figure if that is lower: before each cell the runner
   sums the complete cost of every row written so far and starts no cell once the sum reaches the cap
   (`--max-cost-usd`, precondition 3). A row whose cost is unknown stops the run too. Rows written so far are kept.
8. **No post-hoc changes** to arms, cap, cases, the 15 %, or rules 2 and 4.
9. **The negative result is the deliverable.** These apply only to a pair that rule 4 adjudicates; a pair that is
   not adjudicated is reported as that, with no conclusion either way.
   - If `jev_lean` is not more than 15 % cheaper than `native_auto`, the README's first line says lean did not save
     more than 15 % on these episodes. Under rule 5 no smaller difference is quoted.
   - If it is not more than 15 % cheaper than `recent_packet`, the README says Jev's selection showed no value over
     recency that this bench can resolve. The recommendation is then the recency handoff, with no Jev request.
10. **This run changes no default** and is not a release.
11. **The build is frozen and recorded** (commit sha, case and checker hashes, packet cap).

## Falsification

Each claim below is tested only on a pair that rule 4 adjudicates; otherwise it is reported as untested. "Not
supported" means the bench found no difference above 15 %, which under rule 5 is not the same as finding none.

| claim | not supported when, on an adjudicated pair |
|---|---|
| lean saves over native auto-compact | median paired episode cost saving against `native_auto` not above 15 % |
| Jev's selection adds value over recency | median paired episode cost saving against `recent_packet` not above 15 % |

| claim | falsified by, on an adjudicated pair |
|---|---|
| lean moves no cost into the next request | median follow-up request cost in `jev_lean` above `native_auto`'s by more than 15 % |
| lean is quality-neutral | a `jev_lean` cell failing a checker on an episode where every `native_auto` cell passes |

## Estimate

Sonnet-root episodes of 4–6 requests on small fixtures are estimated at $0.5–1.5 per cell, so **about $9–27 for 18
cells**, capped by rule 7. That is an estimate and has not been measured.

## Precondition for spending

1. **Episode cases** (`bench/cases-episodes.json`, fixtures and checkers) built to the section above, with their
   reference solutions passing and the fixtures failing in `tests/bench-fixtures.test.ts`. The hash addendum is
   committed here.
2. **A follow-up turn in the runner**, charged and checked like the measured request. Today the runner has earlier
   turns (`prime`) and one request. It also needs a whole-episode cost column in the report. Both come with unit
   tests through actual ingestion and report.
3. **A spend stop in the runner.** The runner (`src/bench/run.ts`) has session and time limits but no cost limit.
   It needs `--max-cost-usd`, checked before each cell as rule 7 says, with unit tests through actual rows.
4. Gates green on the frozen build, and a plan-only run (0 inference) that lists 18 cells.
5. **The owner's own approval for this run as written, given directly.** It covers these 18 cells and the spend
   stop. It does not cover a relaxed rule, another cap, a second attempt after a bad result, or any default change,
   release or tag.
