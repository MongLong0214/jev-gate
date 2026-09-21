# Installed-host observation — lean executor, 2026-09-21

What the real Claude Code host actually does with the lean handoff. This is an **observation of mechanism**, not a
measurement of benefit: no arm, no comparison, no token or cost claim about the product is made here. The efficacy
question is #29 and is reported separately.

Raw streams, traces and worktrees: `~/jev-gate-runs/lean-host-1/` (outside the repository; they contain session text).

## Conditions

| | |
|---|---|
| Host | Claude Code **2.1.278**, macOS 25.2.0 |
| Auth | claude.ai subscription (team), firstParty |
| Artifact | packed lean profile `jev-gate-lean-0.2.0.zip`, unpacked; hook command `node "${CLAUDE_PLUGIN_ROOT}/dist/hook.js" --lean` |
| Launch | `--model sonnet --plugin-dir <lean> --setting-sources project,local --permission-mode acceptEdits`, `CLAUDE_CODE_FORK_SUBAGENT=0`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` |
| Selection | `JEV_GATE_BENCH_RECENT=1` and **no TYPESAFE_API_KEY**, so the deterministic no-Jev path chose the packet. Zero Jev requests were made; this isolates host mechanics from selection quality. |
| Spend | **$1.7169** across four sessions |

## What was observed

| Question | Answer | How it was established |
|---|---|---|
| Is the agent discovered? | Yes — `jev-gate:executor` appears in the host's `init` agent list | `system/init` event |
| What does `model: inherit` resolve to? | **`claude-sonnet-5`**, the same id the root reported, in all three dispatches | `tool_response.resolvedModel`, recorded by the `lean_post` hook |
| Does the patched prompt reach the worker? | Yes, byte for byte | worker transcript's first entry was **9280 B** and contained the packet header, the retained groups and the note history; the control's was **543 B** |
| Fresh context or fork? | **Fresh.** Every worker transcript begins at its own prompt | subagent transcripts were 10–19 lines starting with the dispatched prompt, not the parent conversation |
| Do project instructions reach the executor? | **Yes** | both executors emitted `PRJ-MARKER-7F3A` from the project `CLAUDE.md` into the file they created |
| **Does the patched prompt echo back into root context?** | **No.** | controlled A/B below |
| Can the root ignore the recommendation? | **Yes, and it did.** | probe 1 turn 2: the recommendation was emitted and the root did the work itself; recorded as `recommendation_not_taken` |
| Marker-only input with no patch applied | **`handoff_unavailable`, no tools called, no files written** | probe 3 |

## The root echo, measured rather than assumed

ADR D3 says not to assume the patched prompt is invisible to later root calls. Two sessions, identical fixture,
identical prompts, identical turns; the only difference is whether the hook patched the owned call.

| Arm | worker prompt | root context before Agent | after | **delta** | reply the root saw |
|---|---|---|---|---|---|
| packet applied | **9280 B** (23 groups) | 45,792 | 47,071 | **1279 tok** | 1181 B |
| no patch (control) | **543 B** | 47,560 | 48,521 | **961 tok** | 1485 B |

An **8737-byte** difference in what the worker received produced a **318-token** difference in root context — while the
packet arm's reply was 304 bytes *shorter*. The packet is not charged to the root's context window.

**Caveat that belongs with it:** the full packet *is* written to the root transcript twice, in an `attachment` record
and in the `toolUseResult.prompt` metadata of the tool-result event. That is disk, not model context. The
assistant's own recorded `tool_use` input keeps the original 350-byte prompt.

## Limits of this observation

- **n = 1 per question.** One host version, one model alias, one call shape. Root compliance was observed as *ignore*
  once and *comply* once under an explicit instruction; that is not a compliance rate.
- **The executor's tool list is a self-report.** It said `Read, Edit, Write, Bash`; the frontmatter declares
  `Read, Grep, Glob, Edit, Write, Bash`. The tools it was *seen* to use were `Read` and `Write`. Whether `Grep` and
  `Glob` are actually available to it is **unverified**, and the discrepancy is not explained.
- `handoff_unavailable` working here is the model following an instruction, not an enforcement boundary. A hook that
  times out removes the plugin's own check; this observes the fallback, it does not make it a guarantee.
- 30 priming notes produced 31 candidate groups, of which 23 were enumerated and **8 were left unassessed** by the
  `MAX_OPTIONAL_GROUPS` cap, with coverage reported as `partial`. Unassessed is not irrelevant.
- None of this says the handoff saves anything. It says the machinery does what it claims to do.
