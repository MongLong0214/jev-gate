# Handoff — jev-gate, 2026-09-19

Everything below is what was actually observed, with the file that proves it. The 2026-09-18 revision corrected
overstated claims from the original write-up; this one adds the 2026-09-19 measurements, which override several
figures below and are marked where they do.

## Where the project stands

`main` is at **v0.2.0** ([release](https://github.com/MongLong0214/jev-gate/releases/tag/v0.2.0)); `dev` carries
everything below and is what a new agent should check out.

**A cost benefit is established, and in the one condition measured it is no longer slower.** Gate A now admits a job
on its own — the first time in this repository — and on that path the job turn costs **−64.2 %** against native, the
session **−31.8 %**, at **+3.8 %** wall, two repetitions, all checks passing
(`bench/results/v5-gate-a-live-2026-09-19/`). Below the floor the gate refuses exactly, sending **no request at all**,
but whether that refusal is free is **unmeasured**: the shallow case's native arm varies 26.9 % between its own two
cells.

Two things stay true and bound every number here. The largest uncontrolled variable is **worker count**, which has
moved this job's cost by a factor of 2.4 (counts seen: 13, 4, 4, 3, 3). And everything rests on **one case at two
depths**.

Read the 2026-09-19 section of "What the measurements say" before trusting any older number in this file.

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

On `dev` at `24e9853`: `npm run typecheck && npm test && npm run build && npm run pack` are green (354 tests, 20 files)
and `claude plugin validate . --strict` passes.

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

### 2026-09-19 — what changed, and what it overrides

| | |
|---|---|
| **Depth decides.** Forced orchestration measured +182 % on a fresh session (~55K) and −57 % on a loaded one (~406K) | `v5-context-locality-2026-09-19/` |
| **Depth is now read in code, never asked of Jev.** The hook reads the session transcript at `UserPromptSubmit`; below `delegationDepthFloor` (300,000) no Gate A request is sent at all. Reproduces the replay's number 11/11 at EOF and 44/44 at real prompt positions, worst read 0.7 ms | `v5-depth-reader-2026-09-19/` |
| **The bench can now present a job prompt at real depth.** Two host facts had to be found first: `--no-session-persistence` writes no transcript, and closing stdin with every prompt in it merges them into the running turn | `v5-depth-primed-2026-09-19/` |
| **At real depth: job turn −53.5 %, session −23.8 %, wall +47.8 %**, two repetitions, four valid cells, all checks passing | `v5-depth-primed-2026-09-19/` |
| **Worker count dominates.** The same job at the same depth cost $3.0022 with 13 workers and $1.2338–$1.2766 with 4. The spread is larger than the effect | same |
| **Gate A admits on its own.** `jev_hierarchy` + `admissionQuestionShape: atomic`: job turn **−64.2 %**, session **−31.8 %**, wall **+3.8 %** against native, two repetitions, all passing. The priming prompt costs nothing (`depth_unknown`, no request); the confirmation turn is refused on its own content | `v5-gate-a-live-2026-09-19/` |
| **Below the floor it refuses exactly** — every prompt `depth_below_floor`/`depth_unknown`, `attempted: false`, zero requests and zero workers — **but the cost of refusing is undecidable**: native varies 26.9 % between its own cells there | same |
| **The 13-note case sits at 179–181K.** First point toward measuring the crossing that `delegationDepthFloor` guesses at | same |
| **Atomic Gate A is implemented and does not admit on `missing_reference`.** That question reads median 0.77 on real prompts — a constant, not a signal — and was dropped on a criterion fixed before the variants were measured. Shipped composition admits 41/65 | `v5-gate-a-atomic-2026-09-19/` |
| **A task ceiling of 10 ships** as a backstop against a runaway split. It has never fired in a run | `7de339b` |

Both question shapes still default to `composite`, and `maxParallelWorkers` is still 1.


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

### 2026-09-19 — the order that supersedes everything in this section

The approved experiment below **has been run**, several times over, and the 2026-09-19 section of "What the
measurements say" is its outcome. What is worth doing next, in order:

1. **Control worker count.** It moved the same job's cost by a factor of 2.4 on the same case at the same depth, which
   is more than the effect any of these runs is trying to measure. Until a run repeats planning, or fixes a plan and
   replays it, a single cell's cost is as much a statement about planner variance as about the gate. Everything below
   this line is worth less until this is done.
2. ~~**Get Gate A to admit a job end to end.**~~ **Done** (`v5-gate-a-live-2026-09-19/`). What remains from it: the
   default still does not flip, because the shallow half is undecidable on a bench whose native arm varies 26.9 %
   there. Either raise repetitions in that condition or find a case whose native arm is stabler.
3. **Measure the crossing point.** `bench/cases-depth.json` has 13-note and 21-note cases that have never been run, so
   the `delegationDepthFloor` default of 300,000 is derived from two points rather than measured.
4. **The speed axis has no plan.** Wall time is worse in every condition measured so far (+196 %, +47.8 %), because
   `maxParallelWorkers` is 1 and workers run in series — and raising it measured +32.7 % in cost. Nothing here yet
   turns the second of the owner's two axes in the right direction.

Do not flip either question shape to `atomic` by default before (1) and (2). Do not raise `maxParallelWorkers`.

### The previous revision's order, kept for context

Steps 1 to 3 of the previous revision are **done** and are on `dev` at `24e9853` (state correctness, bench observation
and configuration accuracy, a task's own failure carried into its next dispatch with a report fix kept separate from a
rework). `npm run typecheck`, `npm test` (354 tests, 20 files), `npm run build`, `npm run pack` and
`claude plugin validate . --strict` all pass on that commit. Nothing about cost, quality or speed is measured.

The next task is the small comparison experiment, and **the owner has approved it**. It spends real subscription and
TypeSafe budget, so run it once, run it to completion, and do not expand it.

### The approved experiment

One job, run to a finished result, three conditions, one repetition:

| Arm | What it isolates |
| --- | --- |
| `sonnet_native` | the job without this product at all |
| `orchestrated_control` | the same planner, guard and worker roles, no Jev |
| `jev_forced_orchestration` | the same structure plus Jev allocation, with admission forced so the boundary exists |

```sh
npm ci && npm run build
export TYPESAFE_API_KEY="$(cat ~/.config/jev-gate/typesafe.key)"   # never echo or log it
node dist/bench/run.js --cases bench/v5/cases.mini-sql.json --out ~/jev-gate-runs/v5-run-2 \
  --execute --max-sessions 3 \
  --arms sonnet_native,orchestrated_control,jev_forced_orchestration \
  --plugin-dir "$PWD" --timeout-ms 900000 --max-turns 45 --seed 20260918
node dist/bench/report.js --run ~/jev-gate-runs/v5-run-2
```

Expect roughly 20 to 35 minutes and 5 to 12 API-equivalent dollars: a Sonnet whole-job cell ran 4 to 8 minutes of model
time on these fixtures, and the orchestrated arms pay for a planner plus per-task context. Watch the log rather than
polling, and if a cell dies in under a minute, read its `cell.json` and `stream.jsonl` before relaunching — that is how
the three-denial guard budget and the inherited-environment defects were both found.

**Rules for this run, all of them already agreed:**

- This build has no Gate C call and defaults to one worker. It is a different policy from the partial run of
  2026-09-18, so publish it as its own run; never merge the two into one table.
- `jev_forced_orchestration` is a diagnostic: admission is forced, so it says nothing about the natural entry judgment.
  The product arm `jev_hierarchy` is not in this run, and its numbers must not be filled in from `sonnet_native`.
- `frontier_native` and `frontier_orchestrated` are not in this run, so make no claim against a frontier coordinator.
- The criteria in [#21](https://github.com/MongLong0214/jev-gate/issues/21) §5 are frozen. Report the conclusion
  category from that list even when it is negative, and do not adjust a floor, a checker or a criterion afterwards.
- Preserve failures, cancellations, timeouts and unknowns. Whole-job cost includes the planner, the coordinator, every
  worker, any rework and the actual Jev calls; child token totals are not whole-job cost and include cache entries.
- One repetition is a pilot observation. Equal pass counts are not quality equivalence.

Read the result against the document's decision table: if the no-Jev orchestration is cheaper with no quality gain from
Jev, the added value is not established in this workload; if both orchestrated arms lose to plain Sonnet, the structure
itself is the thing to cut; if orchestration wins but Jev makes little difference, report the planner as the part that
worked and say Jev's contribution separately.

### While those sessions are running

Close the host items that need a live session anyway and cost almost nothing extra: parallel dispatch (the default cap
is now 1, so raise it deliberately for one check), a real-Jev Gate B observation, and a live root `Edit` denial.

### Afterwards

Three follow-ups are known and none of them is urgent: the influence counter reads only the nested `changed_default` and
has no flat fallback; cross-generation writers are not checked for deliverable overlap; declared paths are not
case-folded and symlinks are not resolved, so a normalized path is a planner's claim and not write isolation.
[#33](https://github.com/MongLong0214/jev-gate/issues/33) still describes the superseded required-uncertainty plan and
needs its body corrected to match this revision, which is a remote edit and therefore needs the owner to ask.

## Second track: the search-result context filter (started 2026-09-18, in progress)

A separate feature from the routing work, specified in `jev-context-filter-mvp-r1` (the owner's document, kept locally at
`~/Downloads/jev-gate-context-filter-agent-handoff.md` — read it in full before continuing). The idea: keep the user's
own coding model, and before a long `Grep` result reaches it, let Jev judge which result blocks are relevant and have the
code deliver only the selected **original** text. No model routing, no planner, no guard, no V5 job state.

### The probe answered the question the feature depends on: yes

`bench/results/v5-context-probe-2026-09-18/` holds thirteen recorded headless sessions on Claude Code 2.1.276 ($1.58,
about three minutes of model time). The decisive results, each with evidence in that directory:

- **`PostToolUse.hookSpecificOutput.updatedToolOutput` really replaces what the model receives**, and the original is
  not also delivered. A hook that kept 2 of 5 markers produced a 506-character `tool_result` where the original was
  1298; the model listed exactly those two markers.
- **A malformed replacement is silently ignored** and the original survives, with no error reaching the model or the
  hook. A rejected replacement is therefore indistinguishable from an applied one from inside the hook, which is why the
  observation states `replacement_emitted` and `host_applied` separately and never infers one from the other.
- **`additionalContext` is additive, never a substitute**, and it appears in no log, no transcript and no
  `PostToolBatch` payload. Its tokens are real but unmeasurable after the fact, so count the disclosure from the string
  the hook emitted.
- **Grep's `tool_response` is three different shapes, not one with optional fields**, keyed by `output_mode`. In content
  mode `numFiles` is always `0` and `filenames` always `[]`; `numLines` counts rendered ripgrep output lines including
  context and `--` separators, not matches and not files. Fixtures for all three modes plus a truncated result are saved
  beside the README.
- **Two truncations exist and only one is visible.** `head_limit` shows up as `appliedLimit`/`totalLines`, but the host
  also caps the result the model receives: a call carrying 27,391 characters into the hook was delivered to the model as
  a 2 KB preview plus a saved-output path, with nothing in `tool_response` saying so. **The bytes a hook sees are not
  the bytes the model would have received.** The window where filtering can save anything runs from the 8 KiB floor up
  to that cap; above it a filter that fires makes things worse unless it beats the 2 KB preview.

  **That cap is now bisected** (`bench/results/v5-context-cap-2026-09-18`, 35 cells, $4.5851): it is **20,000
  characters**, and it counts *characters, not bytes*. 20,000 is delivered whole, 20,001 comes back as a preview. A
  Korean cell of 19,974 characters and **51,894 bytes** was delivered whole in the same run, which a byte cap cannot do.
  "26.8KB" was the size of that one output, not the threshold — the host reports what it measured, never the limit it
  applied, so reading it as the threshold would have set the ceiling 6 KB too high. `MAX_CONTENT_CHARS` carries it, and
  it is deliberately in different units from `MIN_CONTENT_BYTES`: on CJK source a result can be three times the byte
  size and still be inside what the host would have delivered, and a byte ceiling would switch the filter off exactly
  there. A nearer ceiling binds first on ordinary results — `head_limit` defaults to **250 lines**, so a result with
  ordinary line lengths tops out near 21 KB before the character cap can matter.
- **The recovery archive is readable by the native `Read`, but only under a narrow grant.** `--allowedTools` alone,
  `Read(...)` rules inside it, and `--add-dir` all failed, including for an ordinary directory under `$HOME`; a
  `--settings` file with `permissions.additionalDirectories: ["~/.local/state/jev-gate/context"]` (or an equivalent
  `permissions.allow` entry) worked. A user launching with a restricted `--allowedTools` cannot recover, and the plugin
  cannot detect that in advance. Also: a recovery notice written as "read this path and report field X" got refused by
  the model as an exfiltration probe, so the disclosure must stay a plain factual sentence.
- **`PostToolBatch`** fires once per call after `PostToolUse`, nests everything under `tool_calls[]`, and carries
  `tool_response` as the **rendered string**. It is a useful read-only check of what the model actually received and it
  must never be fed to the Grep response parser.
- `effort` is an object here too, confirming the V5 defect; `--no-session-persistence` leaves `transcript_path`
  populated but never creates the file, so transcript-based evidence needs that flag dropped.

Two more host facts to keep: `--setting-sources project,local` **silently discards** a `--settings` file, which is why
several recovery attempts looked like permission failures when the settings were never loaded at all; and the fixtures
preserve the invariant `numLines === content.split('\n').length`, so a parser can rely on it.

Still unknown and listed in that README: interactive TUI behaviour, whether a subagent's Grep reaches a root hook,
whether a replacement that itself exceeds the cap is persisted, `appliedOffset` (no probe used `offset > 0`), and paths
with colons or non-ASCII characters against a real host. Seventeen sessions were launched and thirteen recorded; four
superseded runs were overwritten, so their cost is unknown rather than zero. The exact size cap was on that list and is
now measured; the preview's own size rule (the notice says "first 2KB", and the capped cells rendered 2,115–2,117 bytes
in ASCII against 5,338 in Korean) was not separated from the notice text and remains unknown.

### What exists in code

`src/context/{blocks,purpose,select,archive,render,store}.ts` (about 880 lines) plus edits to `src/{config,types,trace}.ts`
and the tests `tests/context-{blocks,purpose,select,fixtures,archive}.test.ts`. A `context` mode is added to `Mode` so
that `off`, `native` and `auto` keep their exact current behaviour and `context` runs only this filter. `npm run
typecheck`, `npm test` and `npm run build` are all clean at **449 tests across 25 files**, but that is the core in
isolation: the hook is not wired yet, so nothing in a real session reaches this code path.

An earlier revision of this section claimed "typecheck passes, 397 tests across 22 files" for `a9d1c88`. That was not
true of the commit it was written on: `a9d1c88` added `tests/context-select.test.ts` and left `tsc` with two errors and
one failing test, both introduced by that file. Both are fixed below. Check the three gates against the commit in hand
rather than against this file.

The probe wrote only `bench/results/v5-context-probe-2026-09-18/`; every change under `src/`, `hooks/` and `tests/` in
that commit came from the core work, not from the probe.

### Pick it up here

1. ~~**Confirm the adapter against the probe's fixtures.**~~ **Done.** The parse assumptions in `src/context/blocks.ts`
   are replaced by the three recorded shapes, and native truncation is now detected as
   `appliedLimit !== undefined || appliedOffset !== undefined || totalLines > numLines`. This was not cosmetic: run
   against the recorded payloads, the guessed shape **accepted `grep-truncated.json` and would have rewritten a result
   the host had already cut**. Its detectors (`truncated`/`hasMore`/`nextOffset` on the response, `head_limit`/`offset`
   read off `tool_input`) appear on no real payload; they are kept as defence in depth behind the confirmed keys, for a
   host that does use those names. `renderGrepResponse` now regenerates `totalLines` with `numLines`, so a filtered
   result does not itself read as natively truncated. `tests/context-fixtures.test.ts` runs the adapter against the
   four recorded payloads directly, so the fixtures — not a hand-written idea of them — are what the parser answers to.
2. **Finish the offline tests** listed in the document's §12 that are reachable without a host. Most were already
   covered; the audit against that list left one real gap, now closed: `src/context/archive.ts` had **no tests at all**,
   so "archive failure or cap producing no omission" was unverified (`tests/context-archive.test.ts`, 8 tests). The
   remaining §12 items — colons in paths, Korean text, CRLF, identical text at different locations, protected files,
   short/count/files-only/truncated/error pass-through, one request with scope plus per-block questions, low confidence
   and ties and malformed answers, malformed scope, single-attempt HTTP preserving known usage — are covered in
   `tests/context-{blocks,select,purpose}.test.ts`; re-check them against that list rather than trusting this sentence.

   Mutation-check anything added here. Removing the `totalLines > numLines` guard left the whole suite green, because
   every test that reached it asserted only `ok: false` while the confirmed truncated fixture is caught one check
   earlier by `appliedLimit`. A guard whose reason code is the point needs a test that asserts the reason code.
3. ~~**Wire the hook.**~~ **Do not — measured 2026-09-18, `bench/results/v5-context-viability-2026-09-18` §0.**
   On this machine the `^Grep$` matcher would fire **zero times**. Across 20,080 session transcripts already on disk,
   120,756 tool calls contain **no `Grep` at all**: bypass-permissions mode tells the session to search through `Bash`
   instead, and 91.2 % of calls are `Bash`. Searching still happens — 37,462 Bash searches, 25.5 MB — but **98.3 % of
   those results are below the 8 KiB floor**, whose p99 is 4,641 B. Granting the feature everything it asks for (hook
   moved to `Bash`, parser taught `grep -n`, scope gate settled) caps the total benefit at **0.25–0.34 MB across 19,590
   sessions — about four tokens per session.**

   §1–§5 of that README measured the gates before the real sessions were read, on a corpus built by emulating `Grep`.
   Their numbers stand and their conclusion does not: the gates were never the binding constraint.

   The upside is real and sits behind one decision. Held against the same 95-block result, the scope question answers
   `keep_all` at **0.99** when the user's request is exhaustive and `selectable` at **0.13** when it is not — so the
   protection `OMIT_CONFIDENCE_FLOOR` exists to give is already coming from `keep_all` itself, while the floor discards
   a **40–54 %** byte reduction that the block-level answers would have delivered. **That floor is a declared criterion
   and this repository does not move one after seeing results: it is the owner's call, not the next agent's.**

   Two things to settle with it, both in that README: the 250-line `head_limit` truncation removes **88 %** of broad
   searches, which are exactly the ones a relevance filter suits; and Jev agrees with itself on only **67–89 %** of
   block classifications across identical requests, so if the floor moves, the same search filters differently between
   runs. Today the floor hides that.

   When it is time, the wiring itself is unchanged: a `PostToolUse` matcher of exactly `^Grep$` — do not widen the
   existing `^Agent$` — plus the `SessionStart` and `UserPromptSubmit` events the purpose record needs. The context path
   must branch before any V5 routing logic, and a child caller (`agent_id` present) must pass through untouched.

   The cheapest thing still unmeasured is free: the eligibility scan emulates the host's `Grep` rather than observing
   it. A passive `PostToolUse` recorder on real sessions — the one in
   `bench/results/v5-context-cap-2026-09-18/cells/probe-plugin` does exactly this and emits nothing back to the host —
   would give the real distribution, including how often the model sets `head_limit` itself.
4. **Then the three-condition comparison** in §11 (`native_output`, `deterministic_output`, `jev_output`), which needs
   the owner's approval because it spends real budget. Measure against what the host *would have delivered*, not against
   the bytes the hook saw — the cap above makes that distinction the difference between a real number and a fabricated
   one.

   Budget the cells, not just the run. The cap bisect cost $4.5851 for 35 cells against an estimate of $0.20–0.50,
   because the estimate counted the search payload and the money is in booting a session: a representative cell reports
   `input_tokens: 4, output_tokens: 107` beside `cache_creation_input_tokens: 42036`. One session per measurement is
   clean and roughly $0.13 a time whatever it measures; where per-cell payloads are small, batch the sweep into one
   session and buy independence with a fresh working directory per call instead.

## Rules that are not negotiable

- The TypeSafe key lives only in `~/.config/jev-gate/typesafe.key`. Never in git, an issue, a log or a chat message.
- Never tune a floor, a checker or a criterion after seeing results. If a checker is genuinely defective, document it,
  regrade every affected candidate, and keep both revisions (there is precedent in `bench/results/v4-run-1-2026-09-18/`).
- Drop an arm only with the reason recorded **before** the run (there is precedent in #29).
- Distinguish three different kinds of done: implemented, observed on a host, and measured as a product benefit.
- Negative results are deliverables. V3 and V4 both published theirs; do not quietly replace them.
- No release, npm publish, marketplace entry or marketing without the owner asking for it.
- No paid experiment, release, tag, push, or remote issue edit — including to #33 — without the owner asking first.
- For the context filter: never claim a byte saving measured against what the hook saw. The host caps large results
  before the model sees them — at 20,000 characters, measured — so the only honest baseline is what the host would have
  delivered. Above the cap the host already spends its ~2 KB whatever the filter does.

## Working conventions in this repo

Specifications live in GitHub issues, and the issue **body** is canonical — amendments were merged into the bodies, so a
ticket can be implemented without reading its comments. `main` is protected; work on `dev` and open a pull request.
