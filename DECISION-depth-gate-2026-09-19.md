# Decision: depth is computed, Gate A is decomposed behind it, worker count gets a backstop — 2026-09-19

This is a decision and a work guide, not a measurement. Every number cited is one repetition unless the source says
otherwise, and the sources are named. Where the material does not settle something, this file says so instead of
choosing.

## The four decisions

| question | decision |
|---|---|
| 1. Where does depth belong | **Computed in code** at `UserPromptSubmit`, from the session transcript, before any Jev call. It gates whether Gate A is asked at all. Never sent to Jev. |
| 2. Decompose Gate A | **Yes**, as read-offs plus a size score, combined in code, behind a config key that defaults to the shipped composite. Switched on only after the bench can admit a job through the real gate at real depth (step 3). |
| 3. Constrain worker count | **Yes, as a backstop, not a budget**: keep `maxParallelWorkers: 1`, add a task-count ceiling on an accepted plan. The largest measured worker-count harm was at shallow depth, which decision 1 refuses before a planner runs. |
| 4. Order | depth reader → primed-context bench case → atomic Gate A end to end → task ceiling → atomic Gate B by default. Details below. |

Things this decides **not** to do, with the measurement that rules each out:

- **Do not ask Jev about depth or cost.** Three arms tried it (`v5-context-locality-2026-09-19/OPENING-THE-GATE.md`): the
  number changed nothing (12/61 → 12/61, 0 admitted) and the number plus an explanation made it worse (7/61). The
  cost question itself topped at 0.78. Jev is confident on what is in the input and hedges on forecasts; depth is a
  fact about the session, not about the request, and code already has it exactly.
- **Do not lower `admissionConfidenceFloor` to admit the composite question.** Its ceiling is 0.65–0.78 and option order
  alone moves 11–18 % of its answers (`v5-question-shape-2026-09-19`). A floor low enough to admit it admits guesses.
- **Do not implement the `T = size × 12` arithmetic in `src/`.** `T` per size level is fitted to two ground-truth points
  (`v5-fanout-2026-09-19/README.md`, "Not settled"). The decision below uses depth as a threshold and the request
  read-offs as vetoes, which needs no `T`.
- **Do not touch the planner tier.** The $0.41 opus pass prevents $2.14 of coordinator work (`v5-parallel-2026-09-19`).
- **Do not raise `maxParallelWorkers` by default.** Serial haiku is the cheapest configuration measured (−81.8 %);
  parallel 4 bought 53 s for $0.38.
- **Do not build a dynamic prefix budget for workers.** Nothing measured calibrates it; the ceiling in step 4 is enough
  insurance until something does.

## 1. Depth: computed in code, read at `UserPromptSubmit`, gating the Jev call

### Why code and not Jev

The governing relationship is `saving ≈ T·(main_context − 45K)·$0.30/M − $0.39`. At this operator's median depth of
657K the toll is repaid in 2.1 turns; at 55K it takes 121. Any job that is not a one-line reply or a single small edit
takes more than 3 turns (the fresh native cell took 40, the loaded one 74). So at depth the decision is almost entirely
the depth number, and the residual question — is this a reply, a refusal to delegate, or a job with a missing
reference — is exactly the kind Jev answers at 0.98–1.00.

The asymmetry also says where the risk sits. Admitting a shallow job costs +182 % ($0.57 on a $0.31 job). Admitting a
one-line edit at 657K costs roughly the toll minus one or two turns of saving, about $0.1–0.4, bounded. Missing a real
job at 406K costs $3.59. The depth floor removes the first case entirely; the vetoes trim the second; nothing else
addresses the third.

### Mechanism

- **Source of the number.** Claude Code passes `transcript_path` on every hook event. `parseInput` in `src/hook.ts:136`
  currently drops it; add it to the kept keys and to `HookInput` in `src/types.ts`.
- **Reader.** New `src/depth.ts`: open the transcript, read backwards from the end in bounded chunks, and return the
  `usage` of the last non-sidechain assistant message as
  `cache_read_input_tokens + cache_creation_input_tokens + input_tokens`. This is the same definition
  `bench/results/v5-context-locality-2026-09-19/prompts-depth.mjs:24` used for the 61-prompt replay, so the offline
  numbers transfer to the runtime unchanged. Cap the backward read (proposal: 8 MB or 200 ms, whichever first) because
  a single tool-result line can be over a megabyte; if no usage line is found within the cap the result is `unknown`.
- **Where it is read.** `handleUserPrompt` in `src/hook.ts`, after the generation is registered (`hook.ts:376`) and
  before `callGate(buildAdmissionRequest(...))` at `hook.ts:403`. The forced diagnostic arm
  (`JEV_GATE_EXPERIMENT_ADMISSION=orchestrated`) keeps bypassing everything, but the depth reading is still written to
  the `admission_result` trace record as `context_tokens` so the bench can verify it.
- **What it gates.** If depth is `unknown` or below the floor, the turn is `direct` with a new preserve reason
  (`depth_unknown` / `depth_below_floor`) and **no Jev call is made**. Unknown never admits; that is the fail-safe
  direction. Above the floor, Gate A runs (composite today, atomic after step 3).
- **Config.** New key `delegationDepthFloor` (tokens), validated as an integer in a sane range, reported by `doctor`.
  Absent means the default. The floor applies to both question shapes, so it can ship before step 3: with the
  composite gate it changes nothing (0/61 admitted anyway) and is pure safety net.
- **Default.** The only measured points are 55,718 (loses, +182 %) and 406,218 (wins, −57 %). The model between them
  overestimates the win by about 2× on the loaded side (predicted +$7.63, measured +$3.59). Applying that correction,
  the turns needed to repay the toll are roughly 17 at 200K, 10 at 300K, 7 at 400K. **Ship the default at 300,000**
  and let step 2's mid-depth cells move it. This admits most of the operator's real prompts (p10 was 245K) while
  staying above the depth where any measured harm exists.

### Known limitation, stated plainly

Depth at `UserPromptSubmit` is depth *before* this turn's work. A job that starts shallow and grows inside the turn —
which is exactly how the bench's `wide-validators-loaded` fixture reaches 406K — is not captured. For the operator's
real sessions this loses only the first job of a fresh session; 61 of 61 recorded prompts were already above the
crossing point when typed. A mid-turn re-check where a direct-shape session calls the planner itself (the
coordinator-initiated path at `hook.ts:770`) is a later option and not part of this guide.

## 2. Gate A: decompose, but compose it differently from the offline rule

### What to keep and what to drop from the fan-out

Per `v5-fanout-2026-09-19/README.md` over 61 prompts, decisive answers (>0.85 or <0.15):

| question | decisive | decision |
|---|---|---|
| `forbids_delegation` (sharpened wording) | 42/61 | **keep**, veto |
| `answer_only` | 29/61 | **keep**, veto |
| `missing_reference` | 8/61, never below 0.52 | **keep**, veto — it maps to today's `needs_context` |
| `size` (score 0–4) | spans the range | **keep**, veto only at the low end (reply or one small edit) |
| `multiple_deliverables` | 17/61 | **drop** — it is not needed once depth decides; keeping it re-introduces "is this compound" |
| `mechanical` | 5/61, never above 0.53 | **drop** |
| `separable` | 0/61 | **drop** — a forecast, and it behaved like one |

Composition in code, no confidence floor, fixed thresholds declared before the run (reuse `FACT_TRUE = 0.6` from
`src/allocation.ts:197` for the vetoes; a `size` below 1.0 is a veto):

```
admit = depth ≥ floor
     && forbids_delegation < FACT_TRUE
     && answer_only        < FACT_TRUE
     && missing_reference  < FACT_TRUE
     && size ≥ 1.0
```

This is deliberately simpler than the validated offline rule (43/61), which used `T = size × 12` inside the saving
formula. The 18 the offline rule declined were 8 answer-only, 2 refusals and 8 too small — all three of those are
vetoes above, so the expectation is a similar count. That expectation is a prediction to be checked in step 3's offline
replay, not a result.

A `noul` question has no options, so the 11–18 % option-order sensitivity of the composite `choice` does not apply.

### Where it goes

- `src/admission.ts`: `ADMISSION_FACT_QUESTIONS` (three `noul` + one `score`), `buildAtomicAdmissionRequest`, and
  `decideAdmissionAtomic(answers, depth, floor)` returning the existing `AdmissionDecision` shape. Malformed or missing
  answers fall back to `direct`, as `decideWorkerRouteAtomic` does with `route_invalid`.
- `src/config.ts` / `src/types.ts`: `admissionQuestionShape: 'composite' | 'atomic'`, absent = composite, mirroring
  `routeQuestionShape` exactly (an explicit wrong value is an error, absence defaults).
- `src/hook.ts:403`: select the request builder and decider by shape. `admissionConfidenceFloor` is not consulted on the
  atomic path; document that beside the key, as `routeConfidenceFloor` already is for atomic Gate B.
- `scripts/`: promote `bench/results/v5-fanout-2026-09-19/fanout.mjs` and `validate.mjs` into a maintained replay
  script (there is precedent: `scripts/gate-a-calibration.mjs`) that runs the shipped decider against
  `prompt-context-depth.json` and the two ground-truth jobs, so the offline number is reproducible from `src/`.

### What must be true before the default flips to atomic

1. Step 1 shipped: depth is read in code, unknown means direct, and a host smoke shows `context_tokens` in the trace.
2. Offline replay of the shipped `decideAdmissionAtomic` against the 61 prompts and the two ground-truth jobs: the
   55K job must be refused **by the depth floor** (reason `depth_below_floor`, not a veto) and the 406K job admitted.
3. Step 2 shipped: the bench can present a job prompt at real depth, so a `jev_hierarchy` arm (real Gate A, not
   forced) can admit it.
4. End to end, two repetitions each: `jev_hierarchy` on the fresh case costs the same as `sonnet_native` within noise
   (the gate refused); `jev_hierarchy` on the primed loaded case costs no more than `jev_forced_orchestration` within
   noise and all checks pass. Until this row exists, every saving in this repository still rests on the forced arm.

## 3. Worker count: a ceiling as a backstop, and an honest reading of the three observations

The three worker-count observations are not the same mechanism, and Gate B is not the cause of any of them:

| observation | what actually moved the count |
|---|---|
| cache write became the largest term (1.07 M weighted) | delegation itself; each worker writes a ~45K prefix |
| `maxParallelWorkers` 1 → 4: workers 2 → 6, +32.7 % | the **coordinator** cut the work into more pieces when given slots |
| atomic Gate B, fresh job: workers 2 → 13, +92.5 % | the **planner** produced a different plan; the planner does not know Gate B exists, and one repetition cannot separate this from ordinary planning variance (`v5-atomic-gate-2026-09-19/README.md`, "Not settled") |

So the count is set by plan granularity and by coordinator subdivision, and the harm is first-order only at shallow
depth. At 406K, parallel 4 with six workers was still −75.8 % against native. Decision 1 removes the shallow case
before a planner ever runs, which is the largest lever on this axis. What remains is insurance:

- **Keep `maxParallelWorkers: 1`** as the default. Measured cheapest; the comment at `src/config.ts:18` is now backed by
  data rather than caution.
- **Add `maxTasksPerPlan`** (proposal: default 8, hard limit 16) enforced where the planner reply is parsed in
  `src/plan.ts`. A plan over the ceiling is an invalid plan with a fixed reason asking the planner to merge tasks by
  coherent outcome — the same path a plan with no required check already takes. The rejection costs a replan, which is
  bounded by `MAX_REPLANS`, so it cannot loop. State the ceiling in `agents/planner.md` next to "Size tasks by coherent
  outcome" so the backstop is rarely hit. `plan.ts:6` says bounds are bytes, not counts, on purpose; this changes that
  for one bound, and the reason is the three rows above.
- **Do not** build a depth-scaled prefix budget. The material shows the sign of the effect, not a curve to fit.

## 4. Order of work

Each step: what changes, what proves it, what would falsify it. Decisive cells run at **two repetitions**; the
2026-09-18 runs showed ±5 % between mechanically identical arms, so single-repetition deltas under ~10 % are noise.

### Step 1 — depth reader and floor

**Changes.** `src/depth.ts`; `transcript_path` kept in `parseInput` (`src/hook.ts:136`) and `HookInput`;
`delegationDepthFloor` in `src/config.ts` + `doctor`; `depth_unknown` / `depth_below_floor` preserve reasons;
`context_tokens` on the `admission_result` trace record; the check inserted before `callGate` in `handleUserPrompt`.
Tests: synthetic transcripts (sidechain lines ignored, usage further back than one chunk, truncated final line,
missing file, file over the read cap).

**Proves it.** (a) The reader, run over the same recorded sessions, reproduces the numbers in
`bench/results/v5-context-locality-2026-09-19/prompt-context-depth.json`. (b) A host smoke in a real session shows
`context_tokens` in the trace equal to the transcript's last usage. (c) Time: the read stays well inside the 5 s hook
budget on a 20 MB+ transcript; record the measured cost.

**Falsified by.** `transcript_path` absent on `UserPromptSubmit` in the current host build; the last usage line
regularly sitting beyond the read cap in real sessions (then unknown → direct fires too often and the floor admits
nothing, which the replay in (a) would show as a high unknown rate).

### Step 2 — a bench case that presents the job prompt at real depth

**Changes.** `src/bench/run.ts` gains a two-prompt case: a priming prompt that reads the reference files into the main
session, then the job prompt in the same session, so `UserPromptSubmit` for the job sees the primed depth. Add cases
at roughly 200K, 300K and 400K by priming with fewer or more files. This step is the pivot: without it the depth floor
can only ever see a fresh session in the bench, and "forced" stays the only evidence.

**Proves it.** The `context_tokens` trace field for the job prompt matches the intended depth. `sonnet_native` versus
`jev_forced_orchestration` on the primed 400K case reproduces the sign of the existing loaded result. The 200K and 300K
cells locate the crossing and set or move the `delegationDepthFloor` default.

**Falsified by.** Priming that does not land in the transcript before the job prompt; or a primed native cost far from
the in-turn loaded cost, which would mean the −57 % was about something other than depth.

### Step 3 — atomic Gate A, offline then end to end, then default

**Changes.** As in §2: questions, decider, `admissionQuestionShape`, the maintained replay script, hook wiring.

**Proves it.** Offline: admitted count on the 61 prompts with stated reasons for each decline; the two ground-truth jobs
decided the right way for the right reason. End to end (two repetitions each): `jev_hierarchy` fresh ≈ native;
`jev_hierarchy` primed-loaded ≤ forced within noise, all checks pass. Then the default flips.

**Falsified by.** The atomic gate admitting under half of the 61 (the vetoes are too broad); an admitted job costing
more than native at depth; a shallow job admitted for any reason other than a depth reading that was itself wrong.

### Step 4 — task-count ceiling

**Changes.** `maxTasksPerPlan` in config; enforcement in `src/plan.ts` reply parsing with a fixed rejection reason; the
ceiling stated in `agents/planner.md`.

**Proves it.** Forced arm, primed-loaded, two repetitions, ceiling on versus off: task count at or under the ceiling,
plan rejections zero or one, cost not above the no-ceiling arm, checks pass.

**Falsified by.** Repeated rejections exhausting `MAX_REPLANS` (job blocked), or merged tasks failing checks that the
finer plan passed.

### Step 5 — atomic Gate B by default, paired with admission at depth

**Changes.** `routeQuestionShape` default to `atomic` once step 3's default has flipped. The +92.5 % harm was on a
shallow job that decision 1 now refuses; the −50.5 % was at depth.

**Proves it.** `jev_hierarchy` primed-loaded, composite versus atomic B, two repetitions: atomic cheaper, checks pass,
`patched > 0` in the trace.

**Falsified by.** No re-routes at depth (the composite result repeating), or a re-routed worker failing a check the
sonnet worker passed.

## What this file does not settle

- The floor default is derived, not measured; step 2 measures it.
- The atomic Gate A composition here is a proposal whose offline count is predicted, not observed; step 3 observes it.
- Whether the 2 → 13 plan split was planner variance or something the atomic Gate B run changed is unexplained and
  stays unexplained until a repeated run with a fixed plan seed or repeated planning shows the spread.
- One operator's sessions. An operator who works in short fresh sessions sits below the floor on every prompt and gets
  native behaviour, which is the correct outcome for them and also means the plugin does nothing for them.
