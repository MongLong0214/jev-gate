# Changelog

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
