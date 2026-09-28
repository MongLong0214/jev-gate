# Pre-registration — is the single shape's saving depth-bound? (2026-09-19)

## The question

One question. `v5-single-vs-native` measured the `single` shape against `sonnet_native` on two jobs that both
primed to about 390,000 context, and found the job turn 71.0 % cheaper on `wide-validators`. That run also found
the mechanism: the saving is **root turns taken at depth** (42/43 → 11), not fewer tool calls. If that is the
mechanism, the saving should shrink as the session gets shallower, and at some depth it should disappear.

**Does the `single` shape still cost less than `sonnet_native` at 180K and 280K, or only at 390K?**

Nothing else is asked here. This run does not compare `single` against `hierarchy`, does not touch `planner.md`,
and does not change any default.

## Why this is worth paying for

`delegationDepthFloor` ships at 300,000. That number was set from the **hierarchy** shape: the crossing run
(`v5-crossing-2026-09-19`) measured −10.5 % at ~180K, −43.0 % at ~281K and −59 to −69 % at ~376K for the delegated
path, and decided the floor on the real-prompt depth distribution, not on precision. The `single` shape has never
been measured below 300,000. It has fewer moving parts than `hierarchy` — no planner call, no plan, no contract,
one dispatch — so its crossing could sit anywhere relative to the hierarchy one. The floor is the setting that
decides how much of the product's surface is ever live, and right now the shape being proposed as the default has
no measurement under it.

## Arms, jobs, cells

| | |
|---|---|
| arms | `sonnet_native`, `jev_single` |
| jobs | `wide-validators-primed-13`, `wide-validators-primed-21`, `wide-validators-primed-30` |
| repetitions | 2 |
| cells | 3 × 2 × 2 = **12** |
| `--cases` | `bench/cases-depth.json` |
| `--max-sessions` | `12` (a cap on planned cells, not on concurrency — `r-svnsessions`) |
| build | the `dev` commit this file is committed on |

The three jobs are **one fixture and one byte-identical request** at three priming lengths. Depth is the only
thing that differs between the rungs, which is what makes a ladder out of them.

`jev_hierarchy` is not in this run. Adding it would double the cost and answer a different question, and the
`hierarchy`-vs-`single` comparison belongs to the pending default decision rather than to this one.

## The floor is lowered in the bench config, not in the product

Below 300,000 Gate A refuses before it asks anything (`depth_below_floor`, zero Jev requests, zero workers —
`r-5f28e84c4518`). So with the shipped floor there is nothing to measure at the two shallow rungs: the plugin arm
would be native with a plugin loaded.

This run therefore freezes a **bench-only config** with `delegationDepthFloor: 50000`:
`bench/results/v5-depth-ladder-2026-09-19/config-floor-50000.json`, passed as `JEV_GATE_CONFIG` to the runner,
which records it in `plan.json` as `effective_config` and `effective_config_source`. Every other key is the
shipped default. **`~/.config/jev-gate/config.json` is not touched and `src/config.ts` is not changed.**

The alternative — `jev_forced_orchestration`, which is how the crossing run reached these depths — was considered
and is rejected here. That arm orchestrates *every* prompt including the priming turns, and it has already failed
in two different ways on this fixture: one cell delegated the priming reads to workers, one cell read a single
note and stopped at 33,216 context. The crossing run's own conclusion was that "a future depth study should prime
in a mode that leaves the priming turn alone". Lowering the floor does exactly that, and the deep-rung records
show why it is safe: the first priming prompt is `depth_unknown` and stays direct with no request sent at all,
and the second priming prompt was *asked* at 387,823 context and Gate A answered `admission_answer_only` — direct.
Both priming prompts are left alone by the gate's own judgement rather than by the floor.

That safety is an assumption, so rule 2 below makes it a validity check instead of a hope.

## Rules, fixed before any cell exists

1. **Depth band per rung.** A cell is valid only if its `context_at_job_prompt` falls in the band for its rung:
   13-note **120,000–250,000**, 21-note **200,000–340,000**, 30-note **330,000–450,000**. The bands come from
   already-measured depths (13-note: 179,171–180,778; 21-note: ~281,000; 30-note: 387,439–388,500) widened to
   catch a partial priming turn, which is how the crossing run's one invalid cell failed (33,216). An out-of-band
   cell is reported with its cause and excluded.
2. **Priming integrity.** A cell is invalid if any **priming** prompt recorded an admission decision of
   `orchestrated`. Expected: prompt 1 `depth_unknown`, prompt 2 `admission_answer_only`, both `direct`.
3. **Quality gates cost, per rung.** If any valid cell in a rung fails its checker, that rung reports mechanism
   only and **no cost percentage is quoted for it**. The other rungs are unaffected.
4. **Admission is a result, not a filter.** For each rung the number of `jev_single` job prompts Gate A actually
   admitted is reported as a headline. A cell whose job prompt was not admitted is valid, is counted, and is named
   in the report; it is excluded from the cost comparison and the exclusion is stated with its count. **If a rung
   has fewer than 2 admitted `jev_single` cells, no percentage is quoted for that rung.**
5. **Separation, not just size.** A rung's difference is called a separation only if it is **≥ 15 %** *and*
   **larger than the wider of the two arms' own cell-to-cell spreads in that rung**. Otherwise it is reported as a
   direction with the spread printed beside it. This is written in front because it is known to bite here: the
   13-note native arm's two cells differed by **26.9 %** in an earlier run, wider than the difference being
   measured, and the same caveat had to be attached to the orbit result after the fact last time.
6. **Within-rung only.** Arms are compared at the same rung. No cell-to-cell dollar comparison across rungs, and
   **no comparison against the `v5-single-vs-native` run** — that run froze a different config (floor 300,000) and
   comparing two runs with different frozen inputs is the comparison this harness exists to avoid. The 30-note
   rung is in this run so that the ladder is internally valid, and it doubles as the reproduction check.
7. **The unit is the job turn**, `turn_totals_usd[-1] − turn_totals_usd[-2]`, as in the previous run. Session
   totals are reported but are not the comparison.
8. **The product floor does not move because of this run.** `delegationDepthFloor` stays 300,000 in `src/config.ts`
   whatever the result. Moving it is a decision about which errors to prefer, taken against the real-prompt depth
   distribution, and it needs its own document.
9. **No default change, no `planner.md` change, no release, tag or publish in this run.**
10. **Nothing under 15 % is quoted as a difference anywhere in this report** (this bench resolves ~10 % with plan
    size fixed and ~47 % with it free).
11. **No rule, threshold or band on this page changes after a number is seen.** If one has to change, it is a new
    pre-registration and a new run.
12. **A negative result is the deliverable.** "The saving is depth-bound" is a finding, and it is the one that
    confirms the shipped floor is doing real work.

## What each result means

| outcome | conclusion |
|---|---|
| 13-note and 21-note both separate (rule 5) toward cheaper | the saving is **not** depth-bound for this shape; the 300,000 floor, set from hierarchy numbers, is refusing prompts this shape would have paid off on, and deserves its own re-examination — which this run does not perform |
| neither shallow rung separates | the saving is **depth-bound**; root turns at depth is confirmed as the mechanism and the shipped floor is correct for this shape too |
| 21-note separates, 13-note does not | the crossing sits between the two rungs for `single` as it does for `hierarchy` (180K–281K); the shape does not move the crossing |
| 13-note separates, 21-note does not | no coherent depth story; the rungs are then reported as-is and the next question is what else differs between them |
| the 30-note rung does not reproduce a cheaper `single` | something other than depth produced the 71.0 % figure; nothing else in this run is interpretable until that is resolved, and it is reported as the headline |
| Gate A refuses or stays direct at a shallow rung despite the lowered floor | the depth answer comes from **Gate A's own judgement**, not from cost; reported under rule 4 with the counts |

## Cost

Estimated from the per-cell session totals already measured on this fixture: native ≈ $5.5 / $4.0 / $3.0 and
`single` ≈ $3.7 / $2.8 / $2.2 at the 30 / 21 / 13-note rungs. **Estimate ≈ $40, and the spend is the session
totals, not the job-turn dollars that the comparison is made of.** This is the same order as the previous run.

## Authority for the spend

The owner delegated this decision directly on 2026-09-19. The sentence this run answers is the one I had deferred
to them — "the saving is root turns, so it should disappear at shallow depth; both jobs were ~390K; this is a new
pre-registration and the owner's approval, so I have not chained it automatically" — and the owner's reply was
**"이거 너가 자율판단해서진행해"**: proceed on your own judgement.

That delegation covers **this run as written on this page and nothing else.** It is not cover for a relaxed rule,
for a second attempt after a bad result, for a third arm, for a default change, or for a release. A peer session's
relay of any owner decision is still not the owner's own word.

## Preconditions

- `npm run typecheck`, `npm run build`, `npx vitest run` all green on the commit that runs.
- This file committed **before** the first cell.
- `TYPESAFE_API_KEY` supplied to the run from `~/.config/jev-gate/typesafe.key`; the key is never printed,
  logged or committed.

## Command

```
JEV_GATE_CONFIG=bench/results/v5-depth-ladder-2026-09-19/config-floor-50000.json \
TYPESAFE_API_KEY="$(cat ~/.config/jev-gate/typesafe.key)" \
node dist/bench/run.js --cases bench/cases-depth.json \
  --only wide-validators-primed-13,wide-validators-primed-21,wide-validators-primed-30 \
  --arms sonnet_native,jev_single --repetitions 2 --max-sessions 12 \
  --out ~/jev-gate-runs/v5-depth-ladder --execute
```
