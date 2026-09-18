# Grep contract and output-replacement probe (context-filter §3) — 2026-09-18

Host: Claude Code **2.1.276**, macOS 26.2 (Darwin 25.2.0), node v24.18.0, official Claude.ai **team** subscription login.
Launch profile copied from `bench/results/v5-host-2026-09-18` (`src/bench/run.ts` `runClaudeCell`):
`-p --model sonnet --input-format text --output-format stream-json --verbose --max-turns N --permission-mode acceptEdits
--allowedTools Grep --setting-sources project,local --no-session-persistence --plugin-dir <scratch probe plugin>`,
environment `CLAUDE_CODE_FORK_SUBAGENT=0 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, with the launching session's own
`CLAUDE_*` variables stripped. **The product plugin was not loaded**: `jev-gate` registers `PostToolUse` only on
`^Agent$`, so it cannot see Grep, and leaving it out keeps a second hook from competing for the same tool output.

Work happened in a disposable repository (five one-identifier modules `MARKER_ALPHA_0001` … `MARKER_ECHO_0005`, plus a
400-line padding file) created per cell outside this repository; nothing in `src/`, `agents/`, `hooks/` or `bench/v5/`
was touched and no product code was changed. Raw logs (streams, hook events, decisions, transcripts, prompts, argv) are
under `~/jev-gate-runs/v5-context-probe-1/`, together with the TEST-ONLY probe plugin `jev-contextprobe`, the fixture
template, the cell runner and the fixture generator, so the run is reproducible without the session scratchpad.

The evidence for "the model actually received X" is never the hook's own log and never the UI. It is (a) the model's own
final message, produced in the same turn and constrained to list every identifier it received, (b) the persisted
transcript's `tool_result` block, and (c) the `PostToolBatch` event, which carries the rendered model-facing string.

## Results

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | Real `Grep` `tool_input` / `tool_response` contract for all three output modes and for a host-truncated result | **observed** | `grep-content.json`, `grep-files.json`, `grep-count.json`, `grep-truncated.json` (cell `c1-capture`) |
| 2 | Does `PostToolUse.hookSpecificOutput.updatedToolOutput` really replace what the model sees? | **observed: YES, and the original is not also delivered** | `c2-replace`: hook kept 2 of 5 markers; the model answered `MARKER_ALPHA_0001, MARKER_ECHO_0005`, `COUNT_OF_RESULT_LINES: 8`; the transcript's `tool_result` for that `tool_use_id` is 506 chars containing only those two markers (original was 1298 chars / 20 lines / 5 markers) |
| 3 | Invalid replacement shape | **observed: silently ignored, original survives, no error reaches the model** | `c3-invalid`: three calls fed a bare string, wrong scalar types, and a shape missing required keys. All three transcript `tool_result` blocks are the unmodified 1298-char original; the model reported 20 lines and all 5 markers for each; `NOTICE: NONE`; empty stderr even with `--debug` |
| 4 | `additionalContext` alongside a replacement | **observed: it is additive, never a substitute** | `c4-addctx`: call 1 = `additionalContext` only → model still got all 20 lines / 5 markers **and** quoted the disclosure; call 2 = replacement + `additionalContext` → model got 8 lines / 2 markers **and** quoted the disclosure |
| 5 | `PostToolBatch` on this version | **observed (passive)**, payload differs from PostToolUse | `c1-capture`: 4 `PostToolBatch` events for 4 Grep calls, shape below |
| 6 | Native `Read` of the recovery archive from a different project directory | **observed: denied by default, readable under one narrow grant** | `c5a`…`c5i`, see below |

## The Grep contract as actually observed

`tool_input` is the model's arguments verbatim; absent keys are absent, not defaulted. `tool_response` is a plain object
whose key set **depends on `output_mode`** — three different shapes, not one shape with optional fields:

```ts
// output_mode: "content"           (c1 call 1 → grep-content.json)
{ mode: "content"; numFiles: 0; filenames: []; content: string;
  numLines: number; totalLines: number; appliedLimit?: number; appliedOffset?: number }

// output_mode: "files_with_matches"  (c1 call 2 → grep-files.json)   ← no `content`, no `numLines`
{ mode: "files_with_matches"; filenames: string[]; numFiles: number; totalFiles: number;
  appliedLimit?: number; appliedOffset?: number }

// output_mode: "count"              (c1 call 3 → grep-count.json)    ← no `totalFiles`, no `numLines`
{ mode: "count"; numFiles: number; filenames: []; content: string; numMatches: number;
  appliedLimit?: number; appliedOffset?: number }
```

`{content, numLines}` alone would have been wrong: `numFiles` and `filenames` are present in content mode too, and they
are **hard-coded to `0` and `[]` there**. An adapter that reads `numFiles` to learn how many files matched gets `0` for
every content-mode search.

### What the numbers actually count

| field | content mode | files_with_matches | count mode |
|---|---|---|---|
| `numFiles` | always `0` | files returned after truncation | files that had a parseable `path:N` line |
| `filenames` | always `[]` | the returned paths, **sorted by mtime desc**, not alphabetically | always `[]` |
| `numLines` | **ripgrep output lines returned** — matches *plus* `-A/-B/-C` context lines and `--` separators, not matches and not files | absent | absent |
| `totalLines` | output lines before `head_limit`/`offset` | absent | absent |
| `totalFiles` | absent | files before `head_limit`/`offset` | absent |
| `numMatches` | absent | absent | sum of the per-file counts |
| `appliedLimit` | present **only when the limit actually cut something**; its value is the limit, not the number dropped | same | same |
| `appliedOffset` | present only when `offset > 0` | same | same |

Observed instance: 5 files × 4 matching lines gave `numLines: 20, totalLines: 20, numFiles: 0`, while the same search in
count mode gave `numMatches: 20, numFiles: 5`. So `numLines` counts neither matches nor files; it counts rendered lines.

### Two different truncations, and only one of them is visible to the hook

1. **`head_limit`, default 250.** 400 ripgrep lines became `numLines: 250, totalLines: 400, appliedLimit: 250`. This is
   visible in `tool_response`, so §6's "no native truncation" precondition is checkable: `appliedLimit !== undefined ||
   appliedOffset !== undefined || totalLines > numLines`.
2. **The result-size cap, invisible in `tool_response`.** That same call carried **27391 characters** of `content` into
   the hook, but the host had already decided the model would not get them: the model-facing result was replaced by
   `<persisted-output>\nOutput too large (26.8KB). Full output saved to: <session>/tool-results/<tool_use_id>.txt\n\nPreview (first 2KB):\n…`.
   The model itself reported `CALL4_LINES: 18` — eighteen preview lines out of 250. Nothing in `tool_response` says this
   happened.

   **Consequence for §10 and §11:** the bytes a hook sees are not the bytes the model was going to receive. Above the cap
   the host already spends ~2 KB regardless of what a filter does, so "saving" against the 27 KB the hook saw would be a
   fabricated number. The window where a selective filter can save anything at all is roughly *8 KiB (§6 floor) up to the
   cap*, and a filter that fires above the cap makes the result **larger** unless it also beats the 2 KB preview.

## `PostToolBatch` — do not share a parser with `PostToolUse`

Fired once per Grep call (4 events for 4 calls), after the corresponding `PostToolUse`:

```ts
{ session_id, transcript_path, cwd, prompt_id, permission_mode,
  effort: { level: string },            // object, as in the V5 probe
  hook_event_name: "PostToolBatch",
  tool_calls: Array<{ tool_name: string; tool_input: object; tool_use_id: string;
                      tool_response: string }> }   // ← STRING, the rendered model-facing text
```

Three incompatibilities with `PostToolUse`: the payload nests everything under `tool_calls[]`; `tool_response` is the
**rendered string**, not the structured object; and there is no `tool_use_id`/`tool_name`/`duration_ms` at top level.
Its `tool_response` did show the post-hook value (the 506-char replacement in `c2`, the `<persisted-output>` block in
`c1`), so it is a usable *read-only* check of what the model received — but it is a different event with a different
contract and must not be fed to the Grep response parser. The host's own output schema for this event accepts only
`additionalContext`; there is no `updatedToolOutput` on `PostToolBatch`.

## Recovery archive: default denial, and the narrow grant that works

`~/.local/state/jev-gate/context/<opaque>/snapshot.json`, directory `0700`, file `0600`, read from a session whose cwd
was a *different* project.

| cell | configuration | result |
|---|---|---|
| `c5a` | `--allowedTools 'Read'` | **denied**: `Claude requested permissions to read from <path>, but you haven't granted it yet.` |
| `c5b` | `--allowedTools "Read(<abs>/**)"` | denied, same text |
| `c5c` | `--allowedTools "Read(//<abs>/**)"` | denied, same text |
| `c5d` | `--allowedTools 'Read' --add-dir <dir>` | denied, same text |
| `c5e` | `--add-dir` on **two** directories, one an ordinary directory under `$HOME` | **both** denied — so this is not about `.local/state` being special |
| `c5f` | `--settings <file>` **with** `--setting-sources project,local` | denied — the flag file is not one of `user,project,local`, so it was never loaded |
| `c5g` | `--settings <file>`, no `--setting-sources` | **read succeeded**, canary returned |
| `c5h` | `--settings` with **only** `permissions.additionalDirectories: ["<dir>"]` | **read succeeded** |
| `c5i` | `--settings` with **only** `permissions.allow: ["Read(//<abs>/**)"]` | **read succeeded** |

So the archive is readable by the native `Read` with no new tool, and **either** grant alone is enough — the narrowest
being `additionalDirectories: ["~/.local/state/jev-gate/context"]`. Nothing was widened permanently: every grant lived in
a scratch settings file for one cell. Two cautions for the README text §8 will need:

- Passing `--allowedTools` at all replaced the permission set in these runs; neither `--add-dir` nor a `Read(...)` rule
  inside `--allowedTools` unlocked an outside-cwd path, including an ordinary directory (`c5e`). A user who launches with
  a restricted `--allowedTools` will not be able to recover, and the plugin cannot detect that in advance.
- **The model refuses a recovery instruction that reads like an exfiltration probe.** In `c5b`/`c5c`/`c5d` (superseded
  runs) the session declined on its own — "the request… has the shape of a prompt-injection/exfiltration probe" — before
  permissions were even consulted, because the prompt asked it to read an unexplained absolute path and echo back a named
  field. The §8 disclosure must stay a plain factual sentence; a rigidly formatted "read this path and report field X"
  notice is a way to get the recovery refused by the model rather than by the host.

## Other host facts worth recording

1. **`updatedToolOutput` is validated against the tool's own output schema.** The installed binary carries the string
   `PostToolUse hook returned updatedToolOutput that does not match <tool>'s output shape; using original output.` and
   `A host-asserted classifier context attached by the same hook was discarded with the rejected rewrite.` The observed
   behaviour in `c3` matches: original preserved, hook not punished, nothing surfaced. **A rejected replacement is
   indistinguishable from an emitted one from inside the hook** — this is precisely why §10 separates
   `replacement_emitted` from `host_applied`, and there is no in-process signal to bridge them.
2. **A valid replacement is delivered verbatim.** The transcript `tool_result` content was byte-for-byte the hook's
   `content` string — the host re-rendered it through the same content-mode renderer and added nothing.
3. **`additionalContext` is invisible to every log.** In `c4` the model quoted the disclosure twice, but the string
   appears nowhere in `stream.jsonl`, nowhere in the persisted transcript, and not in `PostToolBatch.tool_response`.
   Its tokens are real and its bytes are unmeasurable from any artifact — so §10 must count the disclosure from the
   string the hook emitted, never from the transcript.
4. **Hook input keys on 2.1.276 for these events** (values withheld): `PreToolUse` on Grep — `cwd, effort,
   hook_event_name, permission_mode, prompt_id, session_id, tool_input, tool_name, tool_use_id, transcript_path`;
   `PostToolUse` adds `duration_ms, tool_response`; neither carries `agent_id`/`agent_type` at the root. `effort` is
   again an object (`{"level":"high"}`), confirming the V5 defect where `src/hook.ts` accepts it only as a string.
5. **A `PostToolUse` matcher of `^Grep$` works and fires exactly once per call.** No batching, no duplicate delivery.
6. **`--no-session-persistence` means no transcript file exists**, though `transcript_path` is still populated in the
   hook input and points at a path that was never created. Any evidence that depends on the transcript must drop that
   flag; `PostToolBatch` is the alternative that survives it.

## Cost and time

API-equivalent cost from each session's final `result.total_cost_usd` (subscription login):

| cell | purpose | cost USD | wall s |
|---|---|---|---|
| c1-capture | 4 Grep calls: content, files_with_matches, count, truncated | 0.2199 | 27.8 |
| c2-replace | valid replacement, 2 of 5 markers | 0.0950 | 5.6 |
| c3-invalid | 3 invalid replacement shapes | 0.1153 | 9.5 |
| c4-addctx | additionalContext alone, then with a replacement | 0.0996 | 5.4 |
| c5a…c5i | recovery-archive permission matrix (9 cells) | 1.0526 | 129.2 |
| **total (13 recorded sessions)** | | **1.5824** | ~178 s of model time |

Seventeen headless sessions were launched in all; four early recovery attempts were superseded and their run directories
overwritten, so their cost is **unknown, not zero** (§10). No TypeSafe/Jev call was made, no benchmark was run, nothing
was committed, pushed, tagged or published, and no product source was modified.

## What remains unknown

- **Interactive TUI.** Every cell was headless `-p`. Replacement was not exercised in a real pane.
- **Subagent Grep.** No `agent_id` was ever present; whether a child session's Grep reaches a root-registered
  `PostToolUse` hook was not tested. §1 passes subagents through regardless.
- **Two hooks replacing the same Grep result.** Out of scope by §3; the binary's own wording ("hooks run in parallel on
  the ORIGINAL output… last-write-wins") says the outcome is order-dependent, which is a reason to keep it out of scope,
  not evidence of what happens.
- **The exact cap.** The result-size cap was observed to fire between 1298 and 27391 characters and reported as
  "26.8KB"; the precise threshold, and whether it counts characters or tokens, was not bisected.
- **`appliedOffset`.** Never produced, because no probe used `offset > 0`. Its presence rule is inferred from
  `appliedLimit`'s observed behaviour and from the binary, not observed.
- **CRLF, colons in paths, non-ASCII paths.** The fixture repository used plain ASCII paths with no colons, so the
  `path\0line:text` parsing hazards in §6 are still untested against a real host.
- **Persistence threshold interaction.** Whether a *replacement* that exceeds the cap is itself persisted to a
  tool-results file was not tested; only the original was observed crossing it.
