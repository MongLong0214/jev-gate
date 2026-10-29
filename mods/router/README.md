# Jev Router

Router chooses a model and reasoning effort for the request the host is about to send. The same root conversation continues with its tools, permissions, provider and input. It does not open another root thread or change your saved model setting.

## Enable

Router ships in the combined `jev-gate` plugin and defaults to on. Install the plugin and enter your Jev key once. No role mapping or project file is required. Configure Claude options in `/plugin` → jev-gate → configure; Codex uses its optional `codex.json` policy.

Turning `routerEnabled` off stops ordinary routing. In the combined plugin, automatic Gate dispatches still enforce model eligibility; turning Router off cannot bypass that boundary. The standalone Router registers no policy hooks when disabled.

## What a request can do

If the native request would use model A at high effort, Router can keep A/high, choose A/low, choose B/high, or choose B/xhigh when B takes xhigh under every thinking mode; max is never chosen, only kept or lowered. Selecting A with `/model`, `--model`, or ordinary model configuration establishes a baseline. It does not permanently forbid B. A pair the Router sent itself never becomes the baseline: a resumed session's main loop runs on the model of its last answer, so the plugin store keeps each session's native pair and the Router's last root request. An incoming pair equal to that request is drift, and every drifted turn, routed, kept, held or unassessed, runs on the native pair (`baseline_source: stored_native`). Any other incoming pair is the person's own change and becomes native. With no stored record, a conversation already under way takes the native model from `ANTHROPIC_MODEL` or settings `model` and effort from the effective effort setting (`host_environment`); a new conversation's own pair is native. Explicit environment pins, dimension switches, native organization restrictions and a manual change during the turn take precedence.

Model and effort are independent. A model pin leaves effort open; an effort pin allows only models that can preserve it. When both dimensions are closed, or there is no applicable question, no Jev call is made.

### Restricted automatic models

Astra in Codex and Fable in Claude are **excluded from automatic targets by default**, including ordinary subagents, Gate workers and retries. A manual root selection remains usable and can still have its effort routed. A Claude subagent call that names the restricted model (`model: "fable"`) is also a manual selection: it runs as named, and like a manual root only its effort can be routed. It does not authorize automatic children to inherit that restricted model. An ineligible child falls back to main-session work; ownership of an already launched or uncertain worker remains protected.

Only the literal boolean `true` enables the respective option. Null, strings and numbers are invalid. These are independent host/package settings, with no shared master switch:

| Scope | Optional fragment |
| --- | --- |
| Codex `codex.json` | `{"router":{"allowAstra":true}}` |
| Combined Claude plugin options | `{"routerAllowFable":true}` |
| Standalone Claude Router options | `{"allowFable":true}` |

A `frontier` mapping is a preference, not authorization to use a restricted family. Invalid Router configuration preserves the native root and keeps automatic restricted-family filtering conservative.

## Candidates and efforts

**Codex:** the existing `model/list` discovery retains actual IDs, descriptions, hidden/default flags, modalities and supported effort metadata. Duplicate conflicts and malformed entries exclude only the affected candidate. Pagination failures retain partial discovery and report incomplete coverage. All eligible coding candidates can participate, including candidates outside the four role preferences. Hidden or specialist entries remain discovered without becoming general coding targets. Catalog refresh uses initialization and account changes, not per-turn paid probes.

`gpt-6.1-terra` has a standard role for scoped code fixes, writing and visual/computer-use work, following [official model guidance](https://developers.openai.com/api/docs/guides/model-selection). It participates only when the account lists it. Current Codex metadata offers `low`, `medium`, `high`, `xhigh`, `max` and `ultra`; efforts are still filtered per account, so API support for `none` alone does not add it to a Codex account's options. `ultra` uses native turn settings, never the raw Responses API. Verified Terra prices and input capacity feed the existing cost guard; support does not force a model switch or establish savings.

**Claude:** the installed Function Hooks expose no model-list API. Versioned adapter facts come from the official [model overview](https://platform.claude.com/docs/en/models/overview), [model configuration](https://code.claude.com/docs/en/model-config) and [effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort), checked 2026-10-08 and checked again on every PR. Effective aliases, provider mappings and `availableModels` are read from the host. Only the current version of each family is a new automatic target; historical facts remain readable for older observations. Codex likewise excludes catalog-described older/previous generations, and any `gpt-<major>[.<minor>]-<family>` model with a newer general version of its family in the catalog, from new targets and tier defaults. A Codex root or child whose own model is superseded runs on the newest successor when model routing is on, the model is not pinned and the successor is an allowed target for the same effort (`superseded_baseline` in the trace); otherwise it keeps its model. Capabilities do not prove subscription entitlement. Unknown custom IDs or unverified aliases preserve native settings. A smaller root needs a current complete-request safe upper bound, maximum output room and compatible host transformation. Current Haiku 5.5 has the same documented 1M window as Opus/Sonnet, supports effort and requires Claude Code 2.1.293 or later. Haiku is the preferred bounded fast worker; Codex prefers current account-listed Luna for that role.

One bounded Jev batch asks one capability question over the offered roles plus one effort score per offered model; only the chosen model's effort answer is consumed ([How a move is decided](#how-a-move-is-decided)). Models without multiple effort levels need no effort question. When an eligible candidate has no documented role, or the baseline itself is not offered, the v0.8.21 batch is used unchanged: a nominal choice between actual model IDs, keep and abstain, with the stricter confidence floor for unknown ranks. Catalog order and model spelling do not imply price or capability. Codex roles come from the account catalog's descriptions; unrecognized descriptions remain unknown. These roles are not measured price/performance rankings. Ordered effort changes retain directional thresholds. If the baseline is outside the target scale, use the first ascending cumulative level reaching max(upgrade,downgrade), not a nominal argmax. Missing effort can resolve from effective host settings; unknown values can use a verified explicit target control. Numeric values and actual pins are preserved.

Read-only instructions, file/API constraints and mandatory checks do not lock model or effort. Only an explicit model/effort pin restricts its dimension. Missing evidence that native tools can discover is ordinary investigation; an earlier decision or target that those tools cannot recover still preserves the baseline.

`keep`, `set(value)` and `omit` are different operations. Literal `none` is a supported effort value, not field removal. Omission deletes only the effort field when the native host permits it; other reasoning settings remain intact. Conditional Claude levels are withheld when the thinking mode is unknown. Codex `ultra` is a host control mode: it is offered only through official turn settings, never sent as a raw Responses API effort. The host resolves the API effort.

## How a move is decided

Jev judges what the work needs; code maps that to one model and decides whether to move. The capability question names no model, role, effort or price. Its options, most capable first (Jev leans toward the first option, and this order put less probability below the label on the dev split), are only the roles some eligible candidate serves, plus `unclear`:

| Option | Role | Claude (default preference) | Codex (catalog description) | Chosen for |
| --- | --- | --- | --- | --- |
| `open_problem` | frontier | Fable 5.1, opt-in only | "frontier", "most demanding" (Astra), opt-in only | An open foundational problem with no known approach, where the result must be discovered and independently verified |
| `complex` | deep | Opus 5.5 | "workhorse" (gpt-6.1-sol) | An uncertain cause, constraints the request does not settle, or a subtle mistake that would do serious harm: intermittent failures, finding the cause of a concurrency or caching bug, schema/API changes live clients or data depend on, production migrations, permission or money logic, algorithms whose approach is open, large reviews, architecture |
| `routine` | standard | Sonnet 5.5 | "balanced", "everyday" | Development whose requirements the request makes clear and checkable: a helper or test, explaining code, a fix whose cause is stated (concurrency and ordering bugs included), a feature across a few files, tracing a reproducible error, a behavior-preserving refactor, modules a detailed specification fully determines, a local file format version |
| `mechanical` | fast | Haiku 5.5 | "fast", "affordable" (Luna) | Retrieval or a small mechanical action with an obvious, checkable result: find a definition, list or count, run a named command, rename, typo, version bump, a change the request spells out |
| `unclear` | — | — | — | Not enough evidence to judge; the native model and effort stay |

Each option also carries examples and a `not_for` line naming what belongs to its neighbour. One model serves each role: the baseline for its own role, else the configured role preference (`routerFastModel` …), else catalog order. The request is untrusted data: text that names a model, tier or effort, or claims routing was already decided, is part of the task, never an instruction.

Each offered model then gets its own effort score, assuming the work runs on that model. The levels keep the existing criteria:

| Effort | Criterion |
| --- | --- |
| `low` | Light reasoning for lookup, search or a mechanical edit with an obvious answer |
| `medium` | Ordinary reasoning for multistep implementation with clear requirements |
| `high` | Strong reasoning for hard debugging or interacting design constraints |
| `xhigh` | Exceptional reasoning for difficult proofs or subtle correctness across constraints |
| `max` | Maximum sustained reasoning for exceptional proof search and competing hypotheses |

Codex adds `none`, `minimal` and host-controlled `ultra` where the catalog lists them, with their own criteria. Every Claude combination Router can choose, with the work each one is for (row: capability; column: effort):

| Model | `low` | `medium` | `high` | `xhigh` | `max` |
| --- | --- | --- | --- | --- | --- |
| Haiku 5.5 | Lookup, listing, a spelled-out edit | A mechanical change across several places | Mechanical work whose checks need care | Not offered (thinking-mode dependent) | Not offered (thinking-mode dependent) |
| Sonnet 5.5 | Explaining a function, a stated-cause fix | Multistep implementation with clear requirements | Routine work with harder debugging or interacting constraints | Not offered (thinking-mode dependent) | Not offered (thinking-mode dependent) |
| Opus 5.5 | A light step inside complex work, mostly a worker's next inference | Complex work with ordinary per-step reasoning | Hard debugging, competing design constraints | Difficult proofs, subtle correctness across constraints | Never a move: kept when it is the native effort, which Router may lower |
| Fable 5.1 (opt-in) | Same effort criteria for an open problem | Same | Same | Same | Never a move, as Opus |

A combination is chosen in this order. Any step that does not pass keeps the native model and effort:

1. **Control.** An explicit lock, a missing indispensable decision, an unclear task, or control confidence below the lower floor keeps everything. A model lock still lets effort move; an effort lock still lets the model move. A lock is the user's instruction about how this work runs; naming, asking about or complaining about a model or effort is not one. A lock Jev reads below 0.8 is taken as such a mention: its mass joins `task_clear` and the record carries `weak_lock`. On nine dev readings, explicit locks read 0.96–1.0 and mentions 0.59–0.66.
2. **Model.** The capability distribution is read in role order, not by its largest option. Walking up from the cheapest role, the first role below the baseline whose cumulative mass reaches `minDowngradeConfidence` (0.65) is the target. Otherwise, walking down from the most capable role, the first role above the baseline whose cumulative mass reaches `minUpgradeConfidence` (0.8) is the target. Otherwise the model stays. `unclear` as the answer keeps the model and its effort.
3. **Risk.** A downgrade also needs `action_risk` answered `ordinary` with at least the downgrade floor.
4. **Effort.** The chosen model's own score moves effort the same way: down at cumulative mass reaching the downgrade floor, up at the upgrade floor. If the baseline effort is not on that model's scale, the first ascending level whose cumulative mass reaches max(upgrade, downgrade) is used.
5. **Pair.** The chosen model must support the chosen effort; otherwise both stay native.
6. **Cache.** A model switch at the root or at a subagent spawn is held (subagent steps choose effort only) unless it costs no more than staying in every scenario the observed usage allows: the newest request's prefix at each model's cache read or write rate (a TTL the host does not report spans 5 minutes to 1 hour), the switched request producing up to the newest request's output, including the request after it going back to the baseline. A root switch is priced over a turn of 5 requests (`TURN_HORIZON`, #271): its cache write is paid once and each later request saves the read and output price difference, each producing the newest request's output: at a 150k Opus prefix and a 1.5k-token output Haiku moves and Sonnet, whose write takes about 20 requests to repay, holds; a longer last output moves sooner, a shorter one holds. A request reads an earlier cache entry only from at most 20 blocks back, so a model's cache, live by its TTL, is out of reach once enough other requests come between (#274): over 100 returns to a model within 55 minutes, every one with at most 5 requests between read its cache, 5 of 12 with 6 or 7, and none of 41 with 8 or more. A switch target last answering more than 5 requests back is priced as an unknown cache, 8 or more as cold. A switch serves at most 5 requests counted from the baseline's last one: the turn then returns to the baseline while its cache is still in reach (`root_stop`, `baseline_reach`), and a turn with none left keeps the baseline (`baseline_reach`). The return is priced at the baseline's read rate, so a 5-minute baseline cache that expires within the turn is not counted (observed TTL 1 hour). A spawn has no conversation to go back to and is priced on its first request. The plugin store keeps the root's observations from the last response with the session's record, so a resumed process (`--resume`, one process per turn) judges its first switch on them by their age and TTL (`cache_restored`); a host transcript shorter than at that save (a compaction or rewind since) restores none; the transcript's length is compared rather than the request's message count, which a task notification's request inflates in memory. A resumed request that restores none records why (`cache_restore_skipped`: `no_record`, `no_cache` or `shorter_request`, with both counts). A conversation is resumed when its transcript already holds an assistant message: a new session's first request carries the host's context messages too, so its count says nothing. An unobserved prefix, cache state or price holds (`cost_unknown_hold`); a dearer estimate holds (`cost_hold`). An upgrade by documented role is never held for cost and is recorded as `upgrade_allowed`. An effort change alone keeps the cache and is not priced. At the root, a lower effort on a warm cache is held at the effort the cache was written at until an effort change on that model has been seen to read the cache, on a request right after that model's own, in this session or an earlier one; a gateway or disabled betas never take an earlier session's (#277). A miss restores the hold and is what the next session starts from. A held switch keeps the native model; that model's own effort answer still applies.
7. **Retry.** A Gate retry (attempt > 1) of a task whose previous attempt recorded its model is served at least one role above that model, as a fresh worker. It never jumps more than one role by itself. A subagent spawn the Router ran below its native model counts too (#353): once that child has ended, a spawn of the same agent type whose prompt shares at least 60% of its words with it is served at least one role above the lowered model, recorded as `retry_step_up` with `retry_of` naming the earlier child. A spawn made while the first child is still running is a parallel task, not a retry. The tool rules that lower a model do not undo the step-up, and the native or declared model stays the ceiling. A prompt template reused for a different target can read as a retry and costs one role up for that spawn. Codex has no spawn routing; its child steps are judged step by step. The v0.8.21 fallback batch has no step-up.

The two floors are the only tuning options and keep their meaning: the downgrade floor is how much probability the cheaper roles together need, the upgrade floor how much the more capable roles together need. dirien/jev-router's per-role accept bars (fast 0.85, standard 0.6, deep 0.3, else the more capable of the top two) were evaluated as an alternative and not shipped. They matched on all dev metrics, and on the held-out split they had the same zero under-routing with more over-routing.

### Evaluation

`npm run build && npm run bench:router -- run --split dev --out <file>` asks every labelled request in `bench/router/golden.json` as a fresh root turn. Each request is asked three times: the shipped question with the options most capable first, the same question cheapest first, and the v0.8.21 pair question as the control. Baseline is Opus 5.5 / `xhigh`, frontier is off, and the floors are the defaults. It writes each item's distributions and decisions to `<file>` and prints the summary. Live calls need a Jev key and are not part of `npm test`. `report --out <file>` recomputes the summary without calls. The test split is frozen by hash, and `--split test` refuses a changed one.

Results on 2026-10-16 with `jev-1.14.0`, held-out split (64 requests plus 20 injection probes, run twice on the migrated code: the first before the 12 hard-but-short dev requests were added, in the table; the second on the final build after the dev runs, below it; nothing was tuned on either):

| Policy | Exact | Under (95% upper) | Over | Est. price vs baseline | Injection probes moved below their pair | Latency p50 / p90 |
| --- | --- | --- | --- | --- | --- | --- |
| Shipped (most capable first, role order) | 98.4% | 0% (5.7%) | 1.6% | 0.52 | 0 of 20 | 184 / 255 ms |
| Cheapest first, role order | 100% | 0% (5.7%) | 0% | 0.51 | 0 of 20 | 183 / 230 ms |
| Most capable first, accept bars | 96.9% | 0% (5.7%) | 3.1% | 0.52 | 0 of 20 | same call |
| v0.8.21 pair question (control) | 89.1% | 7.8% (17.0%) | 3.1% | 0.48 | 4 of 20 | 183 / 259 ms |
| Always the baseline | 32.8% | 0% | 67.2% | 1.00 | — | — |
| Always the cheapest | 32.8% | 67.2% | 0% | 0.03 | — | — |
| Random with the shipped role shares | 33.4% | 32.8% | 33.8% | — | — | — |

A second run of the same frozen split on the final build, with the Router policy unchanged between the two runs, gave the shipped policy 98.4% exact, 0% under (95% upper bound 5.7%), 1.6% over, 0 of 20 probes moved and 183 / 232 ms; cheapest first 100% / 0% / 0% at 0.51 and 183 / 247 ms; the pair control 90.6% exact, 6.3% under (15.0%), 3.1% over, 4 of 20 probes moved below their pair and 181 / 224 ms. One call per request means the two runs differ by noise of this size: one request on the shipped policy's effort and one on the control's routes.

On the dev split (84 requests: the earlier 72 plus 12 hard-but-short complex ones, `d-c21` to `d-c32`, written and labelled before any run on 2026-10-16; three repeats, 252 answers per model and policy) `jev-1.14.0` gave the shipped policy 97.6% exact, 1.2% under and 1.2% over, and `jev-1.13.0` run on the same file with only the Jev model changed gave 96.4%, 1.2% and 2.4%. Cheapest first gave 96.4% / 1.2% / 2.4% on 1.14 and 95.2% / 1.2% / 3.6% on 1.13. The order was chosen on `jev-1.13.0` dev runs because most capable first put less mass below the label in all three repeats; the held-out lead of cheapest first above is one run and is not a reason to switch. That `jev-1.13.0` build gave the shipped policy 98.4% exact, 0% under, 1.6% over and 0 of 20 probes on the held-out split, with every exact route's effort inside the labelled range.

Effort is where `jev-1.14.0` first read differently. On the held-out split 96.8% of exact routes had their effort inside the labelled range: two complex requests (`t-c04`, `t-c13`) ran Opus at `medium` against a labelled `high` or above, and three complex injection probes did the same; `jev-1.13.0` had two such probes and no such request. The second run read 98.4% in range: one complex request (`t-c13`) and two complex probes. The 12 added dev requests were written to test that. Across the three dev repeats the shipped policy served a complex request below its labelled effort in 5 of 96 exact complex answers on 1.14 (5.2%) and 6 of 96 on 1.13 (6.3%); the exact routes' effort was inside the labelled range 96.7% of the time on 1.14 and 96.3% on 1.13. Three requests account for every miss on both models: `d-r16` (a routine request served `high`, all three repeats on both), `d-c21` (a public webhook field rename, `medium` in 2 of 3 on 1.14 and 3 of 3 on 1.13) and `d-c32` (a protobuf field change, `medium` in 3 of 3 on both). So the dev data show no effort regression from 1.13 to 1.14: the same requests miss on both, in about the same number. The held-out `medium` readings are one run on one split, and the effort reading is unchanged. `d-c21` and `d-c32` are compatibility changes that both models read as medium effort; whether the label or the reading is right is the open question, and no criteria change was made for them.

On 2026-10-22 the routine/complex boundary was corrected from outcomes rather than from the rubric's own labels. Jev routed six checker-backed coding jobs to Opus as complex (orbit-core, mini-sql, job-queue, todo-priority, search-race, ttl-cache; capability 0.45–0.92). Run headless with no plugin, Sonnet 5.5 passed every checker run of the five that Opus passed (orbit-core and mini-sql 3/3, the other three 2/2) at 49–56% of Opus's notional cost; ttl-cache failed the same check on both models and is unresolved. Every one of them spelled out the cause or required behaviour and had checks, so the rubric now calls such work routine whatever its topic, and keeps complex for an uncertain cause, constraints the request leaves open, live compatibility, permission or money logic, open algorithm design and reviews (`bench/results/tier-outcome-2026-10-22`). With `jev-1.14.0` and the corrected rubric: the six jobs and their variants went to Sonnet (13/13); a fresh held-out set written and labelled before the run, 12 requests plus 6 injection probes, was 18/18 exact; the frozen test split was 83/84 exact with 0 under (the old rubric on the same day: 82/84, 0 under); dev 82/84 with 0 under; spawn, now with the five outcome-labelled jobs, 16/17 with one over-route. The test split had been read once by an intermediate wording that moved one injection probe (`p13`, an open CRDT design) below its pair; that wording was not shipped. The outcome check covers Claude only: Codex shares this rubric and its routine/complex models were not outcome-tested.

These are limits of the set, not caveats to skip:

- One person wrote the labels and the rubric, and many requests resemble the rubric's own examples. The result measures agreement with this rubric, not whether a cheaper model would have finished the task.
- 64 held-out requests bound under-routing only below about 6%.
- The price column is list input price relative to Opus. It ignores token counts, effort and cache, so it is not a cost saving.
- The thresholds are tied to `jev-1.14.0`. Re-run the bench when the Jev model, the questions or the floors change.

### Credits

The capability options' structure (what, examples, not for) and the wording of both instructions follow [ruban-24/switchboard](https://github.com/ruban-24/switchboard) (Apache-2.0). The anti-injection sentence, the evaluation protocol and the accept-bar alternative follow [dirien/jev-router](https://github.com/dirien/jev-router) (Apache-2.0).

## Context, timing and application

Root assessment sees the exact current human request, the previous **completed visible final answer**, and up to three screened recent human requests. Prior text is screened before keeping a 2,000-character tail, with source/truncation metadata. Partial commentary, tool output and self-generated prompts do not become a previous answer. Unsafe or oversized current input stays native without truncating the user's request. A turn that ends without an answer (an error or an interruption) keeps the last completed one. The plugin store keeps that answer and those requests, screened and cut to the tail a question sends, for the latest 20 sessions, so a resumed process asks with them (`context_restored`); a host transcript shorter than at that save (a rewind or compaction since) or one that cannot be read restores none (`context_restore_skipped`: `shorter_transcript` or `transcript_unknown`). The host's own resumed transcript is not read for this: it reorders earlier answers after a compaction summary, adds a synthetic `No response requested.` answer, and holds command records and the summary as user messages.

The existing batch includes prior observed cache counts/model/age when available. These inform rebuilding cost without proving current fit or cache transfer between models. A cached root plus a bounded fresh worker can be preferable for a short task. No extra cache warm-up inference, token-count probe or cross-turn decision memoization is added. Each new turn still uses its own judgment.

Root assessment runs once at the first request of a user turn. Concurrent entry shares the pending assessment. The validated patch persists across later tool steps; the next user turn is assessed again. A manual model/effort change wins, while a value applied by Router itself is not mistaken for a manual pin. Settings and catalog changes invalidate an unsent patch. Requests already sent are not replayed or cancelled by a settings refresh.

The default 800ms budget covers preparation, Jev and final application checks. Timeout continues the native request once when it is still wanted. Cancellation before native dispatch sends nothing. Native stream errors propagate without a second request. Late Jev usage remains attributed to the original assessment.

Claude workers keep Gate B or spawn allocation on their first step. The adapter also assesses later inference steps using the child contract and recent tool names/outcome labels, without copying tool arguments, output, repository text or thinking. Those later effort choices are **hook proposals, not a guarantee that the host applies a different effort**. On Claude Code 2.1.312, a tool continuation in the same human turn restores the earlier effort even when the hook proposes a new one. The [official per-message effort contract](https://platform.claude.com/docs/en/build-with-claude/effort#change-effort-mid-conversation-beta) likewise waits for new human input; a user message containing only tool results does not start that boundary. The native high→low→medium regression remains open in [#392](https://github.com/MongLong0214/jev-gate/issues/392). New-turn root selection and initial child allocation are separate from that limitation. No internal host switch, transcript rewrite or provider retry is used to force a continuation change.

The existing native conversation stays intact. The model is chosen once, at the spawn: a step on another model re-reads the child's whole conversation without its cache. Concurrent delivery of one step shares its assessment. A timeout or invalid judgment preserves that step and the next step is assessed again. Native stream failures stop further overrides without replaying the request. Unknown or already running loops without a verified spawn mapping stay native. A user or project agent (`.claude/agents/<type>.md`, project first, then `CLAUDE_CONFIG_DIR` or `~/.claude`) is asked about from its file's `model:` (absent or `inherit` is the parent's) and is only ever moved down from it; a plugin's agent or an unreadable file keeps its model. A spawn whose `name` addresses a subagent the session already has is a SendMessage resumption and stays native; a resumption whose spawn event carries no `name` cannot be told from a new spawn by the hook.

Gate B adds candidate-local allocation questions to its existing batch, not a second classifier call. Optional recording and dashboard failures do not change execution. Durable worker ownership and cancellation remain required for safe dispatch and acceptance.

## Claude options

The standalone names omit the `router` prefix where listed below. Existing names and defaults remain compatible.

| Combined option | Standalone option | Default | Purpose |
| --- | --- | --- | --- |
| `routerEnabled` | `enabled` | true | Ordinary routing |
| `routeMainModel` | same | true | Root model selection |
| `routeMainEffort` | same | true | Root effort selection |
| `routeSubagentModel` | same | true | Automatic child model selection |
| `routeSubagentEffort` | same | true | Child inference effort selection |
| `routeExplicitSpawnModel` | same | true | Treat an ordinary Agent model argument as a routable default |
| `routerAllowFable` | `allowFable` | false | Restricted automatic family opt-in |
| `typesafeApiKey` | same | unset | Sensitive key; explicit value takes precedence |
| `routerFastModel` / `routerStandardModel` / `routerDeepModel` | `fastModel` / `standardModel` / `deepModel` | haiku / sonnet / opus | Role preferences; do not limit all candidates |
| `routerFrontierModel` | `frontierModel` | claude-fable-5-1 | Role preference; requires opt-in for automatic use |
| `routerMinUpgradeConfidence` | `minUpgradeConfidence` | 0.8 | Upgrade floor |
| `routerMinDowngradeConfidence` | `minDowngradeConfidence` | 0.65 | Downgrade and ordinary-risk floor |
| `routerTimeoutMs` | `timeoutMs` | 800 | Total preparation budget, 50–30000ms |
| `routerLogDecisions` | `logDecisions` | true | Optional diagnostics |

`ANTHROPIC_MODEL` pins the root model; `CLAUDE_CODE_EFFORT_LEVEL` pins effort; `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` pins child model resolution. `CLAUDE_CODE_SUBAGENT_MODEL` alone (Claude Code 2.1.251+) is the default model of a child that names none, which owned roles and routed spawns override; a general-purpose or claude spawn and a custom agent without `model:` are compared against it rather than the parent's model. `ANTHROPIC_DEFAULT_*_MODEL` maps an alias to its actual ID and does not disable all routing. Unreadable pin/allowlist facts are conservative. Plugin option changes reload the activation; no polling watcher or global model rewrite is installed.

## Diagnostics and verification

Existing recording and dashboard views distinguish assessment, selection, request submission and response observation. Records include the baseline, effort-field presence/effective source, scope, bounded candidate IDs, exclusions, direction/threshold/selected probability, effort policy, pins/toggles and loaded hook version. Doctor reports installed version independently and cannot prove what an existing host loaded. Restart after updating; explicit environment injector source is unknown unless actually observed. A submitted model is not a confirmed response. Missing response model or effort remains unknown; a mismatch never silently becomes confirmation. Observers cannot consume or delete an execution patch. Prompts, credentials and catalog description text are excluded from diagnostic records.

TypeScript and Vitest cover selection, host adapters, cancellation, races, context, invalid settings, partial catalogs and recording failures. Native tests separately use the real Claude Function Hooks engine and Codex process with scripted providers. They establish control-flow behavior, not model quality or savings. Account access and native permissions are host decisions.

For standalone development, run `npm run build` then `node scripts/pack.mjs <out> --profile router`, extract the archive and pass that directory to `--plugin-dir`. The package includes the shared pure policy sources and the bounded transcript metadata reader inside its own root. To run its host tests, copy `mods/router/tests` into the extracted directory and run `claude plugin test <directory>`. Combined development uses `--plugin-dir .` after the normal build.
