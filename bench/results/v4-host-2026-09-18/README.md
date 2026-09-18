# V4 installed-host observations — 2026-09-18

Host: Claude Code **2.1.275**, macOS, official Claude.ai **team** subscription login (`authMethod=claude.ai`, `apiProvider=firstParty`),
headless `claude -p`, launch profile `CLAUDE_CODE_FORK_SUBAGENT=0 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, `--setting-sources project,local`.
Interactive TUI behavior was **not** exercised here.

## 1. `hostproof-deterministic-hook.json` — native boundary (#11), no Jev

A **test-only** plugin (not shipped) returned a fixed full-input patch (`model: "haiku"` + a canary suffix) for an eligible
`jev-gate:worker` call, alongside the real plugin in `mode=off` for the role definitions. Observed:

- `PreToolUse` input at the root carries no `agent_id`/`agent_type`; `tool_input` keys were `description, prompt, subagent_type` —
  **`run_in_background` is not delivered** under this launch profile (the host forces foreground and strips the field).
  The product's eligibility rule therefore treats an absent field as foreground only when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
- Session A: patched model applied — `PostToolUse.tool_response.resolvedModel = claude-haiku-4-5-20251001`, the child's stream
  messages ran on that model, the canary reached the child (it repeated `7f3a`), the original task text and role were intact,
  `hello.txt` was created; `status: completed`.
- Session B: with the same patch active, a `Write(**/forbidden/**)` deny rule still denied the child's write
  (`permission_denials` recorded, directory never created); the Agent call still reported `status: completed`, and **no**
  `PostToolUseFailure` fired for the Agent tool. Completion is not requirement success.
- `PostToolUse.tool_response` keys seen: `status, prompt, agentId, agentType, harnessNoteCount, harnessTailCount,
  harnessSectionHash, content, resolvedModel, totalDurationMs, totalTokens, totalToolUseCount, usage, toolStats`
  (no `modelsUsed` when no swap). The hook whitelists documented fields only.

## 2. `autosmoke-real-jev.json` — real plugin, `mode=auto`, real TypeSafe key (#13/#14)

One session, three delegations in order: built-in `Explore`, `jev-gate:worker` with an explicit `model: "sonnet"`, and
`jev-gate:worker` without a model. Observed trace phases: 1 `prompt`, 3 `pre_result`, 1 `pre_intent`, 3 `post`.

| call | hook decision | Jev | outcome |
|---|---|---|---|
| Explore | `role_not_owned` (known not sent) | – | ran on claude-sonnet-5 |
| worker, pinned | `model_pinned` (known not sent) | – | ran on claude-sonnet-5 |
| worker, no model | eligible → `pre_intent` → attempt | 200 in 678 ms, 1,265 input tokens, `jev-1.13.0`; context ready .99, route sonnet .99, kind implement .99 | **patched** `model: sonnet` + hint; `post` shows `has_model: true, has_hint_marker: true`; `resolvedModel = claude-sonnet-5`; task solved (checker all true) |

Whole-tree `modelUsage` for the session: claude-sonnet-5 plus a small claude-haiku-4-5 helper; API-equivalent estimate $0.217.
This confirms plumbing and one routing decision; it is not routing-accuracy evidence.

Keys, headers and prompt bodies are excluded from both files by construction (the hook whitelists response fields; this
summary reduces prompts to lengths/hashes).
