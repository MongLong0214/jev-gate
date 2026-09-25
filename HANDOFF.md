# Handoff — jev-gate, 2026-09-19

Everything below is what was actually observed, with the file that proves it. The 2026-09-18 revision corrected
overstated claims from the original write-up; this one adds the 2026-09-19 measurements, which override several
figures below and are marked where they do.

## 2026-09-25 — the standalone Router (#40–#43) is in `mods/router`; nothing is observed on a host

`mods/router` is a Function Hooks plugin, `jev-gate-router`, off by default. When enabled, it asks Jev once per root
turn about effort (and, if allowed, model), and once per inheriting built-in spawn about its model. Everything it
leaves native, and why, is in `mods/router/README.md`. The offline tests drive every path through the real modules
with fake HTTP, including `register.ts` with a fake `$`. The host's own kit only confirms the default is off, because
it cannot set plugin options. `pack --profile router` builds the archive, and `claude plugin validate --strict`
accepts it unpacked. No routed turn or spawn has been observed on an installed host, and no saving is claimed.
Composing it with Lean is #44 part B.

The first gpt-6-sol review of `a416a01` was FIX-FIRST with two blockers and seven other findings, all fixed with a test
each. A model suffix now counts only where the host lists it (`[1m]` on Opus 5.5 and Sonnet 5), and the bare and
`[1m]` forms are different identities. Pins are re-read at every step. An abandoned first step keeps the turn
native. An effort-only patch is observed too. Each spawn dispatch is assessed on its own. A question is not sent when
nothing it could answer would apply. Late replies are logged for their usage. And **every root model stays native**
until a `from → to` switch is verified on a host (`VERIFIED_ROOT_SWITCHES` is empty), because the hook cannot see
whether the retained request's controls remain valid on another model. So `routeMainModel` asks nothing today. #41
and #42 need that host observation.

The second review (`252f5b4`) was FIX-FIRST with one major and three minor findings, fixed with tests. Pins and the
allowlist are read again after Jev answers, so a spawn or a stored root override that no longer holds stays native.
A model override to a `[1m]` id stops unless the response reports that variant; whether the host ever reports it is
unobserved, so a routed `[1m]` switch may stop after its first step. A model question is offered only when some
effort it would be sent with pairs with the target. Routed results are logged (`root_result`, `spawn_result`) with
the reported model and the four token counts only.

The third review (`ebf709d`) found a pin could still land while the allowlist was read, and that an effort pin could
leave a stored model paired with an effort it cannot take. The pins are now read last, and a model override is
dropped when the effort actually sent does not pair with it.

The fourth review (`0979050`) found that a spawn could still be routed after its session ended, because its reads
ran outside the session link, and that an effort-only patch read a bare request answered with `[1m]` as a mismatch.
Every wait of a spawn now ends with its dispatch or the session it began in, and effort-only observation compares the
model in both directions.

The fifth review (`638d154`) found the session could still end in the last gap before `next`, for spawns and root
steps, and that the invalid-option diagnostic could keep `session.start` from being forwarded if logging threw. Both
handlers now check the session they began in (and the root turn's identity) with nothing awaited before `next`, and
every bookkeeping call in `register.ts` is guarded.

The sixth review (`009ab1d`) found that an unrouted spawn type, which is caller text, was logged by name, and that a
pending key read held an abandoned spawn and was read only after the optional reads. Unrouted types are logged as
`other`. The key is read first, once per session, and each caller waits on it only as long as its turn or dispatch.

The seventh review (`6810ead`) found the key wait delayed calls that could never be routed, and that a retired root
turn still waited on its pins and allowlist reads. Checks the event and configuration decide alone now come before the
key rather than after it, and every root read ends with its turn or dispatch.

## 2026-09-25 — the PR #37 review (L1–L7) is fixed in code; `lean` is still unmeasured

The consolidated review of `e444a4d` asked for seven changes before recommending `lean`. All seven are now in code
and offline tests (`eac9bb9`, `5ec0d05`). That makes the code and tests complete. It is not a new host observation,
and it is not a saving.

- **L1 privacy.** The request and every required group are screened before any request is built; a hit stays native
  (`mandatory_unsafe`). Optional credential-shaped groups are never exported and are counted as unassessed. The
  failure trace keeps a closed reason and a length, never the host's error text.
- **L2 / L4 source.** These are in the same commit's adapter changes. The following decline rather than guess: a
  corrupt complete record, invalid UTF-8, a mixed user envelope, unseen media, attachment or provenance types, and
  non-regular files. Calls and results pair by their real ids, whatever order they arrive in. Required references
  are resolved against the whole inventory before the optional cap.
- **L3 binding.** A packet binds to the request's prompt identity, its session and its canonical working tree. A
  later turn, another tree, or no cwd makes it `marker_stale`.
- **L5 one attempt.** Admission is compare-and-register under the job lock. A redelivered or concurrent hook
  process spends at most once (three packed processes → one fetch). A reservation that cannot be written is
  `reservation_failed`, never a bare marker passed through.
- **L6 accounting (#45 A).** Every charged producer reaches the final report once. Lean spend is joined per request
  over the union of intents and results. An intent with no result leaves the complete total unknown, but the known
  subtotal survives. Reports now say `accounting: 2`, and old lean blocks are read as revision 1.
- **L7.** The provider gets what is left of the 5 s hook timeout after a post-call reserve. With less than 250 ms
  left, nothing is sent and the trace says so. With no key, nothing is written. Withheld groups are reported by
  reason. The dispatch note is framed below the user's own words.
- **Scoped instructions.** The `handoff_scope` criteria distinguish four kinds of restriction: one on the current
  request, a session-wide one, a completed earlier task's local one, and quoted tool text.
  `tests/lean.test.ts` builds all four from a host-shaped transcript through the real adapter. The earlier claim that
  the depth fixtures carry a valid global ban was wrong. `bench/results/v5-lean-scope-probe-2026-09-25/` has the
  original text and a 15-call probe (≈ $0.0012). On that text Jev now leans `self_contained`, still below the
  floor.

A second review of `299855f` (gpt-6-sol, xhigh, read-only, verdict FIX-FIRST) found nine defects in that code.
Each was checked against the source before it was fixed:

- A credential behind `Authorization: Bearer` or `Basic`, or a bearer token with no conventional prefix, now screens.
- An older request delivered again after a newer one registered no longer spends a second time. The state keeps
  every admitted lean identity (`lean_seen`), and a request whose transcript already shows a later human turn is
  `source_changed` before any call.
- A failed executor call no longer releases ownership, interrupted or not (see the limits below).
- At the prompt, a transcript that ends inside a record still being written is `source_incomplete`. At dispatch the
  unfinished record is this turn's own output and is still left out.
- Required context that holds an image the packet cannot carry is `source_unsupported`.
- A preserved compaction list that repeats an identity is `source_lineage_unknown`.
- Reference resolution checks the source time bound per token.

A re-review of `b71d227` (gpt-6-sol, xhigh, read-only, verdict FIX-FIRST) confirmed six of those closed and one
rejection adequate, and found the rest incomplete:

- A literal header credential of any length now screens: `Authorization: Basic dTpw` is a whole credential, and the
  backtick form is covered. A name, a placeholder or a concatenation (`$TOKEN`, `${token}`, `<token>`, `'Bearer ' +
  token`) still does not.
- `lean_seen` evicted after 32 admissions, so an evicted request redelivered after compaction could spend again. It
  now never evicts: at 512 identities the session declines further lean requests (`lean_seen_full`).
- The reference time bound now reaches each text, each searched path run and each candidate, not only each token.
- The host A/B sentence now says the pair is consistent with the packet staying out of root context, which is all one
  unequal pair shows.

A third review, of `19284cc` (same settings, FIX-FIRST), found two more ways through, both confirmed:

- Header credentials in subscript, call, constant-template and literal-concatenation forms
  (`headers["Authorization"] = "Basic dTpw"`, `headers.set("Authorization", …)`, `` `Basic ${'dTpw'}` ``,
  `'Basic ' + 'dTpw'`) now screen, as do `btoa`/`Buffer.from` of a literal `user:password` and a password in a URL's
  userinfo. Names and placeholders still pass.
- The seven-day state cleanup deleted the lean ledger with the rest of an idle session's state, so a session resumed
  after a week could pay again for a redelivered old request. A state file that holds admitted lean identities is now
  never aged out.
- Reference extraction also reads the clock every 16 matches or runs inside a text, not only between texts.
- Bench: a lean record with no `request_id` is never paired by count. It is unknown and stays out of the known
  subtotal. A row's known subtotal keeps the known legacy spend when the legacy total is incomplete.

A fourth review, of `651556e` (same settings, FIX-FIRST), found four more, all confirmed:

- A header call wrapped across one line (`headers.set("Authorization",⏎ "Basic dTpw")`) and a percent-encoded URL
  password (`postgres://u:%40secret@host`) now screen. `%NAME%`, `%s` and `%(pw)s` are still placeholders.
- Cleanup read and deleted without the job lock, so it could unlink a file a writer had just replaced with a newly
  admitted lean identity, and it deleted files it could not read. It now removes a file only under that file's lock
  after a second look, never waits for a held lock, and leaves an unreadable file alone.
- An unreadable state file reached a writer as "no state", so a lean admission could write a fresh ledger over one
  that held identities. Lean admission now refuses an unreadable state (`lean_ledger_unknown`). An orchestration
  turn still recovers the file, and the state it writes carries `lean_seen_lost`, which keeps lean off in that
  session.
- Reference extraction also reads the clock before each of its six passes over a text. Within one pass the gap is a
  single linear regex scan, measured at 16 ms for an 8 MiB text with no match, the source cap. The scan is not
  chunked, because a quote-delimited match cannot be split at a safe offset.

A fifth review, of `5a23a6b` (same settings, FIX-FIRST), confirmed three of those closed and found two gaps in the
other two, both confirmed:

- The wrapped header allowed eight characters after the line break, indentation included, so ten spaces of ordinary
  call indentation missed. Whitespace no longer counts toward the eight punctuation characters. Each gap has its own
  bound of 64, on the header line and after one line break, which also covers column alignment
  (`proxy_set_header Authorization<20 spaces>"Basic …"`). The two classes are disjoint, so the repetition cannot
  backtrack. An 8 MiB input built to make it try took 32 ms.
- Cleanup's "cannot read" meant "not JSON", so an old file such as `{"version":5,"session_id":"s","current":{}}`,
  which `readJob` refuses, was deleted, and the next lean request in that session saw an empty ledger. Cleanup now
  requires the state `readJob` would accept for the session the file is named after.

A sixth review, of `4e6cc47` (same settings, FIX-FIRST), confirmed the header gap closed and found the cleanup copy
still short: it missed `readJob`'s size bound, so an old valid state over 1 MiB was deleted, and it read `lean_seen`
raw, so an entry lean ignores (`[null]`) kept a file forever. Both were confirmed. Cleanup now calls the same reader lean
uses instead of copying its checks, so a rule added there reaches cleanup too.

One finding was rejected: requiring a preserved list to be a parent chain, or to be in write order. Of 97 real
lists in local transcripts, 92 were not parent chains and 89 were not in write order. None repeated an identity. The
host relinks the list as written, so either check would decline valid sessions. Only the repeat check was added.

Tests: 724 across 28 files. That includes 83 hook, 68 adapter, 38 selection and 34 ingestion tests, all with fake
HTTP.

**Limits that ship with this, and are not bugs to fix quietly:**

- **Weak scope discrimination.** A ban lifts P(forbidden) from ≈ 0.01 to 0.34–0.60, but an explicit ban in the
  request itself scored no higher than a scoped or quoted one. It lost to `self_contained` once, at 0.36
  confidence. Lean honours explicit bans today because every such answer fell below the 0.8 action floor, with a
  highest observed confidence of 0.47. That is n = 3 per phrasing, so it is not a bound. Changing the criteria text
  to move these numbers is the tuning the 2026-09-21 report warned against.
- **A reservation leaked by another hook's denial cannot be seen.** If a different PreToolUse hook denies the
  executor call after this one reserved it, no failure event reaches this plugin. The reservation stays as an active
  executor, and lean is off for the rest of that session (`lean_executor_active`).
- **`async_launched` keeps ownership.** A background executor is never declared dead by a timer, so lean stays off
  for that session until a terminal result arrives.
- **A failed executor call keeps ownership.** `PostToolUseFailure` says the parent's call ended. It does not say
  whether a child started or stopped, so lean stays off for the rest of that session after any executor failure.
  Only a foreground `completed` result releases.
- **A long lean session stops admitting.** After 512 admitted lean requests in one session, every further one is
  `lean_seen_full` and runs natively. Forgetting an identity instead would let its redelivery be charged again.
- **A lean session's state file is kept indefinitely.** It holds the admitted identities that stop a replay, and a
  session can be resumed at any time, so the seven-day cleanup skips it. Deleting it by hand re-opens that replay.
  An unreadable state file is kept too: anything `readJob` refuses, whether for its structure or its size.
- **A session whose state could not be read stays native for lean.** Its identities are unknown, so a replay cannot
  be recognised. Lean declines (`lean_ledger_unknown`) for the rest of that session, even after an orchestration
  turn rewrites the file.
- **Prose about auth headers screens as a credential.** "Authorization: Bearer header" has a literal where the value
  goes, so that group is withheld or the source declines. A false positive costs coverage; a miss sends a credential.
- **A record still being written at the prompt declines.** If the host is mid-write when the prompt hook reads, that
  turn stays native (`source_incomplete`) rather than dropping a record it cannot see.
- **Router composition is not tested.** L1's re-screening at composition and L6's "Router + Lean without double
  counting" wait for #44 part B. The standalone Router (#40–#43) is in `mods/router`, and it leaves every spawn that
  carries a Lean marker native (`lean_marker`) until composition is built.
- **No 402 circuit breaker.** An exhausted TypeSafe balance surfaces as `http_other`, once per request, and lean
  falls back natively each time. A breaker belongs in the bounded direct adapter (#40), not in lean.

## 2026-09-21 — `lean` is implemented and unmeasured

A second mode landed on `dev`. It shares the dispatcher, the state file, the lock, the trace and the TypeSafe client
with everything below, and none of its decisions: no Gate A/B/C, no planner, no task graph, no tier routing, no depth
floor, no root guard, no plan interpretation. Everything below this section describes the **legacy** `native`/`auto`
routing modes and their experiments, which are unchanged.

What `lean` does: on an ordinary request, it reads the host's own transcript, groups it, asks Jev in one batched
request which complete prior interaction groups a fresh worker still needs, and — only when something is actually
omitted — recommends one `jev-gate:executor` with an opaque marker. If the root makes that call, PreToolUse replaces
that one prompt with the packet. The user's model, permissions and auto-compact are untouched.

Specification: current bodies of #21, #22, #33, #34, #35, #36, #29 (revision `jev-lean-handoff-v1.1`).

**What is established:** the offline path, through the real entrypoint and the packed hook command. 60 behaviour
tests in `tests/hook-lean.test.ts`, 24 adapter tests in `tests/lean-source.test.ts`, 22 selection tests in
`tests/lean.test.ts`, plus the lean bench arms and the packed lean profile, all with fake HTTP and temporary
transcripts. The packed-entrypoint test earned its keep immediately: `dist/hook.js` was not passing `process.argv`
into `runHook`, so `--lean` never reached the profile check and only the in-process tests could see the mismatch
path at all.

**What live execution then established (2026-09-21, ~$7.2 of an authorized $25):**

- The installed host does what the design assumed: `model: inherit` resolves to the root's own
  `claude-sonnet-5`, the worker starts in a fresh context rather than a fork, project `CLAUDE.md` reaches it, the
  9280-byte packet arrives intact, and a marker with no packet produces `handoff_unavailable` with no tool call and
  no file. A controlled A/B settled the economically important one: an 8737-byte difference in the worker's prompt
  moved root context by 318 tokens, **consistent with the packet not being charged to the root's context window**.
  `bench/results/v5-lean-host-2026-09-21/`. *(Scoped 2026-09-25: these ran on the deterministic `recent_packet` path
  with no Jev key, so they say nothing about selection. The echo A/B is one pair on host 2.1.278 with unequal starting
  context, 45,792 against 47,560, and different replies. It is consistent with the packet not reaching root context;
  it is not a wire guarantee.)*
- **Two defects that no offline test could have caught**, because every offline test answers 200 from a double.
  Requests were bounded by bytes when the provider bounds tokens, and the first token estimate was calibrated on
  prose when real transcript content bills 1.7 bytes per token. Until both were fixed, every realistic session
  400'd and the feature could not fire at all outside a test.
- **The depth fixtures cannot measure this feature.** Their priming turn ends "이 읽기는 네가 직접 해라.
  서브에이전트나 다른 워커에게 넘기지 마라", so `handoff_scope: forbidden` is the correct answer and `jev_lean`
  can never dispatch in them. A measurement needs new cases that build removable history without prohibiting
  delegation. `bench/results/v5-lean-measure-2026-09-21/`. *(Corrected 2026-09-25: the ban names the earlier
  reading, so `forbidden` is arguable, not correct, and "never" was by ambiguity, not construction. See the section
  above.)*

**What is not:**

- **Host observation is n=1 per question.** One host version, one model alias, one call shape. The executor's tool
  list is its own self-report and disagrees with its frontmatter, unexplained. Root compliance was seen as ignore
  once and comply once under an explicit instruction; that is not a compliance rate.
- **No efficacy measurement.** Three runs were started and all three were stopped without a result; the first two
  on the defects above, the third because the fixture forbids delegation. No token, cost, quality or time figure
  for `lean` exists. A smaller packet is a byte diagnostic, not a saving.
- **Policy constants are uncalibrated.** Action confidence `.8` and omission confidence `.9` are the initial v1.1
  values, not measured accuracies.

An exact reference in the request or in an active human turn — a backticked span, a quoted string, a path — that
resolves to **exactly one** candidate group makes that whole group mandatory, so it cannot be omitted and
`handoff_scope` may rely on it. Two matches is ambiguous and one match of nothing is dangling; neither is guessed at,
and a dangling essential referent is caught by `handoff_scope`, which sees only the request and the mandatory layer.

Source adapter notes worth keeping: the active history after a compaction is the host's own
`compactMetadata.preservedSegment` — and `headUuid` sits *before* the `compact_boundary` record in the file, because
partial compaction retains earlier records, so "every line after the boundary" would have been wrong. A `tool_result`
arrives inside a `type: "user"` event and is never treated as a human instruction. A packet is bound to the records
*before* the current request, so this turn's own assistant/tool appends do not invalidate it while a new human turn,
a compaction or a rewritten prefix does.

## Where the project stands

`main` is at **v0.2.0** ([release](https://github.com/MongLong0214/jev-gate/releases/tag/v0.2.0)); `dev` carries
everything below and is what a new agent should check out.

> **Read this first (2026-09-20).** Two things changed after everything below was written.
>
> 1. **Every cost percentage in this document is withdrawn or under caveat.** The depth ladder that was built to
>    establish the crossing re-measured the same depths under a pre-registration written before its cells existed.
>    Across four runs and six comparisons **not one reproduced**, and the deepest rung reversed sign on a separation:
>    −56.6 % against native became +67.2 % against the single arm on a repeat. The `−59 % to −69 %` row below comes
>    from the run those rungs re-measured. See `bench/results/v5-depth-ladder-2026-09-19/RESULTS-WORK-RERUN-2026-09-20.md`
>    and the withdrawal banner on `bench/results/v5-crossing-2026-09-19/README.md`. The floor stays at 300,000 for
>    compatibility; the economic certainty it was given does not.
> 2. **Six dispatch-integrity defects were found and repaired** (`1adc9a1` and the commit that follows it). A failed
>    rework was reviving the accept it replaced; a preserved single dispatch was sending a worker off without the
>    user's request; the single path ran none of the conflict checks the hierarchy re-runs under the lock and never
>    re-confirmed ownership after its Jev call; `size: 999` admitted; the trace recorded the questions and not the
>    answers; and Gate A2 was choosing the planning tier from the coordinator's brief instead of the request. Twelve
>    witnesses, all failing before and passing after: `bench/results/v5-dispatch-integrity-2026-09-20/WITNESSES.md`.
> 3. **The gate can now say what it did.** `node dist/cli.js explain <trace-dir>` renders the records the hook was
>    already writing: why a turn stayed native and at what confidence, the tier each dispatch was routed to, the model
>    asked for against the one the host resolved, and the worker-reported verdict. Nothing about the pipeline changed;
>    reading it no longer means opening benchmark JSON by hand (`fbf0b59`).
> 4. **Four facts the gate now reads and acts on none of.** An external review named four Jev sites; all four are
>    implemented and every one carries `applied: false`. The worker route gate now gets the request itself, not only
>    the coordinator's brief (`08fe8fb`). Gate A records what the request said about shape. A rework records what the
>    earlier attempt reported was wrong with it. And `planInterpretation` (off by default) compares each constraint a
>    candidate plan wrote down against the request before the plan is adopted, per clause — the one place a plan that
>    answers a different question than you asked is still visible, since the contract, the checks and the receipt are
>    all derived from it afterwards. **None of the four rejects, vetoes or upgrades anything.** The same review said
>    the evidence does not establish that these classifiers beat the coordinator, and nothing here claims otherwise.

**On `wide-validators`, the product works in its shipped configuration and saves tokens without costing time.** With
`mode: auto` and no config file, Gate A reads how deep the session is, asks its read-off questions, and admits real
work at depth. Measured end to end, same finished work, all checks passing. **Every row below is one job shape —
`wide-validators` — and the second job shape measured did not reproduce it.** Read them as that job's numbers, not
as the product's:

| measured on `wide-validators` | |
|---|---|
| job turn at ~376K, against no plugin | ~~**−59 % to −69 %**~~ **withdrawn 2026-09-20** — the ladder that re-measured these depths reproduced none of its six comparisons |
| session total at ~376K | **−31.8 %** |
| wall clock, admitted path | **+3.6 %** — inside the baseline's own spread |

Below the floor the gate refuses with **zero requests and zero workers**, which is gate behaviour rather than a
property of any job.

**The saving is conditional on the shape of the job, and that is a property, not a defect.** `wide-validators` is
twelve disjoint modules taking the same edit: every plan of it is `chain_depth 1`, nothing is shared, and delegation
buys twelve parallel units for nothing. `orbit-core` is one artifact cut five ways over a shared specification:
`chain_depth 3`, two of five tasks strictly serial, and in the one clean cell — nothing broken, all 16 checks passing
— the orchestrated arm made **49 file reads against native's 6** and ran the test suite **15 times against native's
1**. Duplication scales with coupling; the saving scales with independence. **No percentage is quoted for that job:
its pre-registration forbids a cost comparison from that run, and the counts above are mechanism, not cost.** What
those counts cost is the thing a new pre-registered run has to measure. Evidence and its limits (n = 2 job shapes,
single cells):
`bench/results/v5-replan-bound-2026-09-19/DIAGNOSIS.md`. **Gate A cannot see this** — it reads the prompt and decides
compound vs direct, and both jobs are compound. The discriminator (`chain_depth`, task file overlap) exists only
after the planner replies — and the planner is about a fifth of the orchestrated arm's own spend ($2.4654 of
$19.8628 across the three `v5-replan-bound` cells, a within-arm split). Buying the plan, measuring its shape and
declining to execute it is an unmeasured design option, not a result.

**What is not established.** Every figure in the table above is `wide-validators`. **A second job, `orbit-core`, was
run on 2026-09-19 and did not reproduce the saving — it could not be measured there at all, because the orchestrated
arm finished the job in only one of its two cells** (`bench/results/v5-job2-orbit-2026-09-19/`). Plan size varies freely
(2 to 12 tasks for the same request) and it is what sets the size of the saving, so this bench resolves ~10 % at
constant plan size and ~47 % otherwise — **quote nothing under 15 % from it**. Gate B's atomic shape has one
end-to-end observation and stays off. Nothing here makes work finish *faster* than doing it directly; parity is the
best case.

**2026-09-19, later the same day: the mechanism behind the saving has a name, and it is not "orchestration".** Eight
cells, two jobs, one build, all eight passing their checker
(`bench/results/v5-single-vs-native-2026-09-19/`): an admitted turn dispatched **whole into one fresh worker, with no
planner, no plan and no contract**, cost **−71.0 %** against no plugin on `wide-validators` and **−20.4 %** on
`orbit-core` — the second of those smaller than either arm's own cell-to-cell spread, so `wide` carries it and
`orbit` only agrees with it.

What collapses is **root turns taken at depth** — 42/43 → 11 on wide, 27/22 → 13/17 on orbit — not tool calls: Bash
counts match, and on `wide` all four cells made the same 11 writes and 13 edits. A turn taken in a ~390K session is
the expensive thing; a fresh worker taking it instead is what this product sells. **It is paid for in wall clock:
the single-worker shape was slower on every cell of both jobs, about 40–48 % on the means.**

This also narrows what the `−59 % to −69 %` row above is evidence for. That row is `hierarchy` on one job, and the
split between "moved to a fresh context" and "split into tasks" was confounded in it. The move alone now has its own
two-job number; **the split has no isolated number at all** — stage 1 put all three arms on one build and rule 3
withheld the cost comparison because the arms' pass counts differed
(`bench/results/v5-context-vs-decomposition-s1-2026-09-19/`).

**Quality, all cells this repository has recorded:** `jev_single` 6/6, `sonnet_native` 6/6, `jev_hierarchy` 4/6 —
its two failures being a plan that froze what the request left open (and reported `completed` over it) and a cell
that spent a whole job turn repairing a plan and dispatched no worker at all. Whether that should change the shipped
default is written up as a recommendation for the owner in `DECISION-admitted-shape-2026-09-19.md`; **the default is
unchanged** (`admittedShape: hierarchy`).

**2026-09-19, that evening: the saving is not confined to the depths the product will act at.** A three-rung depth
ladder — one fixture, one byte-identical request, three priming lengths — was pre-registered and run
(`bench/results/v5-depth-ladder-2026-09-19/`). At **193K context, below the shipped `delegationDepthFloor` of
300,000**, `jev_single` came in **41.8 % cheaper** on the job turn than `sonnet_native`, with the native arm's own
two cells 0.6 % apart. Smaller than the 71.0 % at ~390K and clearly not gone. The floor's 300,000 was derived from
**hierarchy** numbers, where this same fixture measured −10.5 % at ~180K, so the floor does not describe the shape
now proposed as the default. **The floor is unchanged at 300,000** — one rung is not what a floor moves on, and it
is a decision about which errors to prefer against the real-prompt depth distribution.

That run is **incomplete and says so**: the account hit its session limit partway through, which killed the 30-note
rung entirely and one cell of the 21-note rung, so only one rung carries a quotable number. It also found a defect,
now fixed in `f2b3256`: on the contractless `single` path the worker names its own checks, and a name with a space
in it was discarding the entire reply — 86.6 seconds and 43 tool calls thrown away and re-dispatched. The same cell
showed the `single` path counting dispatch attempts without ever reading the bound it counted toward; it now reads
the per-job task bound that already existed.

**2026-09-20: the two missing rungs were re-run whole and both separated — 285K −43.1 %, 389K −56.6 %**
(`RESULTS-RERUN-2026-09-20.md`; 8 cells, 8 checker passes, no invalid cell). Wall clock was uniformly worse for
`single`, +55.0 % and +54.1 %.

**Then the 13-note rung was re-run to close a build gap, and it reversed.** Byte-identical inputs — same
`request_sha256`, same both `prime_sha256`, same `fixture_sha256` — and `jev_single` came back **72.5 % more
expensive** than native, against −41.8 % the day before. The arms did not change: same turn counts, same output
tokens, all four checkers passing. **The metric moved.** Summed from the stream, both arms did the same work on
both days — at 193K the native arm read 9.97M cached tokens against `single`'s 8.96M in run 1 and 9.35M against
8.40M in run 3, i.e. **`single` 10.1 % less in both, identical to the decimal**. What changed is the fraction of
that traffic the host reported: ~62 % of the native arm's cache reads on 09-19, 15–17 % on 09-20, with `single`
at 16–37 % throughout. Reported cost follows the report. **Why the attribution changed is not established** and
is not guessed here.

**2026-09-20, run 4: the ladder is withdrawn whole** (`RESULTS-WORK-RERUN-2026-09-20.md`). The 285K and 389K
rungs were re-run under a new pre-registration (`PREREGISTRATION-WORK-2026-09-20.md`, `d5eae34`) with the work
unit promoted to co-primary **before** the cells ran. Reproduction was defined in advance as verdict class and
direction both matching. **Two rungs × three units = six comparisons, zero reproductions.**

| depth | dollars, first measurement → repeat | cache reads, first → repeat |
|---|---|---|
| 193K | −41.8 % → **+72.5 % against `single`** (identical inputs) | 10.1 % less → 10.1 % less |
| 285K | −43.1 % SEPARATION → −46.4 % **direction only** (single spread 62.3 %) | 12.4 % **more** → 10.5 % **less** |
| 389K | −56.6 % SEPARATION → **+67.2 % against `single`, SEPARATION** | 27.1 % less → 15.5 % less, direction only |

**No percentage from this ladder is quotable.** 8/8 cells passed their checkers and `jev_single` was admitted
2/2 at both rungs, so the withdrawal is about the measurement, not the work.

**And the regime is not a day, it is a session.** Inside run 4 the two rungs sat in different attribution bands
an hour apart: 21-note native at 60–62 % host/stream billed $1.88–2.08 on 13.7–15.8M cache reads, while 30-note
native at 17–20 % billed $0.89–0.94 on 19.2–20.4M. **More work, half the money, same run.** That is the whole
30-note reversal, and it removes "it was a different day" as an explanation.

The `single` arm is also far noisier than native — 95.1 % cache-read spread at 285K against native's 14.8 %.
Run 2 caught it tight (2.1 % dollar spread at 389K) and that was luck. **Two repetitions cannot clear this arm's
own variance**, which is what rule 5 exists to stop us ignoring.

Older reading, left for the record:

The work column is post-hoc re-analysis and replaces no rule (rule 11 bars swapping a unit after results); it is
published because refusing to compute it would hide what the same cells say. In work terms the shape's advantage
is small at 193K, **absent at 285K**, and about half the advertised size at 389K.

**The two-repetition design does not detect this.** Both runs were internally tight (0.6 % and 8.4 % native
spread) while the between-run gap was 3×. Rule 5 tests a difference against an arm's own *within-run* spread, and
that spread badly understates what varies. **Every job-turn dollar figure in this bench measures the host's
attribution on the day it ran, and only this rung has ever been repeated on a different day.** Treat older
figures accordingly.

**Both defects are fixed** (`146d295`, `METRIC-DEFECT-2026-09-20.md`). `apply-rules.cjs` compares magnitude and
names direction — verified to move no number over all three runs. The runner now records `turn_totals_stream`
beside `turn_totals_usd`: per turn, cumulative, the summed cache reads, cache writes, input, output and message
count over every message including subagents. `stream-usage.cjs` does the same for runs already on disk.
Gates: typecheck 0, build 0, vitest **548**.

The floor stays at 300,000 and no default follows. The case for a flip is weaker than it was that morning, and
run 4 weakened it further: **no measurement in this repository now establishes that the `single` shape saves
money at any depth.** What still stands is the quality record (every `jev_single` cell of four runs passed its
checker), Gate A's refusal below the floor, and the fact that the 300,000 floor was derived from `hierarchy`
measurements and has never described this shape.

Ladder spend, cumulative: **$87.83** (run 4 was $29.64 against ≈ $25 quoted and a $13–$33 corrected estimate).

Read the 2026-09-19 section of "What the measurements say" before trusting any older number in this file.

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

On `dev` at the commit that removed the search filter: `npm run typecheck && npm test && npm run build && npm run pack`
are green (503 tests, 25 files) and `claude plugin validate . --strict` passes. `npm run build` does not clean `dist/`,
so remove it by hand after deleting a module or the stale `.js` still packs.

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
| **Plan size is a free variable.** Same job, six repetitions, nothing changed: 4, 2, 2, 3, 2, 3 tasks. Bench precision is ~10 % at constant plan size and ~47 % otherwise | `v5-plan-variance-2026-09-19/` |
| **`agent_calls` counts the planner too.** Earlier "13 workers" and "4 workers" were 12 and 3 workers plus the planner | same |
| **Atomic Gate A is implemented and does not admit on `missing_reference`.** That question reads median 0.77 on real prompts — a constant, not a signal — and was dropped on a criterion fixed before the variants were measured. Shipped composition admits 41/65 | `v5-gate-a-atomic-2026-09-19/` |
| **A task ceiling of 10 ships** as a backstop against a runaway split. It has never fired in a run | `7de339b` |
| **The second job does not reproduce the saving, and the run cannot say by how much.** `orbit-core` at the same depth, two repetitions: `sonnet_native` passed 2/2, `jev_hierarchy` passed **1/2**. Pre-registration rule 3 gates cost on quality, so **no cost comparison is reported** and no percentage from that run may be quoted. The runner's own verdict is `pass_not_below: not_met`, Δ success −50.0 pts, overall "mechanism only" | `v5-job2-orbit-2026-09-19/` |
| **A failure mode `wide-validators` never exposed: plan-validation churn.** In the failing cell the coordinator spent the entire job turn on five planner dispatches and **zero workers** — two invalid replies, one failed replan, a 4-task plan accepted and never acted on, turn ended `incomplete` with the fixture byte-identical to its start. 26 turns of a 120-turn budget, so nothing was truncated, and the guard denied nothing (18 `Read` records, all `allow: true`) | same |
| **That failure costs full price.** $3.5165 against the succeeding cell's $3.6644 — 96 % of the cost for none of the work. Within-arm job-turn spread is 4.2 %, so cost cannot distinguish the two cells; only the checker can | same |
| **Gate A was correct on this job too**, all three prompts in both cells: priming `depth_unknown` with no request, confirmation `admission_answer_only`, job **`orchestrated`, decided: true** at 388,294/388,391. Entry judgement is not what failed | same |
| **Two defects in that failing cell were found offline and fixed, neither measured.** (1) The tier-name guard split on every non-alphanumeric run, so `deep-copy` named the deep tier and rejected the plan whole — a four-task plan covering all seven modules died on the constraint "serialize must deep-copy so later mutation ...", which appears in no later revision. (2) A replan was dispatched with the coordinator's 771-character brief and nothing else: not the request, not the revision it was revising | `be679ab`, `r-tiersite` |

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

### 2026-09-21 — the gate orchestrates, and what stopped it is now known

`bench/results/v5-live-admission-2026-09-21/` (`9d1639b`) closes the question that sat above everything else. One
session shows all three outcomes in order: no transcript yet on the first turn, so `depth_unknown`; 211,957 on the
second, so `depth_below_floor`; 448,908 on the third, which sent the run's only admission request and got
`orchestrated` back at confidence 0.95, then ran a deep planner and two accepted workers to `Stop: completed`. $3.46,
six minutes. For that session the other three candidates are ruled out: the key answered, the profile was foreground,
and Gate A never said direct because it was never asked until the depth passed.

Two conditions came with it. **A fresh session is always direct on its first prompt**, since the transcript the reader
measures does not exist yet. And **a 200K-context root cannot reach the operating region at all** — the diagnostic
needed `--model sonnet[1m]`, which is a requirement rather than a preference while the floor is 300,000.

The fleet answer is different from the session answer, and both are true. `scripts/fleet-gate-status.mjs` (repaired in
the same commit: it hard-coded `~/projects/jev-gate` and crashed when no job state existed) reports `mode=off`, no key
in the environment and the plugin not installed. The fleet's 45,309 above-floor turns with zero orchestrations are
therefore explained before the floor is consulted at all.

**The decision this leaves is the owner's, and it should be made before the next spend.** While the floor is 300,000,
this product only exists for 1M-context sessions that have already grown past a third of their window, with the plugin
installed and a key exported. Either that is the intended audience and the README should say so plainly, or the floor
needs re-deriving against what sessions actually reach — and the crossing measurement that set it at 300,000 is one of
the figures the depth ladder withdrew. Do not move the floor to make a number look better; declare the change and the
reason first, as the non-negotiable rules below require.

### 2026-09-19 — everything in the previous order is now done or settled

| was | outcome |
|---|---|
| Control worker count | **Measured.** Plan size is a free variable (4, 2, 2, 3, 2, 3 for the same job). Bench precision is ~10 % at constant plan size, ~47 % otherwise. `v5-plan-variance-2026-09-19/` |
| Get Gate A to admit end to end | **Done, and it now ships.** `admissionQuestionShape` defaults to `atomic`; the composite question admitted 0 of 61 offline. `v5-gate-a-live-2026-09-19/`, `DECISION-defaults-2026-09-19.md` |
| Measure the crossing point | **Done.** Between 180K and 281K. The floor stays at 300,000 because lowering it admits 11 % more prompts in exactly the band the bench cannot resolve. `v5-crossing-2026-09-19/` |
| The speed axis | **Settled.** Parity when admitted (+3.6 %, inside the baseline spread). Slower only with many workers, which the task ceiling bounds. `v5-speed-2026-09-19/` |

**What is left, in the order it is worth doing:**

1. **Why the planner fails on `orbit-core`, and how often.** The second job was run (`v5-job2-orbit-2026-09-19/`)
   and the answer it returned is that the orchestrated path does not reliably finish this shape of work: one cell in
   two dispatched no workers at all. Until that is understood, the saving cannot be measured on this job, and a third
   job would only add another unexplained cell. **This is now the largest gap.** The one observation does not separate
   module count, the 4,676-character spec, the contract-composition rules, and ordinary planner variance; start by
   replaying the failing cell's request against the planner offline, which costs a planner call rather than a cell.
2. **Make comparisons immune to plan size**, by comparing cells of equal plan size or by fixing a plan and replaying
   it. Without this the bench stays at ~47 % resolution whenever plan size is free.
3. **Gate B's atomic shape**, which has one observation (−50.5 % deep, +92.5 % shallow) and needs a two-repetition
   result at depth before its default moves.
4. **Parallelism**, only if speed becomes the goal. `maxParallelWorkers: 1 → 4` measured +32.7 % in cost, but that
   observation is confounded with plan size 2 → 6. Hold plan size fixed and vary only the cap.

Do not prime a session inside `jev_forced_orchestration`: it orchestrates its own priming turn, and that produced two
different failures today.

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

## Closed track: the search-result context filter (2026-09-18 → 2026-09-21, withdrawn)

**Closed. The code was removed on this commit** (`src/context/`, `tests/context-*.test.ts`, the `^Grep$` and
`SessionStart` hook registrations, the `context` mode and its codes). The hook was never wired, so nothing in a real
session ever reached it and no stored record carries a `context_intent` / `context_result` phase.

The idea was to let Jev judge which blocks of a long `Grep` result are relevant and deliver only the selected
**original** text, keeping the user's own coding model. Two measurements closed it:

- **It would never fire.** `bench/results/v5-context-viability-2026-09-18` §0: across 20,080 session transcripts on
  disk, 120,756 tool calls contain **no `Grep` at all** — bypass-permissions mode routes search through `Bash`, which
  is 91.2 % of calls. Searching still happens (37,462 Bash searches, 25.5 MB), but **98.3 % of those results are below
  the 8 KiB floor**, p99 4,641 B.
- **Granting it everything caps the benefit at about four tokens per session.** Hook moved to `Bash`, parser taught
  `grep -n`, scope gate settled: **0.25–0.34 MB across 19,590 sessions**. §1–§5 of that README measured the gates on a
  corpus built by emulating `Grep`, before the real sessions were read; their numbers stand and their conclusion does
  not — the gates were never the binding constraint.

Two host facts from the probe are worth keeping whatever happens to this idea, and both are evidence for the routing
work as well:

- **The host caps what the model receives at 20,000 characters — characters, not bytes** (bisected in
  `bench/results/v5-context-cap-2026-09-18`, 35 cells, $4.5851). 20,000 is delivered whole; 20,001 comes back as a
  ~2 KB preview plus a saved-output path, with nothing in `tool_response` saying so. A Korean cell of 19,974
  characters and 51,894 bytes was delivered whole, which a byte cap cannot do. **The bytes a hook sees are not the
  bytes the model would have received.**
- **`PostToolUse.hookSpecificOutput.updatedToolOutput` really replaces what the model receives**, and a malformed
  replacement is silently ignored with no error reaching the model or the hook — so a rejected replacement is
  indistinguishable from an applied one from inside the hook.

Full evidence, including the recorded `Grep` payload shapes, the `additionalContext` behaviour, the archive-permission
findings and what stayed unknown: `bench/results/v5-context-probe-2026-09-18/`, `v5-context-cap-2026-09-18/`,
`v5-context-viability-2026-09-18/`, `v5-context-locality-2026-09-19/`. The owner's specification
(`jev-context-filter-mvp-r1`) and the unsettled `OMIT_CONFIDENCE_FLOOR` decision described in the viability README are
where to start if this is ever revived; reviving it means writing the code again, on purpose, against a measurement
that says it is worth it.

## Rules that are not negotiable

- The TypeSafe key lives only in `~/.config/jev-gate/typesafe.key`. Never in git, an issue, a log or a chat message.
- Never tune a floor, a checker or a criterion after seeing results. If a checker is genuinely defective, document it,
  regrade every affected candidate, and keep both revisions (there is precedent in `bench/results/v4-run-1-2026-09-18/`).
- Drop an arm only with the reason recorded **before** the run (there is precedent in #29).
- Distinguish three different kinds of done: implemented, observed on a host, and measured as a product benefit.
- Negative results are deliverables. V3 and V4 both published theirs; do not quietly replace them.
- No release, npm publish, marketplace entry or marketing without the owner asking for it.
- No paid experiment, release, tag, push, or remote issue edit — including to #33 — without the owner asking first.
- If the withdrawn search filter is ever revived: never claim a byte saving measured against what the hook saw. The
  host caps large results before the model sees them — at 20,000 characters, measured — so the only honest baseline is
  what the host would have delivered. Above the cap the host already spends its ~2 KB whatever the filter does.

## Working conventions in this repo

Specifications live in GitHub issues, and the issue **body** is canonical — amendments were merged into the bodies, so a
ticket can be implemented without reading its comments. `main` is protected; work on `dev` and open a pull request.
