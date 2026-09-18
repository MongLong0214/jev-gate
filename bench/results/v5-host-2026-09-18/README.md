# V5 installed-host verification (JG5-08) — 2026-09-18

Host: Claude Code **2.1.276**, macOS 26.2 (Darwin 25.2.0), node v24.18.0, official Claude.ai **team** subscription login
(`apiKeySource: none`, first-party provider). Launch profile copied from `src/bench/run.ts` `runClaudeCell`:
`-p --model sonnet --input-format text --output-format stream-json --verbose --max-turns N --permission-mode acceptEdits
--allowedTools <restricted> --setting-sources project,local --no-session-persistence --plugin-dir <repo>`, environment
`CLAUDE_CODE_FORK_SUBAGENT=0 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. Work happened in a disposable project
(`package.json`, `README.md`, one module) outside the repository; nothing in `src/`, `agents/`, `hooks/` or `bench/v5/`
was touched. Raw logs (streams, panes, state, traces) are under `~/jev-gate-runs/v5-host-1/`; the scratch test plugin is
under the session scratchpad. No config file exists at `~/.config/jev-gate/config.json`, so every run used
`DEFAULT_CONFIG` with the mode forced by `JEV_GATE_MODE`.

Two product builds were exercised, because another session rebuilt `dist/` mid-verification:

| build | `dist/hook.js` sha256 | used by |
|---|---|---|
| A | `fa0f7351a66ed2ee010b9071ca94d717fa8251c492c3b65165854ce8ee61a510` (15:06:49, pre-commit working tree) | checks 1–5 |
| B | `b5db1035d9ab5223ba338b125ddf99918f26cda1623a12ce80589903590894f2` (15:22:39, tree at commit `134df5f`) | check 6, hook-level probes |

Evidence: `check1-profile-switch-and-effort.json`, `check2-native-orchestration.json`, `check3-direct-path.json`,
`check4-jev-smoke.json`, `check5-escape-hatch.json`, `check6-interactive-tui.json`. Deterministic-hook proofs
(test-only plugin, or synthetic input piped into `dist/hook.js`) are labeled as such in every file and are never mixed
with real-Jev observations. Request texts are withheld; prompts appear only as lengths and sha256.

## Results

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Profile switch via `updatedInput` (`subagent_type` + `model` together) spawns the target profile | **observed** (deterministic hook) | check1: child hook input reports `agent_type: jev-gate:worker-fast` / `…worker-frontier`; `resolvedModel` = `claude-haiku-4-5-20251001` / `claude-fable-5-1` |
| 2 | Haiku child observed for a fast patch | **observed** | check1, `resolvedModel claude-haiku-4-5-20251001` |
| 3 | Rebound profile keeps its frontmatter tools and native permissions (Edit/Write/Bash work) | **observed** | check1: rebound workers used Read, Bash, Write and Edit; `effort.txt` written, `README.md` edited |
| 4 | Effort applied to `worker-fast` (haiku, `effort: low`) | **observed NOT applied** | check1 `c1b2-effort`: child hook input has **no** `effort` key; `echo CLAUDE_EFFORT=$CLAUDE_EFFORT` in the child shell printed an empty value |
| 5 | Effort applied to `worker-frontier` (fable, `effort: xhigh`) | **observed applied** | same cell: child hook input `effort {"level":"xhigh"}`, child shell printed `CLAUDE_EFFORT=xhigh` |
| 6 | Hook input carries `prompt_id` on UserPromptSubmit / PreToolUse / PostToolUse / Stop | **observed** | check1 key inventory (root and child) |
| 7 | Hook input carries `effort` | **observed, but as an object** | root PreToolUse/PostToolUse/Stop: `{"level":"high"}`; absent on UserPromptSubmit; absent for a haiku child |
| 8 | Orchestration guidance injected at UserPromptSubmit | **observed (indirect)** + hook-level proof | check2: the root, whose request never names jev-gate, called `jev-gate:planner` and used the exact `[JEV_TASK rev=1 id=t1]` syntax that only the injected rules define. The text itself is never echoed in stream-json |
| 9 | Planner called, JSON plan parsed, phase → `planned`, ready ids delivered | **observed** | check2 `plan` trace `outcome ready rev 1`, state `phase planned`; `modelUsage` shows `claude-opus-5[1m]` for the planner profile |
| 10 | Worker dispatch markers + canonical contract appended (composed prompt) | **observed** | check2: root worker prompts contain no check ids, yet both workers reported the contract ids `c1/c2` and `c1..c4`; those exist only in the hook-appended block |
| 11 | Root guard denies a non-allow-list root tool with the fixed reason | **observed for Bash** | check2: one root Bash attempt denied with `GUARD_DENY_REASON`, `denials=1`; the model then stopped trying |
| 12 | Root Edit/Write denial, and third denial → `continue:false` | **not exercised by the model**; **hook-level verified** | check2 `hook_level_probes`: attempts 1–2 deny, attempt 3 deny + `continue:false` + `STOP_REASON` |
| 13 | Allow-list tool passes with no permission decision | **hook-level verified** | `Read` during orchestration produced empty stdout |
| 14 | Child Bash inside a worker is not guarded | **observed** | check2: workers ran `node --test`, `npm test`, `ls` freely |
| 15 | Parallel dispatch of two ready tasks in one message | **not exercised** | check2: the planner produced a serial chain (`t2 depends_on t1`), so two ready tasks never coexisted |
| 16 | Gate C `replan` context / dependent unlocking on rework | **not exercised** | both workers returned `done` with all required checks passing |
| 17 | Receipts with deterministic verdicts | **observed** | check2: two receipts, verdict `accept`, `advisory: null` (native makes no Gate C call) |
| 18 | Stop records the terminal outcome | **observed** | check2/3/4/6 `stop` traces: `completed` |
| 19 | Direct path: no planner, no guard, zero owned calls | **observed** | check3: `admission_result decision direct reason mode_native`, zero Agent calls, no guard trace, state `shape direct` |
| 20 | Real Jev admission: one HTTP attempt per gate event | **observed** | check4: 1 `admission_intent` + 1 `admission_result`, HTTP 200 in 698 ms, `jev-1.13.0`, 605 in / 50 out tokens |
| 21 | Real Jev admission decision | **observed: `direct`** | `execution` choice `direct`, p(direct) 0.99, confidence 0.98, above the 0.8 floor. Recorded as the real judgment; **not** rerun to force orchestration |
| 22 | Real Jev Gate B (planner tier), Gate B (worker route), Gate C advisory | **unverified** | no owned call existed after a `direct` admission |
| 23 | Escape hatch `JEV_GATE_MODE=off` | **observed** | check5: `JEV_GATE_STATE_DIR` and `JEV_GATE_TRACE_DIR` both set, neither directory created, no guidance, no denials |
| 24 | Interactive TUI | **observed, no behavioral difference** | check6: admission, guard (`denials=1`), `plan` rev 1, receipt `accept`, `stop completed` — same as headless |
| 25 | New-prompt supersede; denied-permission Agent call via `attempt=<n>`; planner pin conflict; replan while workers active | **unverified** | single-prompt runs only; no rework or replan occurred |

## Notable host facts, including contradictions with the ADR (#22)

1. **`effort` is an object, not a string.** The host sends `effort: {"level":"high"}`. `src/hook.ts` `parseInput` accepts
   `effort` only when `typeof === 'string'` (`HookInput.effort?: string`), so the value is dropped in every event:
   `Receipt.root_effort` and the `post`/`failure` trace `root_effort` are `null` in all of check2, check4 and check6
   despite the host supplying it. This is a product defect, not a host limitation — reported, not fixed (the ticket
   forbids touching `src/`).
2. **A8 is answered: Haiku does not get effort.** `worker-fast` declares `effort: low`, but the haiku child's hook input
   has no `effort` key at all and `CLAUDE_EFFORT` is empty in its shell, while the fable child shows
   `{"level":"xhigh"}` and `CLAUDE_EFFORT=xhigh`. The tier table should say effort is not applicable for the fast tier.
3. **Root effort ≠ child effort, confirming the ADR's warning.** Root PostToolUse reports the root's own
   `{"level":"high"}` even while the child ran at `xhigh`, so the root value must never be recorded as the tier's effort.
4. **Environment leakage from the launching session.** The very first effort cell reported `xhigh` for *both* children
   because the launching Claude Code session exports `CLAUDE_EFFORT=xhigh` and `spawn` inherited it. `src/bench/run.ts`
   spawns cells with `{...process.env}`; if the V5 benchmark is launched from inside a Claude Code session, every cell
   inherits `CLAUDE_EFFORT` (plus `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*`, `CLAUDE_PID`) and
   any effort observation is invalid. All cells here strip those variables before spawning.
5. **`stream-json` records the pre-patch Agent input.** The transcript shows the input as the model produced it, not the
   `updatedInput`, so prompt composition cannot be verified from a stream log — only hook-side evidence (or, as here,
   the child reporting contract ids it could not otherwise know) proves it.
6. **Hook `additionalContext` is invisible in `stream-json`.** Neither the UserPromptSubmit guidance nor the PostToolUse
   `[Jev Gate plan]` / `[Jev Gate result]` text appears anywhere in the stream. Any bench checker that greps the stream
   for guidance or readiness text will find nothing; behavioral evidence (planner call, marker syntax) is the only
   observable.
7. **`--allowedTools` Bash patterns are narrower than they look, and they bind children too.** Under
   `Bash(node *),Bash(npm test),Bash(npm run test),Bash(ls *)` a worker's `node --test 2>&1; echo "EXIT:$?"` was refused
   with "This Bash command contains multiple operations. The following part requires approval: …", and an
   `Bash(echo *)`-style rule refuses any command containing `$VAR` with "Contains simple_expansion" — which is why the
   effort probe had to run with unrestricted `Bash`. Separately, a *path* outside the session cwd is still ungranted in
   `acceptEdits`: the planner's `Glob` on the parent directory of the work tree was denied with "Claude requested
   permissions to read from …". Both denials were the host's permission layer, not the Jev Gate guard.
8. **`run_in_background` is still absent** from `Agent` `tool_input` under
   `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (keys: `description, prompt, subagent_type`), as in V4. The eligibility
   rule's "absent means foreground" special case remains necessary on 2.1.276.
9. **Hook input key names on 2.1.276** (values withheld): UserPromptSubmit `cwd, hook_event_name, permission_mode,
   prompt, prompt_id, session_id, transcript_path`; root PreToolUse adds `effort, tool_input, tool_name, tool_use_id`
   and has no `agent_id`/`agent_type`; child PreToolUse adds `agent_id, agent_type`; PostToolUse adds `duration_ms,
   tool_response`; Stop carries `background_tasks, effort, last_assistant_message, permission_mode, prompt_id,
   session_crons, stop_hook_active, transcript_path`. `tool_response` keys: `agentId, agentType, content,
   harnessNoteCount, harnessSectionHash, harnessTailCount, prompt, resolvedModel, status, toolStats, totalDurationMs,
   totalTokens, totalToolUseCount, usage` (`modelsUsed` absent when no swap happened, as in V4).
10. **Interactive TUI needs a real pane.** Piping the TUI's stdout makes the CLI switch to `--print` and fail with
    "Input must be provided either through stdin or as a prompt argument"; a first run in a new folder also shows a
    folder-trust dialog. Once past both, hook behavior is identical to headless.

## Cost and time

API-equivalent cost from each session's final `result.total_cost_usd` (subscription login; `costBasis: list`):

| cell | purpose | cost USD | wall s | models in `modelUsage` |
|---|---|---|---|---|
| c1-fast | rebind → worker-fast/haiku | 0.2217 | 28 | haiku-4-5, sonnet-5 |
| c1-frontier | rebind → worker-frontier/fable | 0.7077 | 76 | fable-5-1, haiku-4-5, sonnet-5 |
| c1b-effort | effort probe (**voided**: inherited `CLAUDE_EFFORT`) | 0.3552 | 22 | fable-5-1, haiku-4-5, sonnet-5 |
| c1b2-effort | effort probe, sanitized env | 0.3796 | 49 | fable-5-1, haiku-4-5, sonnet-5 |
| c2-native-orchestrated | guarded orchestration | 0.6517 | 127 | opus-5[1m], haiku-4-5, sonnet-5 |
| c3-direct | direct path | 0.1098 | 15 | haiku-4-5, sonnet-5 |
| c4-auto-smoke | **real Jev smoke** | **0.1692** | 26 | haiku-4-5, sonnet-5 |
| c5-off | escape hatch | 0.1144 | 17 | haiku-4-5, sonnet-5 |
| c6-tui | interactive TUI | not captured | 64 (model), ~120 driven | interactive sessions emit no `result` event |
| (voided) c3/c5 first attempts | launched without `--plugin-dir` | 0.1291 + not captured | ~33 | rerun with the plugin loaded |

Measured total **$2.84** over 9 headless sessions plus one interactive session; ~8.5 min of model time inside a ~40 min
ticket. The real-Jev smoke itself cost **$0.1692** in model spend plus one TypeSafe call (605 input / 50 output tokens,
698 ms).

No key, prompt body or account identifier appears in this directory: the hook whitelists response fields by
construction, the test plugin dumps key names only, and this summary reduces prompts to lengths and hashes. The
TypeSafe key was read into a child process environment for check 4 only and never written anywhere.
