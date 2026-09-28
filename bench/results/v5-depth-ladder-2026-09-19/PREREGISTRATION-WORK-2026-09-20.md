# Pre-registration — do the 21-note and 30-note rungs reproduce, and in which unit? — 2026-09-20

This is a **new pre-registration**, not an amendment. `PREREGISTRATION.md` stands unchanged and its rules 1–12
still govern the three runs already made. This page governs run 4 only, and it changes one thing on purpose and
in front: **the work unit is promoted to co-primary, before any cell of this run exists.**

That promotion is the route the old rules require. `r-metricdefect` ruled out restating the existing ladder under
the work unit, because rule 11 forbids swapping a unit after seeing results. The permitted route is to write a new
pre-registration and measure again. This is that page.

## The question

The 13-note rung was measured twice with byte-identical inputs. In dollars it reversed: −41.8 % on 09-19,
`single` **72.5 % more expensive** on 09-20. In work it did not move at all — `single` re-read **10.1 % less than
native in both runs, identical to the decimal**. What changed was the fraction of the same traffic the host
reported: 63 % on 09-19, 16 % on 09-20 (`r-mechcorrect`).

One rung showed that. Two rungs — 285K and 389K — carry the ladder's surviving dollar claims and have been
measured **once each, in the high-attribution regime**.

**Do the 21-note and 30-note rungs reproduce, in dollars and in work?**

Nothing else is asked. No default changes, no floor changes, no planner change, no release.

## What runs

Both rungs whole: 2 jobs × 2 arms × 2 repetitions = **8 cells**.

```
JEV_GATE_CONFIG=bench/results/v5-depth-ladder-2026-09-19/config-floor-50000.json \
node dist/bench/run.js --cases bench/cases-depth.json \
  --only wide-validators-primed-21,wide-validators-primed-30 \
  --arms sonnet_native,jev_single --repetitions 2 --execute --max-sessions 8 \
  --out ~/jev-gate-runs/v5-depth-ladder-4
```

Same frozen bench config as all three prior runs (`delegationDepthFloor: 50000`). The live
`~/.config/jev-gate/config.json` is not touched and the product floor stays 300,000.

## The build

**The plugin build is unchanged since `b2c4548`** — the build run 2 measured these two rungs on.
`git diff b2c4548..HEAD -- plugin/ package.json` is empty. The only code change under `src/` is
`src/bench/run.ts` (+35 lines, `146d295`): the runner now records `turn_totals_stream` per turn.
That code reads stream events the runner already received and **sends nothing to a session**, so the cells run
the same plugin the prior measurement ran.

## The units, fixed before any cell exists

Three numbers are recorded for the job turn of every cell. Two are co-primary; one is a diagnostic.

| unit | what it is | status |
|---|---|---|
| **cache reads** | `cache_read_input_tokens` summed over every message in the turn, subagents included | **co-primary** |
| **output tokens** | `output_tokens` summed the same way | **co-primary** |
| dollars | `turn_totals_usd[-1] − turn_totals_usd[-2]`, the old rule 7 unit | **co-primary, retained** |
| host-reported fraction | the host's reported cache reads ÷ the summed cache reads | **diagnostic, never a comparison** |

Wall clock is reported and is not a unit, as before.

Both work figures come from `cell.turn_totals_stream` where the runner recorded it and from `stream.jsonl`
summed identically where it did not, so run 2 and run 4 are derived by the same code path
(`apply-rules-work.cjs`, committed with this file, before the run).

## Rules

1. **Rules 1, 2, 3, 4, 8, 9, 11, 12 of `PREREGISTRATION.md` apply unchanged**: the depth bands
   (21-note 200,000–340,000; 30-note 330,000–450,000), priming integrity, the quality gate, admission as a
   result, the floor that does not move, no default or planner or release change, no rule changed after a number
   is seen, and a negative result being the deliverable.
2. **The separation test keeps its form and is applied to each unit separately**: a difference is a separation
   only if its **magnitude is ≥ 15 %** *and* **larger than the wider of the two arms' own cell-to-cell spreads in
   that rung**. Magnitude, not signed difference — that is the defect fixed in `146d295` and verified to move no
   published number.
3. **Within-rung only.** Arms are compared at the same rung. **No percentage from this run is differenced against
   a percentage from any other run.**
4. **Reproduction is judged on the verdict, not on a difference of percentages.** A unit reproduces at a rung if
   this run's **verdict class** (SEPARATION / under-the-floor / direction-only) **and direction** both match the
   table below. This keeps rule 6 intact: nothing is subtracted across runs.
5. **No third attempt.** Whatever this run returns is the result for these rungs. If it disagrees with run 2, both
   stand as published and the disagreement is the finding.
6. **Nothing under 15 % is quoted as a difference anywhere in the report.**

## What run 2 said, written here before run 4 exists

Produced by `apply-rules-work.cjs` against `~/jev-gate-runs/v5-depth-ladder-2` on 2026-09-20, before this run.

| rung | cache reads | output tokens | dollars |
|---|---|---|---|
| 21-note (285K) | 12.4 % single MORE — under the floor | 29.6 % single MORE — SEPARATION | 43.1 % single LESS — SEPARATION |
| 30-note (389K) | 27.1 % single LESS — SEPARATION | 11.3 % single MORE — under the floor | 56.6 % single LESS — SEPARATION |

Note what is already visible without any new cell: **at 285K the two co-primary units already disagree in sign**
with the dollar unit, and they disagree with each other across the two rungs. The ladder's dollar story is not the
work story, and that was true before this run was authorised.

## What each result means

| outcome | conclusion |
|---|---|
| both rungs reproduce in **work and dollars** | the 21/30 figures stand as measured for these rungs, and the 13-note reversal is local to that rung rather than general. The ladder is still not a within-run curve (three rungs, now three runs) |
| work reproduces, **dollars do not** | settled: the dollar unit tracks the host's attribution and not the arms. Every job-turn dollar figure this bench has published — including −59~−69 % at 376K — is withdrawn as a measure of the shapes, and work is the unit any future claim here is made in |
| **work does not reproduce** | the arms themselves vary run to run at these depths. Neither unit measures a stable property with 2 repetitions inside one day, and the depth question needs a design with repetitions **across** days before it is asked again. The ladder is withdrawn entirely, not re-stated in work terms |
| dollars reproduce but work does not | reported as-is; the open question becomes what produces equal dollars out of unequal work, and nothing is quoted until it is answered |
| a rung fails a validity or quality rule | that rung quotes nothing, per the rules it inherits; the other rung is unaffected |
| the host-reported fraction lands near 63 % | the high-attribution regime is reproducible and the dollar figures belong to it; recorded as a diagnostic, never quoted as a result |

## Cost, and a correction to the figure the owner approved against

Run 2 ran these exact 8 cells for **$32.62** in session totals. Run 3's 4 cells cost $6.69, about $1.67 a cell
against run 2's $4.08 — because reported spend follows the same host attribution this run is investigating.

**So the honest estimate is $13–$33, and which end it lands on is itself part of the answer.**

I quoted **"약 $25"** to the owner in the message they approved. That was my estimate and it was low: the
identical prior run cost $32.62. The **scope is unchanged** — the same 8 cells, the same rungs, the same arms,
the same 2 repetitions, which rule 2 needs — so this runs as approved, with the corrected number recorded here
before the first cell and repeated in the report. Cutting a repetition to reach $25 was considered and rejected:
it would remove the arm spread the separation test is made of.

## Authority for the spend

The owner replied **"승인"** on 2026-09-20 to a message whose only item awaiting approval was
"21·30노트 rung 을 `turn_totals_stream` 켠 채 다시 재기 — 약 $25, 미승인".

That covers **these 8 cells as written on this page and nothing else.** It is not cover for the `admittedShape`
default flip, a floor change, a relaxed rule, a third arm, a release, or a further attempt if the result is
unwelcome. A peer session's relay of an owner decision is still not the owner's own word.

## Preconditions

- `npm run typecheck`, `npm run build`, `npx vitest run` green on the commit that runs.
- This file and `apply-rules-work.cjs` committed **before** the first cell.
- `TYPESAFE_API_KEY` supplied from `~/.config/jev-gate/typesafe.key`; never printed, logged or committed.
