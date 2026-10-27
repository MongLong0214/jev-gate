# Changelog

## v0.8.65 — 2026-10-27 — Reconcile delayed Claude response evidence

- Reconcile late Claude Router effort and cache TTL evidence after the Function Hook returns, matching only a unique request within the completed response window. Update the original record without repeating the model request or double counting; absent or ambiguous evidence stays unknown (#385).

## v0.8.64 — 2026-10-27 — Terra routing and Claude observation fixes

- Add account-listed `gpt-6.1-terra` to standard Codex routing with the efforts advertised by that account. Verify native low/medium/high/xhigh/max/ultra and API none/low/medium/high/xhigh/max; ultra remains a native host control. Defaults and pins remain authoritative.
- Add verified Terra API prices, Codex credit rates and input capacity to existing cost guards and official-model synchronization. No savings claim is established by model support.
- Wait up to 1.5 seconds for Claude's queued transcript flush, within a 2-second helper deadline, to link observed Router effort and cache TTL to the exact response (#385). Missing, ambiguous or later evidence remains unknown; no model request is repeated.
- Record only closed validation reasons and counts for rejected Compact selections in classic and Function Hooks paths (#386). Keep usage and conservative local restore/digest fallback; historical rejected provider responses cannot be reconstructed from these new diagnostics.

## v0.8.63 — 2026-10-23 — Preserve Codex contracts and distinguish hook connection failures

- Routed Codex execution establishes the original public signatures, input types and invariants before editing. Missing or buried requirements are recovered through native tools; a smoke test or tests matching an invented interface do not establish contract compliance. The native input, tools, permissions and opaque history remain unchanged. This addresses the contract drift observed in #381 without disabling Luna or changing Claude routing.
- Codex hook transport failures are separate lifecycle incidents, with their recorded connection reason, event and tool. They remain visible for review without counting as worker calls or replacing the latest worker status. Doctor uses the same closed reason codes; these records do not prove a native tool failure, worker failure or hook exit code (#382).
- The dashboard decision basis reserves a stable multiline reason area and gives the full human reason in its title instead of an internal `ok` code. No ellipsis hides model/effort reasons (#383).
- The frozen, repeated OAuth contract diagnostic retains every OFF/before/after cell and its quality and consumption, including failures; see `bench/results/codex-router-contract-2026-10-23`. This known regression fixture is not a representative savings benchmark.
- Claude policies and native compaction settings are unchanged. Published, installed and measured behavior remain separate verification results; no universal token or subscription allowance saving is claimed.

## v0.8.62 — 2026-10-23 — Worker reports that acceptance can read, and a live README dashboard

- Worker instructions (`agents/worker*.md`) and the Gate worker prompt now require each `check_id` copied character for character from its Bash call, with no `cd`, assignment or `export` prefix, and explanations in `note`. Over the previous 24 h no Gate worker result was accepted: two reported passes were unobserved because workers reported shortened names (`node m1.mjs fail`) instead of the command they ran.
- `blockers` now lists only what kept the outcome from completing or being checked, and any blocker means `blocked`; a worked-around limit or a fact outside the outcome goes in `summary`. Two results had been marked incomplete for `done` with such notes. Acceptance rules and the transcript verifier are unchanged; the effect on acceptance has not been measured yet.
- The README dashboard preview is a recording of the real page fed a minute of synthetic Jev calls and a new call every 150–450 ms (`assets/readme/dashboard*.webp`, about 1.3 MB each), with a still frame under `prefers-reduced-motion`. `scripts/readme-dashboard.mjs` needs `img2webp` and `cwebp` from libwebp. The results chart animates its bars and changes, also off under reduced motion.
- `scripts/build-codex.mjs` no longer rewrites an unchanged `plugins/codex/hooks/hooks.json`, which truncated the file under a parallel test's read.

## v0.8.61 — 2026-10-23 — Rebuild the dashboard layout and cut its live-update cost

- Rebuild the dashboard to the approved layout: a KPI row, a Jev call scatter (one dot per call, height = response time) with a 60-minute band and the last recorded round trip replayed on a Gate⇄Jev track, a stage strip for Gate A, Gate B, workers, Router and Compact, 24-hour status per feature, the call log with its decision basis, and the run list with a run trace view (timeline and stage detail). Korean/English and light/dark switching stay; the palette is neutral with a blue accent and prefers locally installed Geist/Inter (no font is downloaded). `src/dashboard-circuit.ts` is removed and the README previews are regenerated.
- Values stay recorded facts: an absent value shows "–", recorded text is written as text, and the page CSP is unchanged.
- Live frames no longer carry the server's recent feed (the page derives it from runs) or each step's `callId` (server-side pairing; `/api/step` still returns it). Live updates are coalesced to at most four a second (previously every 16 ms). A rebuild finds the next age edge from new records alone while the earliest known edge is still ahead, and the activity thread caps its young generation at 32 MB.
- The page redraws time labels once a second and slides the dot layer with one transform in between, does nothing in a hidden tab and draws the newest frame when it is shown, drops dots due to leave the window within a second, steps its blink animations, and switches event highlights without color transitions.
- Measured once each on a replay of a real 38.7k-file (29.6 MB) Claude and Codex history: at 2 new records/s, bytes streamed per 60 s fell from 10.24 MB to 1.22 MB, server process CPU from 12.0% to 10.9% of one core and peak RSS from 481 MB to 370 MB; headless Chrome (all processes) used 11.3% instead of 20.5% while streaming and 4.3% instead of 13.1% idle. These are display costs, not token savings.
- Display only. Gate, Router, Compact, Codex and recording behavior are unchanged.

## v0.8.60 — 2026-10-23 — Diagnose the installed Codex hook bootstrap correctly

- Compare installed Codex hook commands against the actual command captured when the package is built, instead of the obsolete direct-file invocation. Check PreCompact and PostCompact as well as the other nine events, including exact native timeouts. Changed commands, matchers, duplicate/missing handlers and invalid timeouts still fail (#373).
- This repairs a Doctor package false failure; it does not reclassify missing runtime routing records or incomplete usage, and it does not change hook execution, Router, Compact, Claude behavior or native settings.

## v0.8.59 — 2026-10-23 — Preserve Codex prefixes and account for Compact reuse costs

- Append routed execution guidance after the original input, preserving native instructions, tools and every original history item. The hint stays request-local; it is not persisted history or proof of a cache hit (#362).
- Compare a whole Compact edit with the last complete observed request. Count a potentially rebuilt prefix once and include replacement overhead. Preserve known matching prefixes before paid assessment: a real synthetic check reduced raw tokens but increased credit estimates, so a favorable serialized-size estimate alone no longer authorizes a warm edit. Unknown residency stays unknown; no future-turn horizon or API cache-write premium is invented for OAuth (#363).
- Protect the full parallel batch containing the latest six results and unresolved calls. Fix an applied context's selection boundary, prefer later candidates, and keep native originals authoritative across new tasks and compaction (#364).
- Retire Router/Compact comparison state on account or native-context changes; keep submission identities through both transformations. Native memory extraction, prewarm and unknown internal operations pass through without being misattributed to root inference (#366).
- Record bounded scalar change estimates, context epochs and linked request receipts separately from observed usage. Observe a closed projection of server diagnostics without injecting unverified OAuth fields, logging content digests or retrying inference (#367).
- Verify the Codex 0.163.0 public effort-update and AKV support boundaries with disposable native/fake-server contracts. Native effort history remains native-owned; no experimental feature, trusted update, drop/repos API, provider or backend is enabled. These are completed support investigations, not shipped AKV or automatic append-only effort routing (#365, #369).
- Publish all twelve held-out four-condition cells, including a timeout and regressions. Representative coding raw usage was 6.69% lower with Router and 14.92% lower with both enabled; including synthetic stress it was 0.09% and 4.71% lower. Compact applied zero changes, so its causal benefit and combined interaction remain unmeasured. These single runs do not establish 40%/50% or included-plan allowance savings; earlier results remain separate (`bench/results/codex-cache-2026-10-23`, #368).
- Preserve all separate functional safety attempts: an unsafe pre-final warm edit lowered raw tokens but raised credit estimates, motivating the final guard. A separate no-comparison synthetic check on the final guard applied twice, preserved original/recent facts, and observed 34,252→25,518 raw tokens (25.50% lower). This is not representative coding or actual allowance evidence.
- Claude behavior is unchanged. Common version and archive metadata advance under the existing release contract; delivery targets Codex.

## v0.8.58 — 2026-10-23 — Offer a handoff to a long direct turn

- Gate A cannot tell a long task from its text before work starts. A root turn Gate A left direct that has already made as many requests as the delegation cost model needs at its context depth (about 9–19) is now told so once, before its next tool call, with what a worker brief must carry; nothing is blocked and the root decides. Real-host A/B on a 10-stage task at ~135K context (6 pairs, preregistered): the note appeared in 6/6 cells at request 9, quality 6/6 vs 6/6, cost cheaper in 5/6 pairs, median ratio 0.634. Ordinary turns below the break-even see nothing (#356).

## v0.8.57 — 2026-10-23 — Compact keeps older user-role text cut instead of handing the compaction to the engine

- When the previous summary, earlier user-role messages and failed calls did not all fit beside the tail, Compact handed the whole compaction to the engine (`mandatory_overflow`), 28 of 122 auto compactions in a week. They now share 70% of the digest's room newest first: whole while they fit, then cut to their first 520 and last 260 characters around "[…]", then left out, counted on one line. On those 28, the digest keeps 0.727 of the referents the next steps used against 0.570 for the engine's summary with its attachments; every compaction that fitted builds the same digest as before (#361).

## v0.8.56 — 2026-10-23 — Label an unasked child's first step correctly

- Router recorded the first step of a child whose spawn it did not ask Jev about (a skipped spawn, or a named Fable child) as `answer_invalid`, shown on the dashboard as an invalid assessment. The kept effort was right; it is now recorded as `not_asked` (#359).

## v0.8.55 — 2026-10-22 — Run a Fable subagent the call names

- Router no longer replaces a restricted model that an Agent call names (`model: "fable"`) without the Fable opt-in. It ran such a child on Opus and the root, unaware, reported a Fable review (#357). A named restricted model is now a manual selection, as on the root: it runs as named, without a Jev call. Inherited, default and automatic Fable children stay restricted.

## v0.8.54 — 2026-10-22 — Reduce repeated Codex execution rounds

- Preserve known native tool failures in continuation routing and distinguish explicit status from completion-only evidence. Judge effort against the actual account-listed candidate and its validated default (#300).
- Add execution guidance when Router changes a full-context model/effort pair: batch independent reads, reuse current context, coordinate related edits and observe every required check. Dependencies stay sequential. Bind submission accounting before guidance and independent Compact processing; pins, incremental requests and native compaction retain their original path.
- In a complete three-episode, five-turn actual OAuth/Jev development comparison, Codex raw usage was 1,413,312 OFF versus 1,117,885 ON (20.90% lower), with all 18 quality check groups passing. One episode increased 4.76%; the reused development corpus does not establish a universal saving or actual included-plan allowance reduction. External Jev usage is recorded separately. The user accepted this observed result for the current iteration; the earlier 40% goal was not achieved.
- Close the current Compact delivery scope (#317) with its published implementation, installed automatic-hook/native-compaction checks and bounded effect measurements. Router's 20.90% is not a Compact result. Preserve the Compact no-application coding comparison and limitations on representative long-work savings.
- Claude implementation is unchanged. Common version and archive metadata advance under the existing release contract; this delivery installs Codex only.

## v0.8.53 — 2026-10-22 — Route well-specified work to Sonnet by outcome

- Correct the Router's routine/complex boundary from measured outcomes. Jev sent six checker-backed coding jobs to Opus as complex because of their topic (concurrency, a format migration, compatibility, an algorithm), although each spelled out its cause or required behaviour and had checks. Sonnet 5.5 passed every checker run of the five that Opus passed, at 49–56% of Opus's notional cost (the sixth failed the same check on both). Routine now covers that work; complex keeps an uncertain cause, constraints the request leaves open, live client or data compatibility, permission or money logic, open algorithm design and reviews (`bench/results/tier-outcome-2026-10-22`, #352).
- With `jev-1.14.0` the jobs now route to Sonnet (13/13 with variants); a fresh held-out set of 12 requests and 6 injection probes was 18/18 exact; the frozen test split was 83/84 with no under-route (old rubric the same day: 82/84); dev 82/84 with no under-route. The golden spawn split gains the five outcome-labelled jobs.
- Step a retried spawn up instead of repeating the cheaper model (#353). When a child the Router lowered has ended and the parent spawns the same agent type with a prompt sharing at least 60% of its words, the new spawn runs at least one role above the lowered model (`retry_step_up`, `retry_of`), up to its native or declared model. Children still running are parallel work and stay lowered.
- Codex shares the rubric; its routine/complex models were not outcome-tested. No live saving is claimed until the installed trace is measured.

## v0.8.52 — 2026-10-22 — Assess old Codex evidence with separate OAuth accounting

- Let confirmed ChatGPT OAuth traffic use Compact's existing bounded Jev assessment budget for older unique tool evidence (#317). The previous preflight added external Jev raw tokens one-for-one to OpenAI tokens and excluded those candidates before assessment. API and unknown traffic retain the conservative combined-token preflight. Decisions are isolated by billing family; recent results, instructions, request topology, native compact windows, confidence and failure preservation stay intact.
- Preserve Unicode scalar boundaries when extracting an optional interior, including an emoji crossing the preserved head boundary.
- Record the accounting basis and keep actual included-allowance savings unmeasured. A fixed OAuth function check preserved the required facts while removing eligible old evidence; this is not proof of subscription savings. #300's Router-only 40% goal and #317's representative quality and actual allowance validation remain open.
- Claude behavior is unchanged; common version and archive metadata advance together under the existing release contract.

## v0.8.51 — 2026-10-22 — Router sees the requests it routes

- Find the session transcript by session id when the host skips the SessionStart and UserPromptSubmit events that used to supply its path (another plugin earlier in the chain can do this). In the installed trace of 2026-10-20 to 22, one root step of 1,245 since v0.8.32 had a transcript observation, so the Router never learned cache TTLs or confirmed an applied effort. The lookup runs once per step and stops once the file is found.
- Keep a model's cache observation across a root step that reports no usage (an error turn). Before, the empty step replaced it, and the next turn held every move as `cost_unknown_hold`: 135 of 223 such holds in the same trace.
- With routing off, leave a child under a manually selected restricted root (Fable without `allowFable`) to the host instead of denying it.
- The dashboard marks a Router selection that the dispatch did not carry (budget expired, turn retired, a revived agent kept its model) as not applied instead of a change. doctor's `router_applied` counts requests with an observed model without calling them routed.
- Align the circuit and stage detail panels, keep execution rows compact, drop repeated information and the card-wide animated border, and show only real pending and response signals (#338, #346).

## v0.8.50 — 2026-10-22 — Keep a live dashboard light while records stream in

- Keep a record stream from rebuilding and relisting the whole history. On a copy of the owner's 48-hour history (60k records) with one viewer and two new records a second for 60 s, the dashboard used 49.9% of a core on v0.8.49 and 11.4% now. Three causes: the pause between rebuilds was capped at 100 ms from the previous start, so a 122 ms rebuild started again 20 ms after it ended; two thirds of each rebuild recomputed the 24-hour summary over every record; and each directory change the OS had already named still listed every file name again.
- The pause between rebuilds during a stream is now ten times the last rebuild (16 ms to 2 s), so the activity thread works at most a tenth of the time and a record after a quiet moment still shows at once. The 24-hour summary is reused for up to 10 s while records arrive, then recomputed, and at once when a record leaves the 24-hour window or a preference changes.
- Live patches still resend each changed run's full step list (about 57 KB a patch in this measurement); a smaller patch encoding needs a page protocol change and is left for a later release.
- Restore a readable circuit and stage detail row, with the startup status's five lines reserved so nothing shifts (#338, #342).
- Keep a live dashboard owner whose health check is slow instead of starting a second one, and recover a dead owner (#341, #343).

## v0.8.49 — 2026-10-22 — Keep the dashboard light while it runs

- Stop the dashboard's activity thread from rescanning and rebuilding history every few seconds (#339). The trace reader listed thousands of file names every second although file-watch notifications and the server's 30 s reconcile already cover new records, and each record leaving the 24-hour window alone triggered a full history rebuild. The reader now lists directories every 30 s by default, and records leave the window together on a 60 s step. On the owner's machine with an open dashboard, the server's CPU went from 16% to 1.9% and its live stream from 355 KB to 19 KB over the same interval.
- Keep the owner capability out of the public dashboard health reply; launch probes authenticate instead (#336).
- The dashboard UI rework and the Router transcript-observation fix ship in a later release.

## v0.8.48 — 2026-10-22 — Router keeps the conversation it routes

- Keep the last completed answer as the previous reply after a turn that ends with an error or an interruption (#334). Before, such a turn erased it, so the next request (often a short follow-up) went to Jev with no previous reply: in the installed trace of 2026-10-21 to 22, 140 root assessments had none for this reason (137 after an error, 3 after an interruption).
- Restore the previous reply and the last three requests when a session resumes in a new process. The plugin store keeps them screened and cut to the 2,000-character tail a question sends, for the latest 20 sessions, under the same transcript-length guard as the cache record (`context_restored`, `context_restore_skipped`). The host's resumed transcript is not used: a fixture resume showed reordered earlier answers, a synthetic `No response requested.` answer, and command and summary rows as user messages.
- Let a closing process finish its queued root record and context saves, and queue the context at session end as well, so a failed `-p` turn's requests survive the exit. A context save that fails to read the transcript or write the store is not marked saved, so the session end saves it again. A real-CLI test (answer, failed turn, resume, each in its own process) passed 30 of 30 runs; before the session-end queueing, it lost the failed turn's request in 3 of 16 runs.
- This fixes routing input and trace accuracy; it does not establish a measured change in routing outcomes or savings (#300, #317 remain open).

## v0.8.47 — 2026-10-22 — Keep live history fast and dashboard values readable

- Cache screened trace timestamps across sorting and late arrivals without changing records, order or secret screening (#327). A fixed 6,001-record comparison with 12 late arrivals reduced reorder CPU from 12,621 ms to 70 ms with identical output; installed long-running CPU and memory remain separate checks.
- Use readable card summaries, complete wrapped details and closed diagnostics; distinguish recent decisions from 24-hour activity (#330). Show recorded traffic on the node, hub and connecting lines, with no idle traffic animation. Chromium passed 34 cases including strict layout stability and real EventSource patch reactions in 19.7–21 ms across three viewports.
- Generate the Router's loaded hook version from the package version as a native TypeScript module (#332). Check both archive profiles and an actual Claude Function Hook receipt; already loaded older hooks retain their own version.
- Router and Compact actual subscription-saving goals remain open in #300 and #317. These runtime, UI and version repairs do not establish the required allowance reduction.

## v0.8.46 — 2026-10-22 — Keep task classes independent of available model tiers

- Preserve mechanical, routine and complex task classes when an account lacks a model tier (#300). Serve each class with the least capable sufficient available model, and sum disjoint classes assigned to the same model once.
- Match the available `gpt-6-luna` model to current official guidance for focused coding and clearly scoped problem solving. Account eligibility, supported effort, user pins, uncertainty and action-risk checks still apply. Gate B defaults remain account-derived.
- The fixed 12-example actual Jev comparison selected Luna for eight light/routine cases and Sol for four complex cases in both versions. This corrects task classification; that sample establishes neither an increased switching rate nor actual subscription savings. The measured product goals in #300 and #317 remain open.

## v0.8.45 — 2026-10-22 — Let the dashboard idle and stop promptly

- Replace 50 ms dashboard polling and unconditional one-second activity rebuilds with file/preferences watchers, actual expiry timers and shared coalesced refreshes (#327). Quiet connections send a five-second heartbeat; a constant number of metadata checks every 500 ms recovers missed filesystem notifications without rereading unchanged trace history. A 30-second filename reconciliation remains as a safety net.
- Preserve records arriving during a rebuild and follow missing or atomically replaced directories. Bound slow-viewer output with stream backpressure instead of queuing every intermediate frame.
- Close open SSE sockets and the activity thread on authenticated shutdown, dashboard off and SIGTERM. The compiled CLI tests with an open stream terminate naturally within one second.
- A fixed 32 MB / 6,000-file quiet fixture measured substantially lower CPU over 12 seconds. That short sample does not reproduce the reported 15-hour memory growth or establish a long-term RSS bound; installed-runtime monitoring continues. Router and Compact actual subscription-saving goals remain open in #300 and #317.

## v0.8.44 — 2026-10-22 — Route observable root continuations

- Allow Codex to reassess model and effort within a long root tool loop instead of reusing its first whole-task selection for every inference (#300). Retain the original contract and use only screened visible progress and closed tool metadata for a next-step judgment; uncertain judgments preserve native execution. Missing continuation context retains the initial whole-task decision.
- Deduplicate retries and concurrent assessments, bound identities per prompt, and invalidate stale decisions after cancellation, compaction, user settings, policy, account or catalog changes. Preserve native input, tool results, assistant phases, opaque reasoning and permissions.
- Bind Router submission records to their selection even when independent Compact processing changes older history. Continue recording the actual submitted model and effort.
- A bounded real OAuth protocol diagnostic with scripted judgments completed Sol → Luna → Sol and returned the required result. Actual Jev judgments on a separate fixed three-phase diagnostic conservatively kept Sol at an uncertain easy step; no confidence floor was lowered. Neither diagnostic proves the required 40% reduction in weekly subscription allowance. Native allowance readings and response headers were integer percentages, so unchanged readings are not zero consumption. #300 and #317 remain open for measured product effect.

## v0.8.43 — 2026-10-21 — Preserve standalone repetition counts

- Represent a wholly repeated eligible old tool output with its exact unit and count even when no identical invocation exists (#317). Keep the latest six results, tool links, metadata, error and secret handling, request boundaries and native compaction output unchanged. Exact representations remain protected from semantic omission; no paid assessment or external retrieval is added.
- The unchanged separate OAuth fact/count probe used 72,875 tokens OFF versus 57,236 ON (21.46% less), with no Jev judgments or extra tools. Both ON responses recovered the 37/38 thresholds, 80/79 counts and Unicode exactly; both OFF responses miscounted 79 as 80. This narrow result does not establish representative quality or the overall 50% target in #300/#317.

## v0.8.42 — 2026-10-21 — Retain exact tool evidence without repeated input

- Observe native Compact SSE even when OpenAI omits Content-Type; do not label a terminal client close as a failed compaction before buffered observation finishes (#325). Keep explicit JSON responses, real upstream failures and response usage distinct.
- Reference byte-identical older plaintext tool results to an original retained in the same request, without a paid Jev judgment (#317). Preserve call/result topology, recent results, media, failures and secrets; prevent cross-boundary references and semantic removal of referenced originals.
- Represent a wholly repeated canonical original with its exact unit and count, verifying reconstruction locally. Retain all distinct content and occurrence counts; no transcript rewrite or external retrieval is introduced.
- The unchanged bounded OAuth repeated-context comparison completed both reversed-order pairs with all required facts and no extra tools: native total 35,470 OFF versus 17,534 ON, no Jev calls, a 50.57% reduction for that fixture. This is not Router-only savings or representative work-quality proof; #300 and #317 retain their broader completion criteria.
- Including an actual native compaction and follow-up in both pairs reduced total usage from 163,990 to 92,140 (43.81%), below the broader target. A separate frozen exact-fact/count probe reduced tokens 10.34%; ON passed both responses while OFF miscounted one value in both. Keep these limits alongside the first-response result.

## v0.8.41 — 2026-10-21 — Preserve active native connections

- Distinguish a native plugin version replacement from removal (#322). Keep the serving helper during updates, confirm removal on consecutive checks, and wait for inference, hooks and owned workers before retiring it. Claim idle status before restoring configuration so new requests cannot enter that interval.
- Handle upstream disconnects both before headers and during streamed responses. Fail only the affected request, retain the helper and let Codex own retries; do not replay inference or report a truncated stream as a clean completion.
- Reproduce the previous active-update connection refusal and interrupted-stream hang with local scripted APIs. These repairs do not establish the cause of every historical disconnect or the outstanding total-token target in #300/#317.

## v0.8.40 — 2026-10-21 — Compact assessment overhead and host activity

- Skip new Compact judgments whose best-case current-request reduction cannot repay their estimated request and typed-answer overhead (#321). Prefer the useful repeated prefix of a batch, retain exact verified decisions and expose the preserve reason. Estimates do not prove total-token savings or assume future reuse.
- Show Codex Compact assessments, applied submissions and completed responses instead of Claude-only restore/budget metrics (#319). Combine both hosts' actual counts in the All view and retain unknown token effects.
- Use context-selection labels for Compact and regenerate the README previews. Preserve the existing fixed circuit geometry and readable status fields.
- A further bounded OAuth OFF/ON comparison completed actual native compaction and a subsequent turn with all required parser facts preserved. Total usage including Jev was 81,978 versus 53,134, a 35.2% reduction for this pair. This differs from the earlier first-response experiment; representative quality and the 50% target remain unproven in #300 and #317.

## v0.8.39 — 2026-10-21 — OAuth routing and Codex Jev Compact

- Separate OAuth Codex credit-rate comparisons from API cache-write estimates (#300). Permit an eligible cold Luna downgrade when even its uncached input/output rates do not exceed the best cached baseline rates. Preserve confidence, explicit pins, account catalog, context capacity and unknown-billing fallbacks. Do not infer included subscription allowance or token savings from credit prices.
- Rebuild Codex Jev Compact around bounded relevance judgments of complete older plaintext chunks, shared exact-text decisions and actual submitted/observed receipts (#317). Preserve recent results, call topology, instructions, opaque native context, failures and native compaction settings; errors preserve the original request.
- Restore Codex Compact in the five-stage dashboard, distinguish Jev judgments from reused applications, retain run provenance, focus and scroll during live reorder, and keep long status text readable without nested field scrolling (#313–316). Regenerate both README previews from the actual UI with synthetic data.
- Follow the current OpenAI prompt caching and OAuth pricing documents: finite retention and prefix-sensitive reuse; no separate Codex credit cache-write charge. API billing differs.
- A bounded synthetic OAuth comparison with two order-reversed pairs recovered every required parser fact in all four responses. Native-only consumed 35,468 tokens per cell; Compact consumed 18,893 plus 2,139 Jev tokens, a 40.7% reduction. This is not a general quality/savings result or proof of the requested 50% target. #300 and #317 retain their product-effect acceptance criteria.

## v0.8.38 — 2026-10-21 — Hooks survive native plugin upgrades

- Describe unavailable native token usage in Codex `depth_unknown` notices instead of Claude transcript/headless behavior (#311). Gate A keeps the original turn; Router application is observed separately.
- Embed the Codex hook launcher in the trusted command so deleting a previous plugin cache version cannot remove the launcher itself (#310). Keep the loaded bundle while present; after native pruning, use only the sole valid replacement of the same installed plugin. Missing, ambiguous or corrupt installations preserve native execution.
- Handle a closed host output pipe without a nonzero exit. Keep native hook trust, permission checks, existing deadlines and user settings.
- The currently observed exit 1 was Node trying to load a deleted 0.8.32 hook before the hook error handler could run. This repair does not establish the cause of every historical hook failure or measured Router token savings.

## v0.8.37 — 2026-10-21 — Preserve the native Codex provider

- Automatically configure the official `openai_base_url` endpoint instead of replacing the global provider (#304). Preserve native authentication, model, effort, comments and user settings, and restore only the owned legacy global provider selection while retaining its owned table as a historical-resume alias with Codex's revision-checked writer.
- Authenticate the local endpoint with a private capability, strip it before forwarding, and use Codex 0.163.0's official 426-to-SSE fallback before inference. No WebSocket state reconstruction or extra inference retry is introduced.
- Keep the serving helper during active inference, hooks or owned workers when an update is requested. An idle update starts its replacement within the existing startup deadline; old clients cannot downgrade it.
- Verify actual native installation, continuation, worker, compaction, hook completion, crash recovery and settings restoration with local scripted APIs. List both historical providers and resume their exact thread IDs through the built-in endpoint without changing stored history. Codex's default picker still filters providers even with `--all`; this host limitation remains documented.
- No total-token reduction or quality-equivalent product savings was measured here. Router cost policy and actual token effect remain tracked in #300.

## v0.8.36 — 2026-10-21 — Readable live execution circuit

- Balance the five Claude stages and four Codex stages across responsive rows, with a shared Jev rail on wide screens (#302). Real responses trigger the signal, glow and pulse effects; idle data does not invent activity.
- Keep persistent stage detail fields with reserved space, wrapping, selectable full values and keyboard/touch scrolling. Live updates preserve layout, focus and scroll positions. Show the original Jev decision even when a host observation follows it.
- Restore light/dark README dashboard previews rendered from the current UI with synthetic sample data, and ship their assets in the install archive.
- Repair the isolated native runtime test package to include its required license. Native history, lifecycle tools and hook-deadline verification use disposable homes and local scripted APIs.
- No token reduction or cost improvement was measured for this release. Automatic Codex connection preserving the existing provider and user settings (#304) and the Router cost/total-token requirements (#300) remain separate work.

## v0.8.35 — 2026-10-21 — Native worker collection and tool access

- Fix owned-worker result recovery against the native Codex API (#303). Workers now use native history because ephemeral threads reject includeTurns reads. Status still requires the exact thread and terminal turn; a collection error does not establish execution failure or acceptance. Worker conversations follow native local history retention and are archived after settlement.
- Remove the broad pending-worker tool guard and its shell parser. Native commands and edits keep Codex permissions; existing reservations prevent duplicate managed dispatches. Existing workers and files are preserved.
- Record safe collection failure codes instead of losing every RPC error behind collection_failed. No prompt, credential or raw exception is added to diagnostics.
- Verify missed-notification recovery and tool access in lifecycle regressions, plus persistent terminal turn/items reads with the installed native Codex host and a local scripted API. This does not recover missing history from old ephemeral workers or establish measured token savings.

## v0.8.34 — 2026-10-21 — Codex hook deadlines

- Keep native Codex hooks within their host deadlines (#305). SessionEnd and Interrupt now share a 2.2-second internal budget; other events share 4.2 seconds. Startup health checks, credential provisioning, connection polling and the helper request consume the same budget, leaving time for process startup and the baseline JSON response before the host's 3/5-second limits.
- A stalled helper returns the native baseline instead of waiting beyond the host deadline. An isolated compiled SessionEnd process exited successfully in 2.31 seconds with `{}` and no stderr. This verifies the timeout repair, not the cause of every reported Hook failed alert; their native completion details remain unavailable.
- The broader worker collection/tool guard (#303), provider/history compatibility (#304), dashboard redesign (#302) and measured Router token effect (#300) remain separate work. No token reduction or cost improvement was measured for this patch.

## v0.8.33 — 2026-10-21 — Credential forms and faithful activity status

- Screen CLI credentials after global options with values, across shell line continuations, and in supported short-flag clusters (#295). Literal credentials and environment/template references are tested as pairs; the Router uses the same screen.
- Export the Router's highest activity severity to the dashboard, including model application, release and spawn coverage failures. Keep the cost subcheck's own result separate (#297).
- Record a worker report's changed-file count. A read-only result with no checks is no longer an unchecked-change regression; older results without change/check metadata remain unknown (#298).
- Count confirmed owned-worker execution failures in the 24-hour worker status on both hosts, once per execution. Keep contract rejections, cancellation, pre-execution failures and unconfirmed settlement distinct (#299).
- No token reduction or cost improvement was measured for this release. Codex's initial model-switch cost policy (#300) still needs the replay evidence and limits specified in that issue; it is not resolved by these fixes.

## v0.8.32 — 2026-10-21 — Fewer features, each one traced

- Remove features with no measured use (#288, #289, #292). Evidence (`jev_evidence`) had 0 Claude calls in 15,342 requests and 0 Jev judgments in Codex; the planner had 0 calls on either host and the root tool guard did nothing at defaults; Codex Compact never fired on this host. Their tools, skills, prompt text, trace kinds, dashboard cards and settings are gone. The MCP server keeps its name for onboarding and Codex `jev_agent`; `workerIsolation` (one worker in its own worktree) stays.
- doctor judges each remaining feature from the last 24 hours of trace records on both hosts: fired, applied, effect and regressions; a feature with no trace is reported as untraceable (#279). Router savings count only applied decisions, and a session with a request that never returned, failed, or has incomplete usage is unknown, not a saving. Function Compact records are counted.
- Gate A and Compact judge only what a person typed: task notifications, compaction summaries and queued host prompts are not requests, and late results apply only to their own generation (#281, #284). Reason labels in records and the dashboard are distinct and closed (#285).
- Codex: an explicit `-m` model and `codex exec` model/effort are kept; a session started without a connection is recorded and told (#282). Worker read commands are classified by an exact git option allowlist, configured git, textconv, filters, pagers and external diff count as writes of unknown target, `status` collects a finished turn and names the reservation's blocker, and connection failures are recorded once (#287, #293).
- Router: a SendMessage resumption runs native instead of being routed as a new spawn, a root turn is no longer released mid-turn, a model named for another tool is not read as a root control lock, and applied effort, cache TTL and `cost.usd` come from the transcript (#283, #290, #291, #294). Traces are kept 48 hours.
- Worker results reach the coordinator through one projection on both hosts: status, summary, changed paths, interfaces and blockers, each screened for credentials and dropped field by field on a hit; check commands, notes and failure prose are never stored or replayed. A finished Claude background worker settles on every host notice shape, so its reservation no longer outlives it.
- The credential screen (one authority, mirrored for the Router) recognises a credential word at the end of any key name in JSON, YAML, env, headers, query strings, kwargs, CLI flags and prose; credentials passed as command-line arguments (curl -u, database, redis, docker, sshpass, openssl and others); shell defaults such as `${PASSWORD:-…}`; Jev, Google, Stripe, npm and GitHub token formats; while ordinary code such as `credentials: 'include'` or `max token: 4000` no longer blocks routing. A corpus of common credential formats and a differential test over 228,988 generated inputs require every 0.8.31 positive to stay detected, and the screen stays linear (a 100 KB adversarial input under 20 ms).
- The dashboard's execution circuit animates live records as they arrive (record-to-screen p50 130 ms, from 2,903 ms).
- Restore Router routing of Gate-dispatched worker steps, which was refused because the dispatch marker looked like a credential.
- The project is MIT licensed, and every archive ships the LICENSE and the plugin icon.

## v0.8.31 — 2026-10-20 — Effort routing from a session's start, a version badge that fits its text

- Lower the root effort in a new session without waiting for a cold cache (#277). An effort change keeps the prompt cache, but the Router lowered effort on a warm cache only after seeing that in the same session, and its capability check could never say so (it needs a HIPAA status no host API reports): a session whose first turn kept its effort held every later downgrade at the cached effort. Over the trace, 62 effort changes Jev chose in 9 sessions were held, 5 of them in the two sessions since the 2.1.304 restart. The last effort-change observation per model is now kept in the plugin store, so a session starts from an earlier session's hit (`effort_cache_basis: earlier_session`); a gateway or disabled betas never use it, and a miss restores the hold for that session and the next. The three misses recorded so far were returns to a model after another model's requests (out of the cache's reach, #274), not effort changes, and each turned effort routing off for the rest of its session: an effort change is now judged only on a request right after the same model's own. The trace holds 38 root hits and no miss an effort change caused. What the released downgrades save in output tokens was not measured.
- The dashboard's version badge was a fixed 14.4em, sized for its longest text, so `v0.8.31 · 최신` sat in a 158 px pill with most of it empty. It now fits its text in place (86 px for the current-version text, 145 px with an update named, up to the old width). Its text arrived from `/api/version` after the first frame, which is why it had a fixed width: the server now puts the version it would answer in the page, so the badge has its text and width in the first frame and the header does not move. A badge hidden for an unknown version keeps no text, so it no longer grows while invisible.

## v0.8.30 — 2026-10-20 — Root switches within the cache's reach

- Price a root model switch by whether the cache it reads is still in reach, and return to the baseline before its cache leaves reach (#274). A request reads an earlier cache entry only from at most 20 blocks back, but the cost guard read a model's cache as warm for its whole TTL. Over 100 returns to a model within 55 minutes in three transcripts (2026-10-16 to 10-19), every return with at most 5 requests between read its cache (47 of 47), 4 of 6 with 6, 1 of 6 with 7, none of 41 with 8 or more. On 2026-10-19 a Haiku move was priced as reading 99,448 cached tokens after 18 Opus requests and read 30,040 (estimated −$0.128 to −$0.118, about −$0.088 to −$0.052 by the recorded usage); in a v0.8.22 session the return to Opus after 11 Haiku requests read 29,836 and wrote 123,451. Root requests are now numbered: a target last answering more than 5 requests back is priced as an unknown cache, 8 or more as cold, and a switch serves at most 5 requests counted from the baseline's last one, after which the turn runs on its native pair (`root_stop`, `baseline_reach`); a turn with none left keeps the baseline. Codex and spawns are unchanged. The dashboard names `cost_unknown_hold` and `baseline_reach`.
- The installed-host model dispatch test now sends every routed pair through the real Claude host and checks the model and effort of each API request: root Opus low, medium, high, xhigh and max, Sonnet and Haiku low, medium and high, and workers on Sonnet low and medium and Opus low, medium and xhigh besides the pairs it already covered (23 cases).

## v0.8.29 — 2026-10-19 — A livelier Jev traffic strip, Router docs on max

- The dashboard's Jev traffic strip covers 2 minutes instead of 30 seconds and runs on a ruler that scrolls at the ticks' speed while the stream is live; pausing, a lost connection or reduced motion stop it. Jev calls arrive about once a minute in bursts: over the last 3 hours a 30-second strip was empty 76% of the time, a 2-minute one 44%. No tick is drawn without a recorded call.
- The Router README said Opus and Fable could be moved to `max`. Router never offers `max` (since v0.3.0): a native `max` is kept or lowered. The docs now say so; behavior is unchanged.

## v0.8.28 — 2026-10-19 — Root model switches priced over a turn

- Price a main-session model switch over the requests a turn runs instead of the next request alone (#271). A switch rewrites the conversation's prompt cache once and saves the read and output price difference on every request after it, but the cost guard compared that one write with one request's saving, so it held every downgrade of a warm conversation: from v0.8.24 to v0.8.27 Jev proposed a cheaper main model 42 times (Haiku 25, Sonnet 17) and none moved. A root switch is now priced over 5 requests (`TURN_HORIZON`, the p90 of requests per root turn over 698 turns, 2026-10-16 to 10-19), each producing the newest request's output; a spawn is still priced on its first. At a 150k Opus prefix Haiku repays its write within the turn and moves, Sonnet takes about 20 requests and stays held (at a 1.5k-token last output; a longer one moves sooner, a shorter one holds Haiku too). Codex and spawns keep the one-request price and its zero-to-previous output scenario. An unobserved prefix, cache state or price still holds, and an effort change is unchanged.
- Measured before the change, not a measured product effect: replaying the recorded inputs and Jev proposals of the 9 sessions since 2026-10-16 through the shipped `switchCost` at the observed 1-hour TTL (441 requests after a 5 to 60 minute pause, 430 read their prefix), 13 of the 42 held proposals pass, the replay makes 7 switches (the rest fall in turns already switched) and the API list estimate falls from $58.61 to $56.39 (−3.8%); 2 sessions fall 6.1% and 15.8%, 1 rises 0.6%, 6 are unchanged. With no guard, as v0.8.22 ran, the total falls 11.2% but 6 sessions rise, one 27.5%; horizons of 6 to 10 let one session rise 3%, 15 one 13%. Output quality on Haiku was not measured. The return is priced at the baseline's read rate, so a 5-minute baseline cache expiring within the turn is not counted. A real-host smoke (local build, real Jev, `-p --resume` per turn) moved a 26k and a 117k Opus conversation to Haiku for a one-line answer, observed Haiku answering, and returned to Opus for the next turn's file reading. Codex keeps the one-request price: no Codex replay was run.

## v0.8.27 — 2026-10-19 — Spawn routing in the dashboard's Jev totals, Router-changed spawns, a plainer dashboard

- Count the Jev call that routes a subagent in the dashboard (#267). The spawn record carried its tokens and Jev model but no `duration_ms`, which the dashboard reads as a Jev call's measured response, so those calls were missing from today's calls, tokens, cost and latency (4 calls and 12,925 input tokens on 2026-10-19). The spawn record now carries `duration_ms` and `hook_version` as root and child records do.
- Stop counting a subagent whose model Router changed as a response model mismatch (#268). A worker result compared the model the caller passed with the model that ran, but Router replaces that model before the host runs it, so every changed spawn read as a mismatch (3 on 2026-10-19). The result now takes the model Router sent from the same call's `spawn_result` and keeps the caller's model as a "Router 변경" line.
- Make the dashboard read as decisions instead of records (#269). The 30-second call timeline, almost always empty, is gone. The decision basis panel names its questions and answers in words and shows a yes/no answer with its probability; the call log names the scope of every feature's call and keeps its rows while one is pressed. A Gate response and its policy are one stage in the run detail, consecutive identical records are one row with their count, Router stages are named by event and summarised by the setting they sent or kept, and durations past an hour read in hours and days. The stage details show the run, the part of the reason the card does not, the effect, the next stage and the cause. Runs are listed without the repeated source and model, and the attention breakdown counts runs as the attention count does. A Router call's typed answers load with its stage details, not in every frame (1.47 MB to 1.22 MB in the 2026-10-19 trace).

## v0.8.26 — 2026-10-19 — Dashboard stage details, resumed cache after notifications, new session model

- Show the stage's newest Jev call in the dashboard's stage details (#261). The panel read its one Jev line from the feature's newest stage, but Router and Compact record a host or local stage after the call, so the line was always `–`. It now reads the newest Jev-lane stage of the feature and draws its latency, tokens, estimated cost and Jev model; the card and the decision basis panel keep the decision and its probability.
- Restore the root cache after a process that ended on task notification turns (#263). The saved observation carried the request's message count, which a task notification's request inflates in memory: after two notifications the last request carried 44 messages and the resumed one 39, so the resume read as a compaction and its first switch held as `cost_unknown_hold` (3 of 32 resumes in the 2026-10-19 bench, every one after two notification turns). The save now keeps the host transcript's length, 11 there and 12 resumed, and a resume compares that. A resume that restores nothing logs `cache_restore_skipped` with its reason (`no_record`, `no_cache`, `shorter_request`) and both counts.
- Keep a new session's own model when settings name another (#265). A conversation counted as under way when its first request carried more than one message, but the host's first request of a new session carries its own context messages (17 on 2.1.303), so a new `--model opus` session with Sonnet in settings ran on Sonnet. A conversation is now under way when its transcript already holds an assistant message; a failed read leaves the person's pair. Since v0.8.25.
- Answer a snapshot request with the new record when no viewer is open (#266). With new records the request waits out the rebuild pause once, but a timer can wake a millisecond before `Date.now()` reaches its delay (999 of 1000 ms observed), so the refresh after it skipped the rebuild and the answer left the record out. The request now waits until the pause has passed by the clock.

## v0.8.25 — 2026-10-19 — Resumed root cache, resumed baseline, trace retention

- Keep the root's cache observations across a resume (#258). They lived in process memory only, so a session that runs one process per turn (`claude -p --resume`, the A/B bench) judged every root switch with no prefix and held it as `cost_unknown_hold`: on 2026-10-19 the bench's D cells held all 13 root decisions, every first turn of a process with `prefix: null` while the same process had seen a warm 110k Opus prefix 25 seconds before. The plugin store now saves the observations of the last root response with the session's record (one write per root response) and the next process restores them on its first root turn, judged by their own age and TTL as before; a request shorter than the saved one, a compaction or rewind since, restores nothing. The record shows `cache_restored`. The switch cost guard itself is unchanged: it still prices only the next request and the one after it, so on a long warm session a downgrade is now held as a measured `cost_hold` instead of an unknown, and root model moves stay rare there. Changing that is a cost-policy change and needs its own bench.
- Read the native model from settings for a resumed conversation with no stored record (#259). A session last routed to Sonnet under 0.8.23 resumed on Sonnet under 0.8.24 and kept it as native (`baseline_source: turn.step`) although settings named Opus: with no record, a turn that named a model was taken as the person's own even in a conversation under way, which the README already said takes the settings model (`host_environment`). A new conversation (one message), or settings naming the turn's own model, still keeps the turn's pair. A session 0.8.24 already recorded this way keeps that record; run `/model` once in it.
- Delete trace records older than 3 days from every session (#257). Retention ran only when the evidence MCP server started, so a host where it never connected kept every record. The gate's SessionStart hook now starts the same once-a-day pass in a detached child, so the hook neither waits for the scan nor fails with it.

## v0.8.24 — 2026-10-16 — Jev 1.14, root drift, spawn bounds, steadier dashboard

- Bound every routed spawn by its tools (no option; quality not yet measured): the role its capability answer selected is limited by what the spawn can do. A spawn that cannot edit (Explore, Plan, or an agent file whose tools hold none of Edit, Write, NotebookEdit, MultiEdit or Bash) may run the cheapest role on a clear, ordinary, unlocked `mechanical` or `routine` answer (`tool_read_only`). A whole `Bash` or all tools (no `tools` list, or `*`) counts as editing, and a spawn that can edit runs no role below standard (`tool_editing_floor`, `tool_editing`). Bash granted only by a command pattern, an unread or unparsable agent file, or any other tools the hook cannot read keep the baseline (`tool_unknown`). The final model is never above the baseline or the agent's declared model (`tool_ceiling`), so a baseline below standard stays where it is. Records carry `spawn_tool_class` and the `tool_*` model reason.
- The six owned agents now withhold `Agent, SendMessage, Skill, Artifact, ArtifactComments, ArtifactData` (planners also `Edit, Write, NotebookEdit`) and set `omitClaudeMd: true`; `tools` stays absent so connected MCPs are still inherited. `npm run gen:agents` writes both, and doctor fails an installed agent whose `disallowedTools` or `omitClaudeMd` differs. Restart Claude Code so the agent definitions reload.
- Pin `jev-1.14.0` for Gate A/B, the Router, Compact, Evidence and Codex (config default and sample, `JEV_MODEL`, `EVIDENCE_MODEL`, the bench). Price, context length and tokenizer are the same as `jev-1.13.0`; `jev-latest` still points to 1.13, so the versioned ID is pinned rather than an alias. A `jevModel` set in a config file is unchanged. The bench prices both versions, so recorded 1.13 answers keep their cost. Measured before the move on 2026-10-16 and listed in the next entry; the Router README has the tables. Gate A calibration on the 29-prompt admission set gave the same 28 of 29 choices and the same input tokens on both versions.
- Measure the move before making it, and keep the numbers. `bench/results/jev-1.14-migration-2026-10-16/` holds the aggregates, the scripts and what was decided from each; the raw per-call records stay outside the repository. One day, one person's labels, small samples; none of it is a measured product effect and none is a token saving. Router dev split, now 84 labelled requests (12 `hard_short` complex requests added before any run after the first held-out run showed two complex requests at `medium` effort, `d-c21` to `d-c32`; the frozen held-out split is unchanged), 3 repeats: 1.14 shipped policy 97.6% exact / 1.2% under / 1.2% over, 1.13 96.4 / 1.2 / 2.4; the cheapest-first order 96.4 / 1.2 / 2.4 against 95.2 / 1.2 / 3.6; complex answers served below the labelled effort 5 of 96 against 6 of 96, and the same three requests (`d-r16`, `d-c21`, `d-c32`) carry every effort miss on both. The held-out split ran twice on 1.14: 98.4% exact, 0% under (95% upper bound 5.7%), 1.6% over, 0 of 20 probes moved below their pair both times, the same as 1.13 on that split; effort inside the labelled range 96.8% then 98.4% (1.13: 100%). Gate B worker tiers on 37 labelled items and the planner on 16, 3 repeats (`bench/v5/gate-b-set.json`, `scripts/gate-b-calibration.mjs`): the production atomic shape agrees with the label 108 of 111 on 1.13 and 109 of 111 on 1.14, the composite shape 94 and 93, the planner 45 of 48 on both. A first Gate B run that left out every prior attempt (a field-name defect in the script, found in review) is withdrawn and kept beside the corrected one. Compact selection (`bench/compact/selection-eval.ts`, 8 scenarios, 5 repeats, scored on what the selector keeps): 212 of 240 on 1.13 and 221 of 240 on 1.14 against the `required` labels (two earlier runs scored on the model's raw answers gave 212 / 221 and 214 / 220). Evidence relevance (`bench/evidence/relevance-eval.mjs`, 185 candidates, 5 repeats): 163 and 165 exact (an earlier run 163 and 162), no relevant candidate folded on either. Compact reads 6 to 9 of 240 higher on 1.14 in every run (212 to 214 against 220 to 221) on these 8 small scenarios, which does not establish a general accuracy gain; the other differences are one to three answers. No criteria or code path was changed because of any of it.
- Compressed request bodies and the long-context header were evaluated and not adopted. `gzip` and `zstd` cut the wire size by 57 to 83% but moved the median latency by about 1 to 2 ms on 170 to 210 ms calls (9,000 requests, mostly inside the interval), the Router and Compact mods cannot send a binary body, and `zstd` needs Node 22.15 against an engines floor of 22. `TypeSafe-Danger-Zone-Long-Context` adds about 250 ms at 40k tokens and 1.7 s at 150k, the provider calls it less accurate, and in 3 days of traces and 3,223 typed prompts no request came near the provider's limit (it refuses between about 33k and 36k tokens without the header, observed on the live API); the local caps that do trigger are packing limits at a third of that, so the header would not lift them. Revisit if a trace records `context_exceeded`.
- Show `context_exceeded` and `rejected_input` on a Compact selection step with a label instead of the raw code, and group models with one price in the dashboard credit note (`jev-1.13.0 · jev-1.14.0, 100만 토큰당 $0.042`) instead of listing each. The 400 branch reads at most 4 KiB of the error body under the same deadline; an oversized, non-JSON or never-ending body stays a plain `http_400`.
- Pin that a Jev answer with fields the product does not read (a `legend`, a `rationale`, a `confidence` beside a `noul`) decides exactly as one without them, at Gate A, Gate B, Compact selection and Evidence; the validators were audited and needed no code change.
- Repair two causes of stale Codex runtime tests that were not the pin (8 of 32 failed on v0.8.23 before any change): three reads parsed the `.retention` marker the trace writer keeps as a trace record, and the fake Jev answered a `model` question that the Codex Router has asked as `capability` since v0.8.22. Three cases (`routing-model-luna`, `routing-root-model`, `routing-root-both`) expected a model move to `gpt-6-luna` on a thread with no observed usage, which the switch cost guard below now holds; they now expect the held model and the `cost_unknown_hold` reason, as the Claude runtime test already did. `npm run test:codex:runtime` passes against Codex CLI 0.162.1.
- Codex: a native `spawn_agent` child request (turn metadata `thread_source: "subagent"`, or a `parent_thread_id` other than its own thread) no longer binds to the root through the root's `session-id` header. It used to overwrite the root's saved request items, take the root's routed model and effort when its own pair matched the root's, and be recorded as the root's latest submission and usage. It is now forwarded unchanged and unrecorded, like any request the proxy cannot bind; hook trust for it is still checked against the root. `jev_agent` workers are unchanged.
- Name Jev's request errors. A 400 whose body says `max_tokens_exceeded` is `context_exceeded`, and 400, 413 and 415 have their own codes (`http_400`, `http_413`, `http_415`) instead of `http_other`; the Router records `context_exceeded` and counts 415 as `rejected_input`. Each still keeps the original call, without a retry.
- Router: a pair the Router sent itself never becomes the root baseline. A resumed Claude Code session runs its main loop on the model of its last answer, which may be the Router's own patch, and that pair used to be read as the person's choice. The plugin store now keeps each session's native pair and the Router's last root request (`router-root:<session id>`, the newest 200 sessions). At a resume, an incoming pair equal to that request is drift, as is a pair equal to a recorded drift later in the session; every drifted turn, routed, kept, held or unassessed, runs on the native pair while that model is still an allowed, available target (`baseline_source: stored_native`, with the incoming pair recorded). Any other pair is the person's own `/model` or `/effort` and becomes native. With no stored record, a conversation already under way takes the native model from `ANTHROPIC_MODEL` or settings `model` and its effort from the effective effort setting (`host_environment`); a new conversation's own pair is native. A stored drift whose model the settings name is the person's choice, and a drift is dropped when the settings model changes or cannot be read again on a later turn. An environment pin keeps its dimension. A main-loop spawn that inherits its parent's model inherits the native model during a drift.
- Router: root records are saved in order, only when changed and off the step's path, and a save queued in one session is dropped if the session changed before it ran, so it is never written under the next one. A record read begun for an earlier root turn or session is never applied after a newer one began, and the same first step dispatched again before its turn is stored waits for that turn instead of opening it a second time.
- Router: subagent steps choose effort only. The model is chosen once, at the spawn: a step on another model re-reads the child's whole conversation without its cache.
- Router: a user or project agent (`.claude/agents/<type>.md`, project first, then `CLAUDE_CONFIG_DIR` or `~/.claude`) is assessed from its file's `model:` (absent or `inherit` is the parent's) and is only ever moved down from a declared model; a declared model outside the catalog is skipped as `baseline_unknown`, and a plugin's agent or an unreadable file keeps its model. A spawn whose `name` addresses a subagent the session already has is a SendMessage resumption and stays native (`resumed`). At a spawn, an instruction about which model another tool, program or agent should use (for example running a CLI with a named model) is no longer read as a lock on the worker's model; one of 107 real briefs had read as `explicit_lock` at 0.93.
- Hold a model switch unless it costs no more than staying in every scenario the observed usage allows, at the Claude root, at a Claude spawn and in the Codex Router. The estimate takes the newest request's prefix (its input, cache reads, cache writes and output) plus the new input the switched request carries, at least one token, and prices both models at the provider band for that whole request; the new input sets the band only, not the token count. A side whose cache state is unknown is bounded by its read and write rates, a TTL the host does not report spans 5 minutes to 1 hour, and the request after it may go back to the baseline (a new subagent has no conversation to go back to). An unobserved prefix, cache state or price now holds (`cost_unknown_hold`; it used to allow), and a dearer estimate holds (`cost_hold`). An upgrade by documented role is never held for cost (`upgrade_allowed`); an effort change alone is not checked. Records carry `cost_reason` and the estimate's evidence. A model not observed in the current cache epoch counts as cold, and the root effort floors treat a TTL the host does not report as up to one hour (`unknown_ttl_upper_bound`, was a 55-minute fallback).
- Parse agent frontmatter once for doctor and the Router: YAML block lists (`tools:` followed by `- Read` lines) are read, an unquoted item ends at ` #`, and a blank or comment line inside a list does not end it. The Router reads `model:` and whether `tools` and `disallowedTools` grant an editing tool; `Bash` counts as editing.
- `doctor --verbose` prints the measured compaction point: the median `preTokens` of automatic compactions in the newest transcripts of this project's folder under `<config>/projects` (every folder when this project has none), how far that is below the configured window, and that a target point T needs `autoCompactWindow` = T + that offset. It reads only the compaction boundary records. `docs/bench-ab.md`: the host compacts at the window minus a fixed offset, not a fraction of it (a 300000 window compacted at a median 268K on the owner's sessions, 2026-10-16, and `autoCompact.threshold` 0.7 had no visible effect).
- The dashboard keeps its layout still while records arrive: the version badge, connection state, notice, stat lines, circuit cards, inspector, run facts and list rows have fixed sizes or slots, and the executions list redraws a run that changes place in its new slot instead of moving rows. The header has three stats (the response median moved to the call log) and the state filters no longer show counts.
- Dashboard circuit: the rail is a thin line with a `Jev` badge at its left that names the Jev version of the latest recorded response and is marked while a response is awaited (a recorded request without its response, or a dot on the rail); the latency label at its end, the ambient sweep and the moving wires are gone, so only a Jev call moves. The returning dot carries its response time and leaves it in view a moment after it lands. Each card is a fixed 132 px with a line for the recorded reason (a routed change names the baseline it left) and a bar for the decision's probability. The inspector shows only the host, the Jev response time, the stage help and the link; the card already shows the rest.
- Dashboard Jev call log: one full-width card. Its header holds the median, p95 and the estimated cost, whose list-price note is the value's tooltip. A 30-second timeline has one lane each for Router, Gate A, Gate B, Compact and Evidence; a bar starts where its response started and is as long as it took, and an awaited request grows until its response arrives. Fourteen fixed rows show time, feature, scope, input tokens, response and result, and a request without its response counts up in its row. Selecting a row pins its decision basis (each question's top answer, its probability with the threshold as a tick, and the recorded reason code); `Follow latest` returns to the newest call. The live/pause buttons and the separate Jev response card are removed.
- Redraw the README's animated dashboard sample (`assets/readme/dashboard.svg` and `dashboard-dark.svg`) from the new page with sample data: still CSS-only, no script, English, marked as sample data and still under reduced motion. It shows the `Jev 1.14` rail, the timeline, the call log with its decision basis and the estimated cost without its tooltip note; the README alt text names the new parts.
- `node dist/bench/ab.js run` takes `--plugin-dir DIR` (a built checkout, keyed `jev-gate@inline`, with the installed copy disabled so its hooks do not run twice) and `--host-settings FILE` (top-level host settings per condition, such as `autoCompactWindow`). The plan identity always records `plugin_dir` and `host`, so a resume that drops either flag differs from its plan; a plan written before these fields reads them as unset. `npm run bench:router` gains `--split spawn` (asked as a child contract at spawn scope) and `bench/router/golden.json` gains 12 spawn items; no spawn-split result is recorded in this release. Bench reports price a record without a Jev model at the configured default.

## v0.8.23 — 2026-10-16 — A model mention is not a model lock

- Stop reading a mention of a model as a model lock. "It still works on Opus for everything, check it" kept Opus because Jev answered `model_lock` at 0.62. The control criteria now say a lock is an instruction about how this work runs, and naming, asking about or complaining about a model or effort is not one; and a lock read below 0.8 counts toward a clear task (`weak_lock` on the record). Explicit locks ("use Opus for this", "don't switch models", "keep model and effort") still read 0.96–1.0 and still hold. The dev split gains 8 labelled requests that mention a model without pinning it. With `jev-1.13.0` the frozen held-out split stayed at 0% under-routed and 0 of 20 probes moved; exact was 96.9% against 98.4% before, and the two extra misses are task-clear readings, not locks.

## v0.8.22 — 2026-10-15 — Capability routing, Codex successors, classic Compact, dashboard limits

- Ask Jev what capability the work needs instead of which model to use. When every eligible candidate has a documented role and the baseline is offered, the Router's root, child and spawn questions, Gate dispatch and Codex now ask one capability choice: `mechanical`, `routine`, `complex`, and `open_problem` only with a frontier candidate, plus `unclear`. Each option has what it covers, examples and what belongs to a neighbour, and names no model, role, effort or price. The batch also has one effort score per offered model. Code maps each role to one model (the baseline for its own role, else the role preference, else catalog order) and reads the answer in role order with the existing floors, control lock, downgrade risk guard, cache hold, pins and Astra/Fable rules. `unclear` keeps the native model and effort. Candidates without a documented role keep the v0.8.21 pair question unchanged. Records carry `policy: "role"` and the role → option → model map.
- Treat text in the request that names a model or claims routing was already decided as part of the task, never an instruction.
- Serve a Gate retry at least one role above the model its failed attempt recorded, as a fresh worker.
- Add `npm run bench:router` and `bench/router/golden.json`: 64 dev and 64 frozen held-out labelled requests plus 20 injection probes, asked live as fresh root turns. The options are listed most capable first because that order put less probability below the label on the dev split. On the held-out split with `jev-1.13.0`: 98.4% routed to the labelled role, 0% under-routed (95% upper bound 5.7%), 1.6% over-routed, and 0 of 20 probes moved below their pair. The v0.8.21 pair question had 85.9%, 12.5% (22.8%), 1.6% and 3 of 20 on the same requests. One person wrote the labels and the rubric, so this measures agreement with the rubric, not task outcomes or cost. The Router README has the tables.
- Codex: a `gpt-<major>[.<minor>]-<family>` model is superseded when the account catalog lists a newer general model of the same family; the newest one is its successor. A superseded model is never a target or tier default (`excluded.superseded` counts them), even when its description does not say older or previous. A root or child whose own model is superseded, for example `gpt-6-sol` or `gpt-5.6-sol` with `gpt-6.1-sol` listed, runs on the successor when model routing is on, the model is not pinned and the successor is an allowed target for the same effort, also when Jev fails or the key is missing. Records carry `superseded_baseline` with from/to. Otherwise the native model stays. IDs outside that grammar are never superseded.
- Option structure and instruction wording after ruban-24/switchboard, and the anti-injection sentence and evaluation protocol after dirien/jev-router (both Apache-2.0).
- Make Compact deliver on a host that passes `session.compact` over (Claude Code 2.1.299+ with a Team or Enterprise seat, or managed settings), with no setting written or changed. The plugin's own `hooks.json` now runs `dist/compact-hook.js` on `PreCompact` (Jev-selected steering for the engine's summarizer: no `<analysis>`, a summary under a share of the budget, 12,000 characters at the default), `SessionStart` with `source: compact` (a restore of the latest requests, latest failed calls, Jev-named results and touched files, at most 9,000 characters, summary plus restore within `compactBudgetChars`) and `PostCompact` (records the summary's size). It guides and supplements the native compaction and cannot replace it. The function path, where the host lets it run, is unchanged and writes a marker so the classic hooks never also act on a compaction it was asked about. Every hook exits 0 and an error leaves the engine's compaction as it was. On a Haiku 12-file task, 3 runs per arm, the engine's compaction took 9.3 s native and 5.6 s with the classic path, and the context after it was 9.7K against 10.9K tokens; those are a toy measurement with the earlier 4,000-character share, not a cost or quality claim.
- Doctor states the seated-host status plainly and checks the three classic hooks and `dist/compact-hook.js`.
- Show the Router's capability answer on the dashboard: the kind of work it named and the model the role map proposed, control and capability answers in the pair-receipt shape, and labels for `capability_unclear`, `retry_step_up`, `superseded_baseline`, `risk_blocks_downgrade`, `cost_hold` and `candidate_unavailable`.
- Remove the dashboard's four remaining limits (#252). A record landing in a long Codex turn remakes only the steps whose pairing or age it changes, and reuses the rest by identity instead of rebuilding the whole group. String caches keep two generations, one per rebuild, so they are bounded by the window the dashboard reads instead of growing to 200,000 entries and being cleared whole. Records that already name their host are no longer copied, repeated step texts share one string, and a Mod record is built only as its row (as a record it built nothing visible: 57,000 of 59,000 builds on one machine's traces). Rebuild pacing counts from the previous rebuild's start, four times its own time within one to four seconds, without the directory reads, and a waiting record starts on a timer instead of the next scan. On a copy of one machine's traces with two viewers open and one record a second, one run each: the server's peak footprint went from about 720 MB to about 450 MB and record-to-screen delay from p90 1.27 s, max 5.7 s to p90 0.93 s, max 1.06 s; average CPU was 8% and 7%. These are one run on that copy, not a general guarantee.

## v0.8.21 — 2026-10-15 — Router model mass, task notices, dashboard CPU, 3-day records

- Read the Router's model answer as ordered mass, as effort already is (#240). The cheapest role whose cumulative lower mass reaches the downgrade floor is chosen, else the highest role whose upper tail reaches the upgrade floor; a split vote such as keep .23 / Sonnet .34 / Haiku .41 now moves to Sonnet instead of holding on Opus. A tie is read the same way and holds as `low_confidence` instead of `answer_invalid`. Unknown roles and a crossing role held by more than one version keep the nominal reading; the floors, the control lock and the downgrade risk guard are unchanged. Replaying 72 hours of recorded answers with floors at .5 moves 93 of 387 root assessments (14 before) and 137 of 2,450 child steps (0 before); that is a policy replay, not a measured cost or quality effect.
- Record the pair answers and selection diagnostics on every Router `spawn` record (#241).
- Notice a compaction the host never announced (#242). On Claude Code 2.1.299+ the host's security default passes `session.compact` over for an installed plugin in Team and Enterprise organizations; a request that carries fewer messages than its loop's last one now resets that loop's cache state the same way, recorded as `context_reset`.
- Route a `<task-notification>` turn as the continuation of the person's last request (#243). Its machine text is no longer sent to Jev or kept as a recent request; the root record says `turn_source: "task_notification"`.
- Label a subagent whose spawn kept its effort with the pair's own reason instead of `answer_invalid` (#244).
- Never ask Gate A about a host task notification (#245). It no longer costs Jev calls or opens a new generation that pushed the current job into history; `admission_result` records `task_notification`, outside liveness.
- Keep 3 days of trace records and dashboard history instead of 7. Older trace files are removed by the next retention pass after the update.
- Doctor warns when Compact cannot run because Claude Code 2.1.299+ seats its built-in plugin security default for a Team or Enterprise organization or a machine with managed settings, and the Compact README shows the managed-settings fix (#246).
- Make the dashboard cost what new records touch (#247). It no longer rebuilds without a new record: age and window edges count only where a shown answer changes, and the 30-second reconciliation reads only files it has no record for, since trace files are written once. Under a record stream a rebuild waits three times its own duration (one to four seconds), and rebuilds only the records' own group of related records, keeping totals and sorted lists in place; a viewer still sees a new record within about five seconds. Reconnect leases are capped at 64. On a copy of one machine's traces with viewers open and one record a second, the server's CPU went from 71% to 10% and its footprint from about 1.3 GB to about 620 MB; a single rebuild from about 0.6 s to about 25 ms. These are measurements of that copy, not a general guarantee.

## v0.8.20 — 2026-10-13 — README dashboard, run list fixes, Codex restart recovery

- Put the live dashboard right under the results at the top of the README, and redraw its sample with the current English labels: Execution overview, Running executions, Needs review, the Past errors filter, Stage details and Execution detail. The README's dashboard guide and record table now name the same labels, the Past error state, refused worker contracts and host ends, and how to update the Codex plugin.
- Keep long run states inside the State column (#236). "Outcome unobserved" and other long labels wrap in the run list instead of running over the execution title.
- Show a generated run title in English in the Execution detail header and in the run row's accessible label, as the run list already does (#237).
- Release a Codex worker's reservation after its host restarts (#239). A reservation now records the app-server process that runs its worker. Once that process has exited, the worker cannot still be writing: its write-scope protection ends for every session, and the next hook event or `status` of its session settles it as interrupted at its turn, with a failure record, a receipt that is not an accept, and the result that `status` returns. Before, a restarted host never settled it, `status` answered that no execution existed, and every write in its scope stayed denied; a worker started from the home directory blocked writes across the whole home directory. While the recorded process still runs elsewhere, protection stays and `status` says so. A reservation written before this version has no recorded process: it stays protected and `status` explains why, and an explicit user `cancel` releases it. Job retention may now remove a file whose only Codex executions belong to exited hosts.

## v0.8.19 — 2026-10-13 — Live dashboard, native spawn models, trace retention

- Stream dashboard changes as patches (#227). The first frame is whole; after that only the runs, steps and fields that changed are sent, and a viewer whose base is stale reconnects for a whole frame. A running step carries its `startedAt` and the browser counts its elapsed time, so an unchanged step is no longer resent every 2 seconds.
- Rebuild only what changed (#226). A new record recomputes only its own session; unchanged open sessions are reused, and without new records the dashboard rebuilds only at the next moment an age label or state can change. The worker activity reader, its watched transcripts, the event list, the live board and `/api/worker-history`, which no view has used since v0.8.18, are gone from frames and the server, and the dashboard no longer computes the event list or the live board at all. A Compact selection and its result written in the same millisecond get their own step ids, so they no longer resend their run and the feed whole.
- Draw the dashboard incrementally (#228). Run rows, the call log, the run detail and the stage inspector are rebuilt only when their own data changes; rows are moved instead of recreated, keep their focus and keep the scroll position. Counters and live times write only text that changed.
- Show every recorded step as it lands (#230). Each new record of the eight circuit features flashes its node, its node strip and its run row in recorded order, including policy, host and lifecycle records; only measured Jev responses travel the rail and set the latency readout. The "Jev traffic" bar shows requests as short ticks and responses at their latency over 30 seconds. Between records a soft sweep runs along the Jev rail and the node wires flow; neither carries a record, and both stop when paused, disconnected or under reduced motion.
- Load the dashboard lighter. Frames leave out step details, routing and session/agent ids; a step's full record is fetched from the local `/api/step` when its detail opens. Large first frames are drawn in the next task and the run list is filled 20 rows at a time, so the first load no longer blocks the page in one long task. Bars of running steps in the run detail grow on the same tick as their elapsed time.
- Record the Jev model on Claude Router and Compact responses, so their steps show the same receipts as the other features (#225).
- Compare a native Claude spawn's observed model with the host's own selection (#224): the call's `model`, else the parent model for a fork or an inheriting built-in. A custom agent whose profile model the Router cannot see is recorded as unobserved instead of being compared with the parent model, and a model pin or alias remap is checked before a mismatch is recorded. Explicit mismatches are still flagged. Existing records are not reclassified.
- Separate current problems from past errors on the dashboard (#223). "Needs attention", its count, the state filter and the run detail now mean a failure that may still affect work: one whose later records of the same operation on the same host also failed, or that has no later record ("Current impact unknown"). A failure followed by a success of the same operation, or caused by the request's own arguments (`invalid_input`, `out_of_scope`, …), stays in the history as a past error and is never shown as resolved or rewritten as a success. The detail shows the cause, current impact, last observation, host and session.
- Keep a closed reason and stage for Codex dispatch failures (#233): preflight conflict, reservation unavailable, native start rejected, failed turn, interrupted or termination unconfirmed, with whether the worker never started. The tool result, its status lookups, the trace and the dashboard show the same reason, never the raw error; an unstarted worker is no longer reported as interrupted, and a worker whose end was not seen keeps its reservation.
- Show a refused worker contract as a failure (#232). Only an accept receipt means the contract was accepted; an incomplete, invalid, rework or replan verdict makes the step an error and the run "Needs attention", with a closed reason (for example a reported pass not seen in the worker transcript, or a blocked worker) and the check ids (`#n`) it concerns, never the raw reason or reply text. A later host end, stop or policy delivery is shown as its own "Host ended" row and no longer turns the run done; a later accepted retry of the same task is drawn separately, and the earlier refusal stays recorded as a past error. Both Claude and Codex records.
- Judge Codex write conflicts by what a call actually writes (#234). Patch file headers, edit targets, a leading absolute `cd` and every path a shell command names are resolved, with symlinks and `..`, and compared with each managed worker's scope, so writes in an unrelated worktree and read-only diagnostics (`ps`, `git status|diff|log|show`, `gh issue|pr view|list`, search commands with quoted patterns, …) are no longer blocked. Commands with expansions, subshells or a later directory change stay protected, and a session outside every scope keeps its shell.
- Delete trace records older than 7 days (#231). The Evidence server removes this tool's own trace files from the trace directory it writes, at most once a day per directory, in the background after it starts; other names, subdirectories and symlinks are never touched, and a failure never stops the server. A record removed between listing and reading is no longer counted as unreadable.

## v0.8.18 — 2026-10-12 — Lean and Output removed, no host debug log, run monitor dashboard

- Remove Lean entirely (#217). The Lean execution path, executor agent, hook set, `lean` pack profile, bench arms, dashboard feature, config handling and docs are gone on Claude Code and Codex. A config file, `JEV_GATE_MODE`, the `gateMode` option or a Codex `gate.mode` that still says `lean` is an unknown mode like any other: on Claude Code the Gate does nothing for that call (`config_invalid`) and `doctor` reports it; on Codex only the Gate turns off and Router and Compact keep their own settings. Router, Compact and Evidence never read the Gate mode and are unaffected. Old Lean trace records and job-state fields are read as generic history.
- Remove Output entirely, on Claude Code and Codex: the Vitest log folding Mod (`mods/output`), `src/codex/output.ts`, its hook registration, the `outputEnabled` option and manifest settings, the Codex doctor line, the `mod_output` / `claude_output` / `codex_output` trace phases, the dashboard feature, bench arms and docs. A leftover `outputEnabled`, `JEV_CODEX_OUTPUT` or old Output trace record is ignored: no other feature is turned off and nothing is written.
- Stop writing to, and reading from, the host debug log. Router and Compact keep their independent trace records (`mod_router`, `mod_compact`), which are the dashboard's only source; the `$.ui.log(..., { to: 'debug' })` mirror, the recorder's debug sink, the debug-directory reader and `CLAUDE_CODE_DEBUG_LOGS_DIR` handling in the dashboard and doctor are removed, and no setup needs `--debug`. A Router or Compact option that cannot be read still leaves that Mod off; the one-line debug notice for it is dropped rather than recorded.
- Lay the feature circuit out as eight nodes (Gate A, Gate B, planning, workers, guard, Router, Compact, Evidence) in four columns by two rows, and two columns by four rows on narrow panels, with no empty or stretched cell at any width.
- Remove duplicated dashboard views (#217). The circuit no longer carries a second, paginated record list for a run, and the run detail is the single run-step view. The stage inspector drops its model and effort rows, which stay in the model record. The sidebar (feature list and privacy note), the live event panel, the header host chip and two explanatory notes are gone, and the version badge shows only when a version is known. Selecting a stage in the live circuit now also filters the run list to that feature, and selecting it again shows all; the brand moves into the header.
- Rebuild the dashboard as a run monitor (#217). Header KPIs (active runs, Jev traffic, Jev median, needs attention) sit above an eight-node circuit hung off a Jev rail: each recorded Jev call travels from the rail to the node it decided and back, and the node's decision line updates in place without shifting its layout. The run list shows status, run, the features it used, the latest decision with its Jev reply time, Jev calls, duration and activity; a call lights the matching feature chip in the same frame. A Jev call log shows one row per call (time, run, feature, question, answer, confidence, latency, tokens, list-price cost) with Live and Pause, and the Jev response panel shows median, latest, p95, today's calls, a 60-second latency strip and a list-price cost estimate (jev-1.13.0, $0.042 per 1M input tokens; billed credit is not returned by the API, and calls on an unpriced model are left out and counted). One run detail accordion replaces the work rails and the separate timeline; a step expands to its recorded question, choice, actual reply, confidence (with the switch threshold when recorded), tokens and cost. Every node keeps a 60-second strip with one tick per record. One record is one mark: nothing moves without a record, and pause, a lost connection and reduced motion stop all movement. No per-minute rate text is shown. The snapshot feed and `latency.recent` keep every record and Jev call of the last minute (up to 1,000), so the strips never under-report past the old newest-120 and newest-16 cuts. Layouts fit 320 px to wide screens; below 1180 px the call log and Jev response panel stack. The version badge with its update check stays in the header.
- Record native Claude child routing skips (#220). A child that is unregistered, natively remembered or stopped is still passed through once with its original model and effort, and the Router now writes one `child_route` record with the reason (`child_unregistered`, `native_child`, `child_stopped`), turn, step and the loaded hook version; a recorder failure never blocks the request. The dashboard labels unregistered and stopped children and hides the per-step `native_child` records.
- Add an animated, English sample of the dashboard to the README (`assets/readme/dashboard.svg` and `dashboard-dark.svg`): CSS-only, no script, marked as sample data, and still under reduced motion.

## v0.8.17 — 2026-10-12 — Owned dispatch, Gate C removal, Evidence and dashboard latency

- Deliver eligible owned worker dispatches instead of denying them with a generic "could not be verified" message (#211). A dispatch policy that exits non-zero or prints malformed output is reported as unavailable, an unstarted reservation is released once, and a concrete denial survives budget expiry and the baseline check. Every Router denial is recorded as a `spawn_denied` event with a categorical reason (`policy_unavailable`, `policy_denied`, `target_unsupported`, `target_restricted`, `target_not_allowed`, `subagent_model_pinned`, `no_eligible_model`, `restricted_baseline`, `unverified`).
- Stop showing past model requests as running when no response was recorded (#212). A request without its exact response is closed by a later turn or session end of its own loop: an aborted turn shows as interrupted, any other end as unconfirmed. A loop that has been quiet for ten minutes is no longer asserted live. Sibling, root and other-session ends never close a request, and elapsed time alone is never treated as a failure. Claude and Codex share the rule; Router turn and session ends are now flushed to the debug log.
- Remove the remaining Gate C code (#213). Worker acceptance is deterministic: the worker reports done, raises no blockers and every required check ran and passed exactly once. The Gate C question, request builder, decision function and `ResultVerdict` type are gone. `resultConfidenceFloor` is no longer a setting; an existing config file that still sets it loads and the key is ignored. An `advisory` on an old stored receipt is read as history only.
- Keep dashboard snapshots and live updates fast while records keep arriving (#215). Slow `/api/snapshot` answers were requests waiting for the rebuild in flight; with records arriving continuously the next rebuild started before the last one finished. A snapshot now returns the current frame at once while the live stream keeps it fresh (the first load still waits, and with no live viewer a snapshot still refreshes first). Rebuilds are incremental per session: a session whose last record is older than ten minutes and unchanged is not recomputed, newer trace files are appended without a full re-sort, and a record that arrives during a rebuild starts the next one as soon as the throttle allows. The incremental result is byte-identical to a full rebuild on a copy of real data (30/30, including clock jumps and host filters). On that copy (about 67.5k records, a new record every 200 ms, load average 11–15, 40 samples): snapshot p50/p90/max 243/1034/1345 ms → 18/32/105 ms, live-update lag p50/p90/max 2.2/3.1/>3 s → 0.96/1.36/2.37 s, one rebuild 907 → 412 ms median.
- Make Evidence find symbols anywhere in a large repository and let Claude Code use it (#216). Before reading, one `git grep -F -l` over the whole scope (started with an argument list, never a shell) picks the files that contain the symbol or term; if Git fails or its output is too large, files are read in path order as before. A capped or time-stopped search returns `next.cursor`, sealed to the server process, the request and the matched file list; a tampered, foreign or mismatched cursor is `invalid_input` and changed files are `source_changed`. Credential-like windows are returned as `omitted_secret` references in searches and read-backs. The schema change is additive (`cursor`, `next.cursor`, `coverage.filesMatched`, `omitted_secret`, `source_secret`). The Evidence skill is no longer hidden from the model, and worker and planner definitions name `jev_evidence` for use when the host lists it. On a 5,369-file frontend repository, four exact-symbol lookups that returned nothing (200-file cap reached) now return their definition in one call, reading one file; Git adds about 120 ms per call. A Git run that misses the 3-second budget under heavy load returns `deadline` without reading, and the same call can be sent again. Token or time savings for users were not measured.
- Publish the pre-registered Lean-versus-native episode comparison (#214) in `bench/results/lean-vs-native-2026-09-27`. On three episodes with follow-up turns, Lean cost 2.6–8.2 % more than native Claude Code and took about 18 % longer; no episode reached the 15 % saving threshold. The contexts were small (about 30–35K tokens), so the episodes do not cover long sessions; an offline upper bound on real usage traces does (every threshold policy cost more on Claude, an oracle saved at most 7.7 %). `auto` is unchanged, and Lean will be removed in a following release (#217).

## v0.8.16 — 2026-10-12 — README, pilot results, dashboard header and responsiveness

- Rebuild the README around installation, a measured long-session pilot and how the features fit together. The pilot (two real tasks, 17-turn sessions, one pair each, blind-graded) is reported with its method, per-cell data and limits in `bench/results/long-session-pilot-2026-10-12`; it is a direction, not a guaranteed saving.
- Lead the README with a results chart (`assets/readme/results.svg`, with a dark variant) and a one-paragraph summary of the pilot, so the measured outcome is the first thing a reader sees.
- Replace the brand mark with a router mark (one line in, three lanes out, the chosen lane in the accent color) in the README, the dashboard rail and the favicon. The README hero stacks mark, name and tagline centered, ships light and dark variants, animates briefly and holds a static frame under reduced-motion preferences.
- Show a "Jev credit exhausted" badge in the dashboard header when Jev answered 402 and no request has succeeded since; it clears on the next successful answer. Jev 402 responses are reported as `http_402` and labelled as exhausted credit in run steps instead of a generic failure.
- Align the dashboard header: breadcrumb, host label, version badge and connection status sit on one baseline with consistent spacing and pill shapes. The version badge no longer touches the host label.
- Keep the dashboard server responsive with a long history (#210). Snapshots are rebuilt on a separate activity thread, one at a time and shared by every viewer and snapshot request, from trace files read concurrently, and each frame is serialized once for all viewers. Health checks, heartbeats, shutdown and directory changes no longer wait behind a rebuild. On one machine with about 63k local records, `/api/health` answered within 19 ms during the first build (previously 5–6 s), and the first Claude frame arrived in 1.9 s (previously 5.3 s). A rebuild after a new record still takes about a second, now off the server thread. A newly attached directory watcher is followed by one full re-check, since the OS can miss changes made while it starts.

## v0.8.15 — 2026-10-08 — Doctor and native model compatibility

- Group Claude and Codex diagnostics by runtime, package, host, configuration, model/effort compatibility, credentials, storage and activity. Print concrete next actions, a concise summary, JSON or verbose details; repeated calls use independent reports.
- Read native Claude SDK initialization metadata and Codex App Server model/list without submitting user messages, threads or inference turns. Check current routing targets, configured owned profiles, CLI alias resolutions and every offered effort; missing or incomplete inventories remain unverified. CLI capability compatibility does not prove account access or paid execution.
- Share Claude minimum-host introduction facts for Opus 5.5, Fable 5.1, Sonnet 5.5 and Haiku 5.5 with the Router and PR model synchronization. Never approve a retired alias merely because its family matches.
- Inspect packaged hook/MCP definitions, readable files, storage paths and bounded local dashboard/connection health without restarting workers or changing native trust. Preserve unknown runtime/application state and keep credentials out of reports.
- Keep Lean diagnostics independent of inactive Gate floors and tier models on both hosts, while retaining active Router capability checks. Malformed or conflicting native catalog rows remain unverified rather than becoming false compatibility or incompatibility.
- Absorb native Claude cancellation notices delivered before transcript flush using the exact queued envelope, prior turn identity and structured background launch receipt. Copied XML and subsequent human work still enter normal admission. Verify completion and cancellation with the latest native Claude CLI on every PR.
- Keep the running dashboard version visible at the top with official latest-release status and installed Claude version mismatches. Bound and cache public GitHub checks; offline, invalid and rate-limited results remain unknown. Doctor checks updates only with --check-update.

## v0.8.14 — 2026-10-08 — Cache accounting and worker recovery

- Match native Codex model responses to their exact session and request even when the host provides no prompt ID. Completed requests stop appearing as active, and submitted model rows can display their observed response model. Known and unknown prompts remain separate; unrelated and earlier responses do not settle a request.
- Track bounded per-model cache observations and provider-specific input, cache and output accounting. Preserve unknown TTL, thinking and request identity; separate API list estimates from subscription billing. Check official price revisions on every PR. Aggregate worker usage cannot establish per-request price bands and remains unpriced.
- Bound Claude's effort floor to the existing 55-minute fallback when native usage omits TTL, without reporting a known cache lifetime. Normalize model cache keys and restore root and child protection after an observed miss, including a miss after an earlier hit.
- Route owned Codex worker continuations after closed native tool pairs against their original contract and NEXT inference. The first request retains Gate B. Retries reuse an exact decision while rechecking current configuration, catalog, native settings and effort compatibility. Encrypted reasoning keeps its model and history while allowing same-model effort judgment; Lean executors remain excluded. Record the bounded step limit explicitly. Native effort updates retain their original history and do not inherit an earlier route's application record.
- Deliver an idle background result once, then close a generation if its delivery turn ends without another dispatch. New human requests return to Gate A; copied notification markup does not suppress them. Active reservations and native terminal requirements remain unchanged.
- Admit new human requests immediately after cancellation or Lean completion, including closed generations without a delivery marker. Record idle policy delivery separately from a stalled execution, using the last reservation's release time when known.
- Remove duplicated single-worker handoff text only when admitted-source provenance agrees. Record available Claude delegation price components, charge cold source reintroduction as a write and exclude shared existing context from future delegation benefits. Model-switch scenarios identify unknown return and handoff costs; missing future output, reread, startup or horizon evidence preserves the existing policy rather than inventing a saving.
- Load checked-in price facts through TypeScript in native Claude Function Hooks and register session compaction once in the integrated plugin. Keep live dashboard timeline rendering bounded to its latest 100 events with existing paginated history.
- Extend the paired benchmark with frozen follow-up turns and cache waits. Compare session cost separately from task tokens, deduplicate exact Jev intent/result bindings and require request-bound confirmation for nonbaseline models. Unbound cells remain diagnostic; this release does not establish measured net savings or close the paid acceptance criteria in #202–#205.

## v0.8.13 — 2026-10-08 — Current models and PR freshness checks

- Add Haiku 5.5 with its documented 1M context, output limit and effort support. Resolve the API Haiku alias on Claude Code 2.1.293 and later, and check the host version and account allowlist before root, spawn and worker-step switches. Offer only effort levels valid under the retained thinking mode.
- Exclude previous generations from new automatic Claude targets and Codex targets/tier defaults. Preserve historical identity records and native pins. Recheck stored Codex routes and owned worker dispatches against the current catalog before execution.
- Check official Claude model/effort metadata and the OpenAI Codex catalog on every PR. Stale metadata fails CI and produces an update patch; missing sources, unknown schemas, roles or effort support fail explicitly. Validate the plugin and current Haiku request pairs with the latest native Claude CLI using isolated scripted APIs. No scheduled runs or automatic releases.
- Keep background worker activity open after an unconfirmed parent-call failure. Read unfinished child tool activity before applying the inactive-worker history cap, so fresh work does not disappear behind older trace timestamps.

## v0.8.12 — 2026-10-07 — Live worker execution rails

- Rebuild the execution circuit within the existing dashboard design: ten feature stations, independent execution and worker rails, observed request/response pulses, and explicit current stages. Active executions remain visible outside the selected time window. Pause, disconnection and reduced motion stop animation; historical selection and scroll survive live updates.
- Show Claude worker internals from exact trace-observed native identities. Display safe tool names, action labels, file targets, timing, errors and response model metadata. Paginate full tool and inference history, including responses with no tool calls. Keep large histories out of the live DOM and mark partial or unavailable evidence explicitly. Conversation text, command arguments, source, tool output and thinking are not copied into dashboard snapshots.
- Keep one automatic dashboard owner and reuse its browser connection. Concurrent startups, reloads, reconnects and same-port upgrades do not open duplicate tabs; the owner opens a replacement when its last viewer leaves. A slow health probe cannot replace a live owner.
- Reassess Claude workers before each subsequent model inference with Jev, using their original contract and recent tool outcome labels. The first inference retains Gate B or spawn allocation; tool execution itself does not invoke a model. Preserve native pins, unknown context compatibility, cancellation and timeout fallback. Lean remains eligibility-only. Record each selection separately from the actual submitted request and response model.
- Reconcile verified host-authored completion notifications when a Claude child transcript omits its final stop reason. Release the original reservation without treating a launch receipt or copied notification as completion. Record denied dispatches and worktree creation in the execution history.

## v0.8.11 — 2026-10-07 — Readable real-time traffic

- Show directional receipts for observed requests and responses in independent feature channels, including calls that complete quickly. Strengthen active signal contrast and retain motion phase through updates. Completed Gate paths no longer animate because of an unrelated active host tool.
- Separate live feature overview from selected execution. Identify disconnected snapshots, freeze clocks at pause/disconnect without jumping backward, and preserve failed settings-save notices through updates.
- Improve circuit typography, touch targets and mobile stage inspection with a return control. Correct the observed English translation gap and remove repeated elapsed-time screen-reader announcements. Verify responsive layouts, themes, languages, keyboard access, reduced motion and 60 Hz signal samples.

## v0.8.10 — 2026-10-07 — Live host progress and shared frontier routing

- Redesign the execution circuit as a decision tree and independent feature lanes. Move signals continuously along observed active paths, preserve their phase across live updates, and pulse newly recorded transitions. Show each host’s current work and elapsed time; consolidate Jev latency into one strip and remove repeated stage summaries, event ribbons, receipts and metric cards. Keep all widths free of horizontal scrolling; pause, disconnection and reduced-motion preferences stop animation.
- Record actual model-request starts and host failures, including Codex requests whose routing preserves the baseline. Match termination by request identity rather than a short elapsed-time threshold.
- Separate verified API request settings from observed response models. Join later Codex responses only to the exact session, prompt and request, and leave missing response facts unknown.
- Add a shared `frontierEnabled` switch, default off, for automatic Fable and Astra routing at supported efforts. Explicit OFF overrides legacy host opt-ins, and policy boundaries recheck it before submission. Feature-only config files retain the host's default Gate mode.
- Report unclear, invalid and low-confidence Router decisions accurately instead of calling them user model locks (#194). Refresh README and verify dashboard layouts in both languages, themes and mobile widths.

## v0.8.9 — 2026-10-06 — Aligned execution panels

- Execution list, timeline and selected-result panels share their desktop height and scroll independently. Tablet panels align within each row, while mobile sections retain bounded readable scrolling.
- Model facts follow the selected timeline stage and identify their event/time. Selection-only and submitted-request records explain why a response model is unavailable; another stage cannot supply a fabricated match.
- Inspecting timeline stages preserves keyboard focus and scroll position, including stages deep inside long executions.
- Dashboard upgrades release the listening port before acknowledging shutdown, avoiding a replacement server startup race while reusing the existing browser tab.

## v0.8.8 — 2026-10-06 — Task-aware compaction

- Compact in Claude Code and Codex now uses one bounded Jev current-task dependency batch before extractive packing. It prioritizes at most 16 optional old successful observations at the same configured budget; mandatory text, failed/unknown results and the paired native tail retain their existing rules.
- Selection defaults on with a 1,000ms deadline and explicit on/off controls. Invalid judgment, missing keys, secret input and optional key-read errors preserve local extraction; cancelled and superseded generations do not apply late selection.
- The dashboard distinguishes Compact's actual Jev calls, candidate coverage, selected dependencies and latency from local packing and native installation. No general quality, latency or billing savings are inferred from digest size.
- Native Codex code-mode terminal command results are recognized without executing or evaluating their scripts; ongoing, compound, forged and unknown results stay whole. Oversized selection batches offer fewer complete candidates and record coverage (#177).
- Diagnose API request model/effort discrepancies separately from response-model mismatches, Jev errors and native failures. Show event counts and times, and exclude historical errors outside the selected time range (#178). Keep forwarded native Compact requests separate from root Router model/effort observations and cache/context accounting; a native summarizer request is not evidence of a root route mismatch.

- Review the dashboard across desktop/mobile, both themes and languages, live updates and keyboard navigation. Show Compact selection evidence in the circuit inspector, describe missing request facts accurately, contain long summaries, and keep the four metrics in balanced rows. Simplify installation and operational guidance in README.
- Build the Lean package test in its own temporary source tree so it cannot delete the distribution used by concurrent host tests.

## v0.8.7 — 2026-10-06 — Routing evidence and responsive dashboard

- Observe completed Codex Responses even when the native upstream omits Content-Type. Decode compressed observation streams and handle all SSE line endings and split UTF-8 without altering native bytes; missing response models remain unknown (#173).

- Re-read exact native terminal evidence briefly when Claude fires SubagentStop before the final transcript row is flushed. Settle the original background reservation without accepting launch receipts or unverified hook text (#168).
- Allow a valid effort downgrade after the host explicitly reports zero cache read and zero cache creation. Positive and unknown cache usage retain the existing cache protection; no quality or savings claim is inferred from this policy repair (#172).
- Use the final reserved Gate B model for planner agreement, worker receipts, failures and background launch observations. Historical trace views prefer the recorded final allocation over legacy tier labels; actual response models remain separate and real mismatches remain visible (#164).
- Show Router scope, baseline and keep/change reasons beside the matching response. Distinguish cache-preserved effort from proposed effort, and host-forwarded effort from unreported response effort. Treat `prepared` as request preparation metadata, not a new Jev judgment or completed model response (#166).
- Match request preparation to the same child identity as well as session, turn and loop index. A sibling response cannot close a pending root or child preparation (#171).
- Show a Codex proposal that was not applied separately from the final model, with its recorded probability and change threshold. A session that already used Luna is not counted as an automatic downgrade (#169).
- Record native agent creation outcomes when Router keeps the original request. Preserve native pins, refusals and unknown effective requests without inferring a model or spawning twice (#167).
- Share dashboard watchers across viewers, update changed trace files incrementally, and reconcile missed notifications and directory replacements periodically. Remove quadratic Router closure lookup, retain complete historical totals, and keep malformed/oversized/symlink records excluded (#165). Synthetic performance checks do not establish paid-provider savings.
- Replace an authenticated older dashboard at its existing loopback address without opening another browser tab. Require successful shutdown before starting the replacement (#170).

## v0.8.6 — 2026-10-02 — Routing instruction clarity

- Clarify that no-delegation instructions keep work in the main session without pinning the main model or effort. Explicit model and effort pins remain independent. This corrects the v0.8.5 README; execution policies are unchanged.

## v0.8.5 — 2026-10-02 — Direct worker execution and routing parity

- Track bounded owned worker calls in direct conversations in the shared hook. Claude and Codex now reserve the execution before Gate B, apply the selected exact model/effort pair, keep background questions responsive and settle the original subtask once. The main request stays direct and is not marked complete by a subtask receipt.
- Derive Codex product roles from account-listed model descriptions. Known Luna/Terra downgrades use the same existing confidence and consequential-risk rules as Claude; workhorse/frontier upgrades retain the stricter floor, unknown roles remain unknown and Astra stays opt-in. Supported effort still comes from the actual account catalog.
- Distinguish explicit model/effort pins from read-only, file, API, permission and check constraints in the shared Jev question. Live Jev probes now select a fresh Haiku/Luna worker for a bounded read-only lookup while respecting explicit pins; uncertain upgrades still preserve the original pair.
- Return execution identities for uncertain Codex termination/settlement. Status can recover foreground and background results after a state commit fails without restarting execution; parent ownership and terminal-before-release protections remain enforced.
- Reuse unchanged trace records and share dashboard scans across viewers instead of repeatedly reading full history for each connection. Keep immediate file notifications, fallback rescans, symlink rejection and explicit malformed-record reporting. Fix recent-period measurements, visible feature search, source-unavailable wording, English copy and filter accessibility. Retain recent Jev observations through busy tool/policy loops and avoid claiming an old launch is still running. Remove repeated latency cards/charts and the duplicated execution strip.
- Add native CLI/scripted-provider regressions for direct Haiku/Luna execution and shared threshold/risk boundaries, plus state-write failure and result recovery. Re-run both native host suites, responsive workers, permission/cancellation paths and the browser dashboard. Scripted inference is separate from live Jev classification and does not prove paid-provider quality or savings. The current Claude root-Haiku host limitation remains explicit.

## v0.8.4 — 2026-10-02 — Discoverable workspace targets and fast-worker admission

- Treat the current repository, branch, PR and diff as targets discoverable through native workspace tools. Gate A and the shared Router question no longer require a supplied PR URL or file list for those targets. Missing earlier decisions still preserve native execution.
- Classify complete bounded tool outcomes with typed `bounded` / `other` / `unclear` choices instead of a compound truth statement requiring user-specified checks. Keep the existing 0.8 support, context/delegation/depth checks and one-worker execution. Mechanical PR description updates and complete lookups can use Claude Haiku or Codex Luna through the fast profile.
- Record the proposed Router patch separately from the final cache-preserving patch and explain retained root effort in both dashboard languages. Cache protection and the current Claude root-Haiku compatibility limitation are unchanged.
- Verify the reported Korean PR-description request with live Jev classification and actual Claude CLI/scripted-provider execution: fresh Haiku requests omit effort, write a local description fixture, run a check after the edit and reach contract acceptance. Verify native Codex fast-worker execution and root denial. Scripted-provider checks do not establish paid-provider performance or measured savings.

## v0.8.3 — 2026-10-02 — Native dispatch repair and cache-aware routing

- Route self-contained bounded searches and mechanical tool outcomes to one fast worker without a planner, using one extra fact in the existing Gate A batch. Preserve context, no-delegation, shape and depth constraints. Negative legacy cost estimates remain visible; this execution preference is not a measured saving. Native Claude coverage observes an automatically admitted Haiku worker running an actual repository search with no effort parameter.
- Recognized explicit English/Korean no-delegation phrases keep the request in the main session before Jev or forced benchmark admission; other wording retains semantic judgment and native user authority. Guard reminders preserve the worker role selected in coordinator guidance.

- Fix Claude Agent schema failures: command hooks send a valid family token, while native inference receives the exact Gate B model ID and conditional effort. Connect dispatch through the native plugin directory API, handle symlinked plugin entrypoints, and propagate Fable authorization from the actual plugin option, including when Router is off.
- Connect documented Claude product roles to existing direction thresholds: known downgrades use 0.6 with control/risk checks; upgrades, same-role version changes and unknown relationships retain the stricter floor. Prefer Haiku for bounded simple workers and account-listed Luna for Codex's fast role. Versions remain separate candidates.
- Resolve missing effort through effective host settings; preserve numeric controls and explicit pins. When the current effort is outside the chosen model's scale, use its conditional distribution's existing strict-confidence quantile. Haiku omission no longer blocks a subsequent Opus/Sonnet turn. Each new user turn reassesses; tool steps reuse only that turn's valid result. Retired root responses and delayed completion cannot overwrite newer cache observations or completed visible context.
- Supply observed previous-request cache counts and age to the existing Jev batch. Model choice considers the cost of rebuilding a long root prefix; cached input is not a current context-fit proof. No extra inference, paid token-count probe, cross-turn decision cache or global model setting is added. Actual cost savings have not been measured.
- A smaller-window root requires a current complete-request upper bound, output room and compatible host transformation. Claude 2.1.287's context summary is only an estimate, so Opus/Sonnet to Haiku root switching remains limited; fresh Haiku workers are verified separately. Synthetic compatibility tests are not live Haiku root support.
- Explain baseline/pins, actual loaded hook version, exclusions, direction/threshold and effort interpretation in existing records/doctor. Dashboard separates selected, dispatched/requested and response-reported effort; missing response effort is explained and explicit omission is retained.
- Add actual isolated Claude CLI/scripted-provider regressions for Agent validation, all four families, exact versions, effort omission, Opus-to-Sonnet root requests, successive root turns, and main responsiveness during delayed worker completion/cancellation. Retain native Codex, packaged Function Hooks and browser regression coverage. These checks do not establish paid-account coverage, Jev classification quality or token savings.

## v0.8.2 — 2026-10-02 — Full-catalog Router and responsive background workers

- Router v2 (#143–151): actual model IDs across the full eligible catalog, candidate-local effort questions in one bounded batch, max/none/omit semantics, independent pins and preservation of the original root execution.
- Automatic Astra/Fable targets now require the existing host-specific boolean opt-in (default OFF), enforced on ordinary children, Gate B, retries and Lean inheritance even with Router disabled. Manual restricted roots remain usable.
- Managed and ordinary Codex share bounded completed-answer/human context. Unsent settings/catalog changes cancel stale patches; submitted values and actual response observations are separate. Optional recording failure cannot change execution.
- Gate B allocates actual model/effort pairs in its existing call. Added native Function Hooks and Codex scripted-provider regression coverage, packaged shared policy sources, doctor diagnostics and updated user documentation.


- Owned planners, workers and Lean executors run in the background by default. Main conversation questions retain the original job and contracts while work continues; launch receipts do not count as completion.
- Claude accepts results only after matching native execution identity, profile and transcript termination. Successful native TaskStop ends ownership without accepting success. Main wait interruptions, malformed terminal evidence and connection uncertainty preserve reservations; retired results cannot advance a new job.
- Codex supports nonblocking `jev_agent` status/result collection and explicit cancellation. Native terminal events commit results against the original contract. Root interruption leaves background workers running, and planner/Lean terminal settlement uses its own result path.
- The complete old Jev-generated foreground setup migrates automatically. Customized host overrides and permissions stay authoritative; an already running Claude host needs a restart to load the new launch environment.
- Dashboard metadata connects background preparation, actual launch, continued conversation and termination to the original execution. README and native Codex guidance explain the interaction and its observed limits.
- Verification includes real installed Claude and Codex processes with delayed local fixture models and native check commands. These tests establish lifecycle behavior, not paid-account availability, long-term reliability, speed or savings.

## v0.8.1 — 2026-10-01 — Recorded execution circuit and automatic dashboard

- The execution circuit leads the first screen, separates Gate's direct/worker/planned paths from independent policies and Lean, and adapts without horizontal scrolling. Selecting a stage opens a local inspector; selecting an execution scopes the circuit and its recorded transitions.
- Cards and inspectors expose the latest recorded result, host, timing, Jev choice distribution and selected/observed model and effort. Errors, unobserved outcomes and user interruptions remain separate. Only new linked records in one execution animate; filtering or unrelated concurrent runs never invent traffic.
- Claude Router, Compact and Output record private metadata without `--debug`. Both hosts share live recording and automatic-dashboard switches, enabled by default. The installed MCP starts one shared dashboard and opens the browser once, reuses concurrent hosts and replaces older builds. Fixed the integrated Claude MCP's dashboard root path.
- Optional metadata recording cannot stall host execution when its filesystem or clock fails. Native model variants and dated aliases retain Router identity confirmation; failed Jev assessments are distinguished from the preserved host request.
- Codex delayed tool results reconnect to their original calls. Explicit exit codes and MCP errors are recorded, missing tool receipts remain unknown, and generic host events do not count as feature execution. Claude child response receipts no longer duplicate root responses.
- Browser E2E covers viewport/theme/language layouts, path geometry, keyboard focus, selection, live transitions, pause/resume, reduced motion and failed preference writes. Packaged native Claude tests verify Router's selected model at the actual provider request without `--debug`; fixture-backed tests are separate from paid-account and long-term product effects.

## v0.8.0 — 2026-10-01 — Automatic setup and open defaults

- Claude Code prepares required launch settings and recording paths automatically. Both hosts open a local API key screen and share the private credential; no shell export or project policy file is required.
- Main model routing, manual compaction, plan interpretation and parallel snapshot worktrees are enabled by default. Up to 16 workers and 64 planned tasks, a depth floor of 0 and an open root tool list retain native host permission handling.
- Worktree snapshots include staged, unstaged and untracked working files without changing the root HEAD or index. Codex derives tier models from its live account catalog. Claude Router retries a missing key after local setup without requiring another session.
- Fixed #137–#140: Codex Compact preserves matched failed/unknown results and full prior summaries; Gate A context retry shares one absolute hook deadline; uncertain Codex starts retain reservations until genuine terminal settlement; saturated Router history excludes unapplicable child effort questions while preserving model routing.
- Initial host restart and native hook trust remain host requirements. Fixture-backed native tests do not establish paid-account model access or long-term product effects.

## v0.7.1 — 2026-10-01 — Automatic native Codex connection and benchmark fixes

- Ordinary native Codex now connects automatically after plugin startup: no Jev launcher, workspace export or project setup file. Native login/hook trust stays authoritative; already open hosts need a fresh session to load the provider.
- Added caller-scoped Evidence, native permission inheritance for owned workers, real wire context for Lean, actual Responses Router application, helper crash recovery/concurrent ownership and removal restoration. README, dashboard support explanations and packaged skill now describe this workflow.
- Tight native runtime coverage includes the ordinary connection, Gate/Lean/Compact, crash recovery and concurrent sessions. Unsupported metadata and unknown observations preserve native execution; no simulated policy success or token savings.

- Gate A tells the user, via `systemMessage` and not model context, when it was skipped because the session depth could not be read (`depth_unknown`): the first prompt of a session and every headless `claude -p` single turn. Single-prompt automation never reaches the gate; the behaviour is unchanged, the silence is not (#114).
- Gate A re-asks once with the last three user-typed turns from the transcript when a prompt reads as `needs_context` on its own, so a long task that arrives as a short follow-up ("e2e 해봐") can still be delegated. Only user-typed text goes; tool results, host messages, commands and anything that looks like a secret do not. The second record carries `context_turns` (#115).
- `doctor` warns when `CLAUDE_CODE_DEBUG_LOGS_DIR` is set neither in the shell nor in a settings `env` block: Router, Compact and Output decisions are then not recorded and the dashboard's cards for them stay unavailable (#117).
- The dashboard shows its own build version next to the installed plugin version and flags a mismatch, since the process is fixed to the build it started from (#118).
- `node dist/bench/ab.js run|report`: the paired A/B bench harness moved into the package. Two-turn cells, rotated condition order, hard timeouts, permanent output directory, git-managed worktrees, per-cell start times, priming tool count, cache create/read split and the paired-sign verdict. `--model` is required and checked against each cell's transcript (#133); per-cell model, priming/task effort (#132) and Gate A's own turn estimate beside the measured tool calls (#135) are columns. Caveats for reading its numbers are in `docs/bench-ab.md` (#121–#135).

## v0.7.0 — 2026-09-30 — Native Codex policies and bounded preparation

- Native Codex plugin and terminal launcher connect the official App Server to the real terminal. Gate A/B, plans, dependency readiness, observed check acceptance, root guard and the separate Lean executor use the shared core and existing agent instructions.
- Codex routing supports the full live account catalog, including GPT-6/6.1 and Terra, and model-specific max/ultra efforts. Native workspace backend and residency routing are preserved. GPT-6 Responses Lite tool definitions are handled during local compaction.
- Router applies official turn settings using the account's actual model/effort catalog and records selection separately from the outbound native model request. Compact installs the shared extractive digest through Codex's local compaction lifecycle; media, encrypted or incomplete context falls back to native compaction.
- Bundled Evidence MCP, conservative Vitest Output folding, metadata-only lifecycle recording, doctor and all-feature live pipelines. A standalone plugin session explains how to connect automatic policies. The dashboard never equates host spans with Jev latency, spawned agents with accepted work, or digest bytes with measured savings.
- Native runtime tests use actual Codex processes with a disposable installed archive and local scripted provider: root denial, accepted/rejected worker checks, dependent plans, Lean input, cancellation, automatic/manual compaction, Output and Evidence. Native approvals are forwarded unchanged, permissions are inherited, and workers cannot start nested coordinators. Additional runtime checks cover denial-budget interruption, read-only execution and planned-worker worktree isolation.
- Build and install the separate `jev-gate-codex` archive; review/trust `/hooks`, then start `node <plugin>/dist/cli.mjs codex`. Tested with Codex CLI 0.158.0 and 0.159.2. No persistent host configuration edits or new daemon. Claude Code and Codex apply the same shared Gate/Lean rules.


### Policy and latency fixes (#107–111)

- Gate B uses six task facts: uncertainty preserves the called profile, specific difficulty upgrades fast/standard to deep, and deep/frontier are retained. Fast requires clear mechanical or specified work, fixed interfaces, stated checks and negative difficulty evidence.
- Atomic Gate A checks self-contained request context and validates the raw five-bin Score distribution. Normalized cost support is separate from the existing point estimate and cost formula. New single jobs require the complete original request; a packet that cannot fit returns work to the root without spending a worker attempt or Gate B call. Stored jobs retain legacy delivery semantics.
- New auto/atomic jobs at concurrency 1 use one worker without a planner, with three Gate A questions. Auto above cap 1 uses five questions and the existing parallel/size rule; fixed hierarchy remains available. Actual request keys, selected shape and observed application are distinct in diagnostics.
- Claude Router's default 800ms budget covers all preparation, including host reads and application checks. Missing child mappings proceed immediately in native mode, late mappings cannot revive them, and the cache policy neither forces past effort above today's baseline nor pays for a request that cannot change settings. Native streaming and permission handling remain unchanged.
- After terminal acceptance with no active agents, the root guard releases for remaining checks, integration and reporting. Result guidance reuses observed checks on the same state and distinguishes them from the worker report and full requirement coverage. Worker profiles explain planned check IDs versus actual command IDs on a single dispatch. Dashboard records separate Router preparation time from Jev response time and show root handoff reasons.


## v0.6.6 — 2026-09-29 — Live operations across the plugin

### Added

- The local dashboard now shows separate, chronological runs for Gate A, Gate B, planning, worker dispatch and acceptance, the root guard, Lean, Router, Compact, Output, and Evidence. It distinguishes a Jev request from Jev's answer, the code's decision, and the host's observed result. A missing result is marked unconfirmed; missing usage is unknown, not zero. The feature grid says whether each record source is configured or has actually emitted an event.
- The Evidence MCP server writes metadata-only start, local result, cache, remote intent, and remote result records to `JEV_GATE_TRACE_DIR`. Router, Compact, and Output emit in-flight start records to the host debug log before their respective work. Planner and worker dispatches carry their requested tier/model; accepted plans carry a bounded dependency graph and required-check counts. The dashboard never reads source text, prompts, job files, or keys.
- The SSE stream now updates when any feature's record changes, including Compact, Output, and Evidence events that leave the legacy single-turn view unchanged.

### Fixed

- A single worker whose reported passing checks used only a display suffix gets one same-tier evidence-format retry. The refusal names the closest executed command, and worker prompts require the exact check command. Strict acceptance still requires an observed passing exact run. When the single-worker attempt cap is reached, the root guard is released so the root session can finish the remaining work.
- All seven planner, worker, and lean executor profiles inherit the host's tools and connected MCPs. The root guard permits `ToolSearch` when MCP use is enabled; `guardAllowMcp` no longer vetoes delegation to a worker. Connector work is no longer reserved for the root. A Claude Code 2.1.284 host probe observed `jev-gate:worker-fast` call `ToolSearch` and a test MCP directly.

### Upgrading

- Set `JEV_GATE_TRACE_DIR` for Gate and Evidence records and `CLAUDE_CODE_DEBUG_LOGS_DIR` for Router, Compact, and Output records in the host's `env`, then restart the host and open `node dist/cli.js dashboard`. Previously unrecorded events cannot be reconstructed. Restart Claude Code after updating so the seven agent definitions reload with inherited host tools.

## v0.6.5 — Watch a call while it is in flight

### Added

- **A loopback page shows the open call.** `node dist/cli.js dashboard` serves `http://127.0.0.1:4731/` and watches the trace directory and `jev-router` lines in `CLAUDE_CODE_DEBUG_LOGS_DIR` (the shell env, then the same settings env the host would give a hook). An intent file with no result yet stays on screen as in flight, and the result file replaces that stage. The page copy is Korean. It does not call Jev, and it does not read prompt text, the API key, or job files. Evidence calls are not in those records. Without a trace directory the page waits on that note.

### Upgrading

- No config change. From a built checkout, run `node dist/cli.js dashboard`. An installed bundle has the same command at `node <plugin-dir>/dist/cli.js dashboard`.

## v0.6.4 — Checks follow the command, evidence stays bounded

### Fixed

- **A reported check passes only when that same whole command ran and the host marked the run successful.** Spaces
  between words can differ. Quotes, escapes, extra arguments, a different program, an environment assignment, `cd`, a
  pipe, `||`, and `;` do not make it the same command. A pure `&&` list can count when the whole list succeeded. If
  that list failed or its result is unknown, the check stays unconfirmed, and an older pass is not reused.
- **A required pass that started before the last observed Edit, Write, MultiEdit, or NotebookEdit no longer completes
  the task.** The receipt stays incomplete: `check <id>: 마지막 관측 변경 이후의 검사 결과 필요`. Run that check again
  after the edit. An optional check does not block. A Write or Edit whose result was not observed also leaves the pass
  unconfirmed. An edit made inside Bash, by another editor, or by another process is outside this comparison.

### Changed

- **Gate A's tool-call map is `[4, 6, 6, 26.5, 51.5]`.** Each entry is an estimated root-turn count for that bin, not
  the tool calls one request will make, and a fractional score is still read between neighbours. With the default
  coordinator (11 turns) and worker (40,000 tokens) constants, the derived depth floor is 50,865 tokens, up from
  48,980, because the largest bin is smaller. `costModelFloor()` still computes it; an explicit `delegationDepthFloor`
  still wins, and `saving_tokens <= 0` still stays direct. The bins are an owner-supplied recalibration. The samples
  that motivated them are owner-reported model-based estimates, not a measured bill. Vetoes and admitted shape are
  unchanged.
- **A locate search with more than 128 unique lexical terms is an input error before any source read or Jev call.**
  The cap lives in `LIMITS.lexicalTerms`. Without `queryTerms`, terms still come from the goal. With `queryTerms`, only
  those hints are lexical; the goal and constraints are not cut and are still sent for semantic judgement. Derived
  terms over the cap are the same error, not a silent first 128. Candidate generation uses the request's existing
  deadline, cancel signal, and an event-loop yield. The 1,024-candidate cap is applied while collecting, in file and
  line order, and only that bounded set is score-sorted. Stopping at the cap, or before the rest of the files were
  checked, is `partial` (`source_limit` or `deadline`) and is the prefix actually processed. A search-budget stop does
  not start Jev on that page; files already chosen may still be re-read while the total deadline and the verify
  reserve remain. Once the total deadline has expired, no new re-read, HTTP, or retry starts. Caller cancellation
  starts no new read, HTTP, or cache write and stays `cancelled`. The snapshot id is `jev-evidence-candidates-2` and
  does not include a deadline timestamp.
- **Doctor names where the evidence config came from** (`explicit` when `JEV_EVIDENCE_CONFIG` is set, `session`
  otherwise) and says a changed file applies only after this server process restarts. An invalid explicit file stays
  `unavailable_config` and does not fall back to the session worktree. `remote: false` stops only Evidence's TypeSafe
  sends. Local reads continue. That is not Claude offline, and a Native Read deny is not inherited. Exclusions are a
  filter, not a retention or approval control. Key presence is not key validity.
- **Checked on Claude Code 2.1.284: an unset `gateMode` is not exported to hooks**, so it does not override a config
  file `off`. An explicit `gateMode` still does. The resolver is unchanged. Managed settings were not part of that
  check.
- **The root README is the installer page:** one marketplace install, the five parts and their defaults, what a
  session can send, and how to update or turn one part off. Current Gate and lean settings, including the live turn
  map and the derived floor, are in `docs/advanced-usage.md`. The V3/V4/V5 experiment tables stay at v0.6.3
  (`931e8367e8b8f27536e14da1ed41baed1f83e22e`) and are not rewritten. The integrated and lean archives pack that page,
  the feature READMEs, `CHANGELOG.md`, and the logo. They no longer pack `hero.svg`, `pilot.svg`, or `v4-flow.svg`.

### Upgrading

- `claude plugin marketplace update jev-gate && claude plugin update jev-gate@jev-gate`, or wait for the marketplace's
  auto-update, then restart Claude Code (or `/reload-plugins`). Options carry over. An evidence config edited on disk
  is read by the next server process, not the one already running.
- Unless `delegationDepthFloor` is set, the derived floor is now 50,865. A worker acceptance that reused another
  command's success, or a check from before the last observed edit, stays incomplete until that check runs again.

## v0.6.3 — Every part is on after install

### Changed

- **Every part is on by default.** Compact (`compactEnabled` true, `compactMode` `active`), Output (`outputEnabled`
  true) and Router (`routerEnabled` true) now default to on; each keeps its switch in `/plugin`. Setup is the key and
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` under `env`.
- **The gate has a switch: `gateMode`** (`auto` by default; `native`, `off`). Under the plugin with no
  `~/.config/jev-gate/config.json`, the gate runs `auto`, so no config file is needed. `JEV_GATE_MODE` wins over
  `gateMode` once set, and both win over the file; a file still decides otherwise. The lean artifact (`--lean`) stays
  opt-in, and outside the plugin hooks (`doctor`, the bench, a bare `node dist/hook.js`) the default stays `off`.

### Upgrading

- An option you already set keeps its value. To keep a part off, set its switch to false (or `gateMode` to `off`).
- The router now asks Jev on the turns it routes and waits up to `routerTimeoutMs` (800 ms) for the answer; set
  `routerEnabled` false to keep every turn native.

## v0.6.2 — The evidence tool needs no setup

### Changed

- **`jev_evidence` works as soon as the plugin is installed.** Without `JEV_EVIDENCE_CONFIG`, the server searches the
  Git worktree holding the session's directory (`CLAUDE_PROJECT_DIR`, which Claude Code 2.1.284 sets for a plugin's
  MCP server; `PWD` otherwise), the whole worktree, with remote on: when `TYPESAFE_API_KEY` is present a semantic page
  is sent to Jev. Installing the plugin with a key is that opt-in; the built-in exclusions (credentials, `.env*`,
  dependency and build directories, symlinks, submodules, binaries) are unchanged. A session outside a Git worktree
  gets `unsupported_inventory`. `JEV_EVIDENCE_CONFIG` still decides when set, and an invalid one never falls back.
  Observed: a `--plugin-dir` session in this repository with no config logged `config ok, remote on, key present`
  and a semantic call answered with `backend: jev`.

### Upgrading

- To keep a project's source on the machine, point `JEV_EVIDENCE_CONFIG` at a config with `"remote": false`
  (`plugins/evidence/README.md#configure`).

## v0.6.1 — A check run with absolute paths counts

### Fixed

- **A worker's passing check is no longer refused because its paths were made absolute.** The gate accepts a planned
  task only when the worker's own transcript shows a passing run of each required check's command. Claude Code tells
  workers to prefer absolute paths, and in an end-to-end run on 2.1.283 a `worker-fast` (Haiku) ran the planned
  `! grep -q '…' tests/zz/spam.test.ts && grep -q '…' tests/zz/spam.test.ts` as the same command with
  `<cwd>/tests/zz/spam.test.ts`: the run passed, the gate found no run of the check and marked the task incomplete.
  The reader now reads an unquoted path under the run's own working directory (the transcript's `cwd` for that call)
  as the relative path, so both name the same file. A quoted one stays as written, since it may be a pattern
  (`! grep -q '<cwd>/a' f` passing says nothing of `'a'`); an unquoted pattern that looks like such a path is the known
  gap. Replayed on that transcript, both checks are observed and nothing refuses.

### Upgrading

- `claude plugin marketplace update jev-gate && claude plugin update jev-gate@jev-gate`, or wait for the
  marketplace's auto-update, then restart Claude Code (or `/reload-plugins`). Options carry over.

## v0.6.0 — One plugin: install once, update once

### Changed

- **The marketplace lists one plugin, `jev-gate`, and it carries every part.** Until v0.5.1 the gate, the compactor,
  the Router, the Vitest folder and the evidence tool were five plugins, installed, configured and updated one by one.
  `jev-gate-<version>.zip` now holds the gate's command hooks, the three Function Hooks Mods (from their source in
  `mods/`, loaded through one module, `hooks/register.ts`) and the evidence server and skill (`plugins/evidence/`).
  Each part is still off until enabled, and a part without `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` is still not loaded
  while the gate and the evidence tool run.
- **Options take the plugin's names.** A name two Mods shared, or one that would read as the gate's, carries the Mod's
  prefix: `compactEnabled`, `compactMode`, `compactBudgetChars`, `outputEnabled`, `routerEnabled`, `routerTimeoutMs`,
  `routerLogDecisions`, `routerMinUpgradeConfidence`, `routerMinDowngradeConfidence` and `router<Tier>Model`; the rest
  (`compactSubagents`, `compactManual`, `route*`, `typesafeApiKey`) keep theirs. A test holds `plugin.json` to each
  Mod's own options, types and defaults. An unusable option still turns only its Mod off, with the same debug line.
- **The evidence tool is `mcp__plugin_jev-gate_evidence__jev_evidence`**, and its skill `/jev-gate:evidence`.
- The release uploads, downloads back and checks every archive the marketplace pins, now one.

### Upgrading from v0.5.x

The four separate plugins are gone from the marketplace and will not update again. Uninstall them
(`claude plugin uninstall jev-gate-compact@jev-gate`, and likewise `jev-gate-router`, `jev-gate-output`,
`jev-gate-evidence`) before updating `jev-gate`, or their hooks run twice, and set their options again under the names
above. Each directory still loads alone with `--plugin-dir` under its old names, for development and the bench.

### Host facts behind the shape (Claude Code 2.1.283)

- A plugin loads one hooks module; a second `modules` entry fails the whole `hooks.json`, command hooks included.
- A module that registers one event twice fails to load, so the Mods' diagnostics for an unusable option (each on
  `session.start`) are written from one hook; their own hooks share no event.
- The validator reads every `on("<event>", hook)` call and every use of `$` statically, through imports.

### Observed (Claude Code 2.1.283, `claude -p --plugin-dir .`, no user settings, 2026-09-28)

- One session ran the gate's command hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, in mode `off`), loaded the
  combined module with the Router's and Output's events, connected the evidence server (`jev-evidence` 0.6.0) and loaded
  the skill as `jev-gate:evidence`. `compactMode: "fast"` wrote `jev-compact {…"field":"compactMode"}` and left the
  others on; `compactMode: "active"` registered `session.compact`. ToolSearch returned
  `mcp__plugin_jev-gate_evidence__jev_evidence`. Loading from the marketplace archive is observed only after release.

## v0.5.1 — The evidence tool installs from the marketplace, and a hand-set effort stays

### Changed

- **`jev-gate-evidence` is a marketplace entry (#77, v1.2).** Like `jev-gate`, it is the tagged release's archive pinned
  by SHA-256 (`jev-gate-evidence-0.5.1.zip`), so `/plugin install jev-gate-evidence@jev-gate` installs it; downloading
  the asset and loading it with `--plugin-dir` still works. `scripts/release.mjs` packs, pins and checks every archive
  entry with its own pack profile, freezes each one once its version is released (an archive entry added after a
  release has no pin there and is refused the same way), and takes `--asset` once per archive, matched by file name.
  The release job uploads both archives, downloads both back and checks them against their pins.
- **Router: a turn that arrives at another effort keeps it (#81, v1.2).** The host does not say who set a root turn's
  effort, and a change made in the session (`/effort`, the model picker) shows only as a turn arriving at another
  effort than the turn before. That turn now keeps its effort and asks Jev nothing about it
  (`"effort_kept":"incoming_changed"`); the next turn at the same effort is routed again. `CLAUDE_CODE_EFFORT_LEVEL`
  still pins it for good. Read from the declarations; not observed on an installed host.

### Dependencies

- `@modelcontextprotocol/sdk` 1.30.1 and `esbuild` 0.28.2 (devDependencies, fixed by `package-lock.json`), added in
  v0.5.0 for #77. The SDK is the official MCP implementation, used so the server writes no JSON-RPC of its own; esbuild
  bundles it into `plugins/evidence/dist/server.mjs`, so the installed plugin needs Node 22 and no `node_modules`. The
  bundle is byte-identical between macOS and the Linux release job (checked on v0.5.0's asset).

## v0.5.0 — One evidence tool, a Vitest log folder, and compact and router fixes

### Added

- **`jev-gate-evidence` (#75–#77).** One read-only MCP tool, `jev_evidence`, in `plugins/evidence`, shipped as its own
  archive (`jev-gate-evidence-0.5.0.zip` on the release, or `node scripts/pack.mjs <out> --profile evidence`) with the
  MCP SDK bundled into `dist/server.mjs`. It reads
  the one project `JEV_EVIDENCE_CONFIG` names, returns exact 40-line windows with their path, lines and file SHA-256,
  pages with a snapshot check, and reads a returned reference back exactly. With `remote: true` and a key, a semantic
  page goes to Jev (at most two requests of eight candidates, no retry, 1.5 s): relevant windows first, and a clearly
  unrelated `locate` window keeps its reference but not its text. Exact-symbol lookups, read-backs, `remote: false`
  and a missing key send nothing. A manual skill, `/jev-gate-evidence:evidence`, runs only when typed.
  Checked on Claude Code 2.1.283 with `--plugin-dir plugins/evidence`: the server connected, the tool was listed
  (deferred, found by ToolSearch) as `mcp__plugin_jev-gate-evidence_evidence__jev_evidence`, the skill as
  `jev-gate-evidence:evidence`, and an `exactSymbols` call returned its windows. With `remote: true` and a real key,
  a 16-candidate page took two Jev requests and 440 ms and folded four windows. The skill itself was not run on a host.
- **`jev-gate-output` (#80)** is in the marketplace: it folds runs of identical lines in a passing Vitest log the host
  persisted, off by default.

### Fixed

- **Compact (#79).** User-role text is kept beside tool results and quoted whole; the previous summary, user
  messages and failed or interrupted calls are mandatory and unclipped, and when they do not fit the engine compacts
  (`mandatory_overflow`). Failures get their own section.
- **Router (#81).** No override after a failed step (`step_failed`) or into a subagent's later run (`next_turn`); a
  spawn onto a model that takes no effort sends no Jev request.

## v0.4.0 — Gate A prices the request, both gates act, and a reported pass is checked

This release answers the owner's review of real use on 2026-09-28, point by point.

### Changed

- **Gate A prices each request instead of vetoing on its kind.** The `answer_only` veto is gone: it said nothing about
  cost, and it vetoed a 26-call analysis that would have cost 7.9M tokens direct and 3.24M delegated. The `size ≥ 1`
  floor is gone with it, since it let almost everything through. Jev now reads off roughly how many tool calls the
  request needs (`tool_calls`, a 0–4 score). Code maps that score to root turns (`TOOL_CALL_TURNS = [0, 10, 10, 10, 60]`)
  and delegates only when `(turns − 11) × depth − turns × 40,000 > 0`. Put simply: delegate when the turns saved,
  each of which would re-read the whole session, outweigh what the worker reads doing them. A turn that does not pay
  stays direct as `admission_not_worth`, and the trace records the price (`estimate`). Both constants are config
  keys (`delegationCoordinatorTurns`, `delegationWorkerTokensPerCall`).
- **The floor is derived, not a policy number.** With the atomic gate (the default) and `delegationDepthFloor: null`,
  the floor is the shallowest depth at which the largest answer could pay: 48,980 tokens (`source: cost_model`). The
  window-fraction floor (180K on a 300K window) applies only to the composite gate now. The measured points behind it
  are unchanged: +182% at 55K and −57% at 406K.
- **`admittedShape: auto` is the default.** An admitted turn runs as one worker carrying the request verbatim, with no
  planner, unless Gate A read the request as separate outcomes or a whole project; only then does the planner
  hierarchy run. The owner chose this on 2026-09-28, following `DECISION-admitted-shape-2026-09-19.md` (single passed
  6/6, hierarchy 4/6). The single-shape coordinator is told to dispatch before reading anything.
- **Gate B's answer is applied.** `routeQuestionShape` defaults to `atomic`. The composite answer never cleared its
  0.8 floor in real use (0.78, 0.35), so every dispatch kept the tier the coordinator called. The atomic shape
  composes fast, standard or deep in code, with no floor. It never picks frontier.
- **The Router leaves jev-gate dispatches alone.** A `jev-gate:` subagent, or a prompt carrying Gate B's route note,
  is skipped as `gate_routed`, so Gate B's model and effort are the ones that run.
- **MCP work can be delegated.** The root guard now allows `mcp__*` tools (`guardAllowMcp`, default on), and the
  coordinator is told to run any connector step itself and hand the worker the result. Gate A's `external_tools`
  veto applies only when `guardAllowMcp` is off.

### Added

- **Reported passes are checked against the worker's own transcript** (`verifyWorkerChecks`, default on). A worker's
  `accept` used to be accepted on its word. The hook now reads the worker's transcript (last 8 MiB) and compares each
  required check reported as passing with the last call of that check's command. A call counts only if it contains
  the command's own shell segments in order and nothing around them (`|| true`, `; …`, a leading `||`) can decide the
  exit status in their place. The task is `incomplete`, with the check named in the reason, when that last run failed
  (the host marked it `is_error`) or when the gate cannot see a passing run: none in the transcript, none in the last
  8 MiB of a longer one, no transcript at all, or a required check with no command. A single-shape worker that changed
  files and reports no passing check is `incomplete` too. A run before a later edit is recorded in `verification` and
  refuses nothing. The check is still
  weak: a command piped into `tail` exits with `tail`'s status. On the single shape, checks are named by position in
  traces, never by the command. `explain` prints the verification and Gate A's price.
- **Malformed Jev answers change nothing.** Gate A needs all six answers, each in the type its question asked for, or
  the turn stays direct (`admission_invalid`); Gate B reads a fact only as a `noul` answer. All 100 real Gate A answers
  in the calibration run met this. A transcript whose depth cannot be read keeps the turn direct even with
  `delegationDepthFloor: 0`.
- `bench/results/v5-gate-a-cost-2026-09-28/`: the pre-registered calibration and validation of the cost model on 100
  real prompts (numbers only).

### Measured, and the limits

- On 50 held-out prompts the gate admitted 8, with a precision of 0.625. The net saving under the model was +30.4M
  tokens against 885.1M native, which meets the pre-registered rule. The shipped default, which does not veto on
  `external_tools`, admitted 9 with a precision of 0.667 and a net saving of +66.4M; that comparison was not
  pre-registered.
- **Jev's read-off barely predicts the turns a request takes:** Spearman correlation 0.05–0.08. As a result the gate
  recovers 5–11% of the saving the model says is available. Admitting everything at depth would save 513.6M under the
  model, but that figure prices only tokens, not the quality of a worker that does not see the conversation. It is
  not taken here: it needs a quality guard and a paid measurement.
- The oracle is the cost model itself (`C` and `d` are declared, not fitted), so this checks which prompts the gate
  picks, not whether delegation pays. No paid end-to-end run backs 0.4.0.

## v0.3.1 — the release archive ships lean's executor

- The `jev-gate` archive now includes `agents/executor.md`. v0.3.0 shipped only the six routing roles, so
  `node dist/cli.js doctor` failed on the installed plugin (`agents/executor.md missing`), and `mode: lean` would have
  dispatched an agent that was not installed. The default hook set runs every mode, so the default archive carries
  every agent doctor checks. `tests/pack.test.ts` now runs doctor on the packed archive and requires no failure.
- `jev-gate-compact` and `jev-gate-router` are unchanged apart from the version, which the three plugins share.

## v0.3.0 — a plugin marketplace, the compactor and the Router

Install from the repository's own marketplace instead of a local checkout:

```text
/plugin marketplace add MongLong0214/jev-gate
/plugin install jev-gate-compact@jev-gate
```

Every plugin here is off until you enable it. `jev-gate-compact` and `jev-gate-router` are Function Hooks plugins and
also need `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the environment Claude Code starts in.

### Added

- **Marketplace** (`.claude-plugin/marketplace.json`): three plugins. The two Function Hooks plugins ship from their
  source directories; `jev-gate` ships as this release's archive, pinned by SHA-256. `npm run release:check` rebuilds
  the archive and fails unless it matches the pin (`scripts/release.mjs`), and `scripts/pack.mjs` now writes the same
  bytes for the same tree.
- **`jev-gate-compact`** (#59, #60): answers the host's auto compaction with an extractive digest of the earlier
  conversation and the recent tail. No summarizer request is sent, so a compaction takes milliseconds (2–7 ms
  observed) instead of the engine's minute or more (a 95-second median over the owner's week of sessions). It calls no
  Jev: Jev was tried for ranking what to keep and for deciding when to fall back, and neither beat recency. Keep
  `compactManual` off (host defect, see its README).
- **`jev-gate-router`** (#47, #49, #63): chooses the effort of the main thread and of subagents, and the model of a
  subagent (an inheriting built-in, or one whose Agent call names a model), from one TypeSafe Jev assessment each; any
  doubt, timeout or unverified host leaves the request native. The main thread's model is not routed.
- **Lean mode** (#37): one request, one selected packet, one fresh executor. Implemented, not measured.

### Changed

- The orchestration gate derives its depth floor from the host's compaction window (#52) and stays native where Agent
  calls can only run in the background (#57); one model table with an opus frontier default (#53).
- Jev probability sums off by Jev's two-decimal rounding are accepted (#62).

### What is and is not established

- Compaction speed is measured on the installed host. The token effect comes from compacting earlier with no
  summarizer cost: replayed over the owner's sessions, a 200K compaction window with the compactor used 18.6–26.6%
  fewer tokens than the host's 300K window, and the host alone at 200K 12.5% fewer. That is a simulation, not a
  measured A/B.
- No saving from the Router or the orchestration gate is established: the Router comparison (#61) stopped at 16 of 45
  cells and was not adjudicated.

## v0.2.0 — Jev-directed orchestration (V5)

See the [release](https://github.com/MongLong0214/jev-gate/releases/tag/v0.2.0).

## v0.1.0 — Claude Code hook MVP

See the [release](https://github.com/MongLong0214/jev-gate/releases/tag/v0.1.0).
