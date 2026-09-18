# Handoff — jev-gate, 2026-09-18

Everything below is what was actually observed, with the file that proves it. This revision corrects overstated claims
from the original write-up (see "What the measurements say" and "Do this next") and describes the current design, which
other agents are actively changing; nothing below claims a new measurement was taken.

## Where the project stands

`main` is at **v0.2.0** ([release](https://github.com/MongLong0214/jev-gate/releases/tag/v0.2.0)). V5 is implemented and
verified on a real host. **No cost, runtime or quality benefit is established.** The one completed cell that ran was
under forced admission (no real Gate A judgment), and every worker dispatch in it landed on `standard`; why is not
settled. See "What the measurements say" below, and "Do this next" for the fix order — it is not #33's original order.

| Version | State |
| --- | --- |
| V3 | historical, negative result published (`bench/results/run-1-2026-09-17/`) |
| V4 | historical, negative result published: the coordinator never delegated; forced delegation cost 37.7 % more |
| V5 | shipped as v0.2.0; mechanism verified, product effect unknown |
| V6 (Codex adapter) | deferred, epic #32, no code |

## What V5 does

One request becomes a judged workflow. Jev is asked at every decision point because a judgment costs about $0.0001 and
returns in 0.6–0.9 s (measured).

```text
Gate A (UserPromptSubmit)  direct | orchestrated | needs_context | abstain
  orchestrated → planner (deep=opus, frontier=fable, read-only) returns tasks + interfaces + required checks
                 (optional per-task `spec`/`uncertainty` context — neither is required by the schema)
                 Sonnet coordinates behind an allow-list root guard and cannot implement the job itself
                 Gate B (PreToolUse:Agent)  fast | standard | deep | frontier, with an upgrade basis required above standard
                 acceptance: a deterministic check — does the reply report every required check as passed?
                 (no Gate C HTTP call in the normal path; historical `result_*` Gate C records are still read as history)
```

Acceptance is owned by that deterministic check, not by a Jev call: a task unlocks its dependents only when the worker
reports every required check as passed. A `worker_reported` accept is not independent proof the code works. Uncertainty
anywhere preserves the call that was already going to happen.

## Code map

Core is host-neutral by discipline (no vendor model names); the adapter is Claude Code specific. `AGENTS.md` has the full
table and the rules.

| File | What it owns |
| --- | --- |
| `src/admission.ts` | Gate A question and decision |
| `src/allocation.ts` | Gate B only (planner tier, worker tier + upgrade basis). The Gate C question, request builder and decision function are gone; `ResultVerdict` stays as the type of the `advisory` field on stored receipts |
| `src/plan.ts` | plan/reply JSON parsing, `contract_hash`, `[JEV_TASK …]` marker, contract composition, deterministic acceptance |
| `src/job.ts` | per-(session, prompt) state file, reservations, bounds, history |
| `src/coordinator.ts` | every fixed text: guidance, deny reasons, context messages |
| `src/hook.ts` | event dispatch; exit 0 always |
| `src/brief.ts` | eligibility, allow-list guard, input patching |
| `src/bench/*` | 7-arm runner, schema-5 records, report with declared-criteria verdicts |
| `agents/*.md` | six profiles: worker-fast/worker/worker-deep/worker-frontier, planner, planner-frontier |

`npm run typecheck && npm test && npm run build && npm run pack` is green (279 tests, 19 files), and
`claude plugin validate . --strict` passes.

## Host facts you can rely on (Claude Code 2.1.275/2.1.276)

Evidence: `bench/results/v5-host-2026-09-18/`, raw logs in `~/jev-gate-runs/v5-host-1/`.

- A PreToolUse patch that changes `subagent_type` **and** `model` together spawns the target profile with its own tools
  and permissions intact. haiku and fable children both ran and could still Edit and Bash.
- `prompt_id` is present on `UserPromptSubmit`, `PreToolUse`, `PostToolUse` and `Stop`.
- `effort` arrives as an **object** `{"level":"high"}`, not a string, and it is the **root's** effort on a root event.
- **haiku ignores the frontmatter `effort`** — the child gets no effort value at all. fable applies `xhigh`.
- `stream-json` shows the **pre-patch** Agent input and never echoes hook `additionalContext`, so a stream grep cannot
  verify composition or guidance; read the trace records instead.
- The guard denies a root `Bash` with the fixed reason; a child's own Bash is untouched.
- A session launched from inside Claude Code exports `CLAUDE_*`; the bench runner now strips them, and any effort
  measurement taken before `1680ac7` is invalid.

Unverified and worth doing: parallel dispatch (every planner we saw produced a serial chain; the default is now one
worker at a time and parallelism is not offered as a speed feature), real-Jev Gate B in a host smoke (that session's
admission returned `direct`; Gate C's HTTP call has since been removed from the normal path, so it is no longer part of
this to-do), a live root `Edit` denial and the terminal stop.

## What the measurements say

**Gate A calibration** (`bench/results/gate-a-calibration-2026-09-18.json`, 29 prompts, live Jev, $0.001): raw agreement
28/29. Compound development requests admitted at 0.81–0.96; ambiguous and contradictory prompts preserved. **Both pilot
jobs were chosen `orchestrated` but at 0.61 and 0.72**, below the 0.8 floor, so the product arm would run them direct.
The floor was deliberately not tuned on pilot data (ADR A10); a forced-orchestration diagnostic arm exists instead (A16).

**Whole-job comparison** (`bench/results/v5-run-1-partial-2026-09-18/`): one condition, stopped mid-execution for budget
— not a completed comparison. That arm forced orchestration (`JEV_GATE_EXPERIMENT_ADMISSION=orchestrated`), so **no
real Gate A judgment ran**; admission is recorded as forced, not decided. The completed part exercised the rest of the
mechanism on a real job — a plan, five worker dispatches (`t1`, `t2`, `t2` attempt 2, `t3`, `t4`), of which four have a
published completed result (`t4`/analyzer's does not), one reply judged invalid and reworked as `attempt=2`, three
advisory verdicts, all `accept` — and produced the finding that matters:

| Dispatch | Route | Confidence | Upgrade basis | Applied |
| --- | --- | ---: | --- | --- |
| t1 errors | standard | 0.96 | `no_specific_basis` | patch → standard |
| t2 formatter | standard | 0.41 | `no_specific_basis` | preserve |
| t2 attempt 2 | standard | 0.38 | `no_specific_basis` | preserve |
| t3 parser | standard | 0.94 | `no_specific_basis` | patch → standard |
| t4 analyzer | standard | 0.99 | `no_specific_basis` | patch → standard |

Every task went to the same tier (`standard`). `upgrade_basis` gates only `deep` and `frontier` in the shipped policy,
so `no_specific_basis` did not block `fast` — it does not explain why nothing went down. Why everything landed on
`standard` is open: the strong planner may already have resolved the design decisions that made `standard` appropriate,
or the router may have been missing information it needed; this one cell cannot separate the two. The one input gap it
actually confirms: `t2`'s own previous `invalid` verdict was not carried into its `attempt=2` dispatch. That verdict was
a report-format failure (`check_id` didn't match the required pattern), not a demonstrated implementation bug — whether
the first attempt's implementation was correct is unknown. The three Gate C `accept` verdicts are `worker_reported`, not
independent proof the code works.

## Do this next

#33's original proposal (a required uncertainty field so `fast` becomes reachable) is **not adopted** — `fast` was
already reachable under the shipped policy; `upgrade_basis` only gates `deep`/`frontier`. The fix order below replaces
it; #33's body still needs a follow-up edit to match, which is not done here (no remote issue edit without the owner
asking).

1. **State correctness in the plan/dispatch machinery.** A past `accept` must not paper over a failed or in-progress
   rework of the same task; a stale/superseded dispatch must not be treated as still valid without a confirmed
   terminal result; a changed plan revision must not reuse a prior completion computed under the old contract; the
   planner must not run twice concurrently in the same generation (single-flight); parallel-dispatch scope must
   compare normalized, alias-safe declared paths (`src/t1.ts` and `src/./t1.ts` are the same file), not raw strings.
2. **Bench observation and configuration accuracy.** Compare the actually-requested model against the actually-observed
   model directly, not as two independent "did it change" booleans that can both be true and hide a mismatch; treat a
   missing trace as unknown, not as zero cost or zero tokens; confirm the frozen config a benchmark plans against is the
   config the child process actually reads (the child's environment currently drops the path the plan read).
3. **Carry a task's own previous failure forward, and keep a report fix separate from a rework.** When a task is
   redispatched (for example after an `invalid` verdict), pass its own last verdict, failed/unrun checks and blockers
   into the next Gate B/worker input. Keep a report-format correction (wrong `check_id`, a missing field) on the
   existing bounded recovery path, distinct from a full implementation rework — a formatting fix should not escalate
   into a rewrite.
4. **Only then, a small approved comparison experiment.** `orchestrated_control`, `jev_forced_orchestration`,
   `frontier_native`, `sonnet_native` on `mini-sql` and `orbit-core`, one repetition; `frontier_orchestrated` is a
   comparison condition that uses the V5 guard and a separate planner — it is not the best unconstrained use of a
   frontier model, so don't read it as one. Criteria in #21 §5 are frozen; report the conclusion category even when
   negative. Close the unverified host items while sessions are running anyway: parallel dispatch, real-Jev Gate B, a
   live root `Edit` denial. **No paid experiment, release, tag, push or remote issue edit runs without the owner
   asking first.**

Commands for step 4, once approved:

```sh
npm ci && npm run build
export TYPESAFE_API_KEY="$(cat ~/.config/jev-gate/typesafe.key)"   # never echo it
node dist/bench/run.js --cases bench/v5/cases.json --out ~/jev-gate-runs/<new> \
  --execute --max-sessions 8 --arms orchestrated_control,jev_forced_orchestration,frontier_native,sonnet_native \
  --plugin-dir "$PWD" --timeout-ms 900000 --max-turns 45 --seed 20260918
node dist/bench/report.js --run ~/jev-gate-runs/<new>
node scripts/gate-a-calibration.mjs --set bench/v5/admission-set.json   # live Jev, ~$0.001
```

A Sonnet whole-job cell took 4–8 minutes of model time on these fixtures; the frontier arms are the expensive ones. The
host verification cost $2.84 in total.

## Rules that are not negotiable

- The TypeSafe key lives only in `~/.config/jev-gate/typesafe.key`. Never in git, an issue, a log or a chat message.
- Never tune a floor, a checker or a criterion after seeing results. If a checker is genuinely defective, document it,
  regrade every affected candidate, and keep both revisions (there is precedent in `bench/results/v4-run-1-2026-09-18/`).
- Drop an arm only with the reason recorded **before** the run (there is precedent in #29).
- Distinguish three different kinds of done: implemented, observed on a host, and measured as a product benefit.
- Negative results are deliverables. V3 and V4 both published theirs; do not quietly replace them.
- No release, npm publish, marketplace entry or marketing without the owner asking for it.
- No paid experiment, release, tag, push, or remote issue edit — including to #33 — without the owner asking first.

## Working conventions in this repo

Specifications live in GitHub issues, and the issue **body** is canonical — amendments were merged into the bodies, so a
ticket can be implemented without reading its comments. `main` is protected; work on `dev` and open a pull request.
