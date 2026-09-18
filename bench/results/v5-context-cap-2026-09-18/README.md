# The model-facing result cap, bisected — 2026-09-18

Host: Claude Code **2.1.276**, macOS 26.2 (Darwin 25.3.0), node v22.23.2, official Claude.ai team subscription login.
Same host version as `v5-context-probe-2026-09-18`, which left this threshold as the largest open unknown: it fired
somewhere between 1,298 and 27,391 characters and was reported as "26.8KB", never bisected. This run bisects it.

Thirty-five headless cells, one `Grep` each, $4.5851 total. Work happened in a disposable repository under
`~/jev-gate-runs/v5-context-cap-1/`; nothing in `src/`, `agents/`, `hooks/` or `bench/v5/` was touched by the probe.
The generator, the cell runner and the TEST-ONLY probe plugin are in `cells/`, so the run is reproducible without the
session scratchpad. The product plugin was not loaded — `jev-gate` registers `PostToolUse` only on `^Agent$`, so it
cannot see `Grep`, and leaving it out keeps a second hook off the same tool output.

The evidence for "the model actually received X" is never the hook's own view of `tool_response`. It is the
`PostToolBatch` event, which carries `tool_response` as the **rendered** string — what the host handed the model.
Each cell records the pair, and a cell counts as capped when those two sizes differ.

## The answer

> **The cap is 20,000 characters, and it counts characters, not bytes.**
> At 20,000 the result is delivered whole. At 20,001 the model receives a `<persisted-output>` notice plus a preview of
> roughly 2 KB and a saved-output path. Nothing in `tool_response` says this happened.

Both halves were measured, and the second is the one that matters for this codebase:

| cell | characters | bytes | what the model received | verdict |
|---|---|---|---|---|
| `CAPMARK20000` | 20,000 | 20,000 | 20,000 bytes | delivered whole |
| `CAPMARK20001` | 20,001 | 20,001 | 2,117 bytes | **capped** |
| `KOMARK20000` | 19,974 | **51,894** | 51,894 bytes | delivered whole |
| `KOMARK20300` | 20,276 | 52,676 | 5,338 bytes | **capped** |

`KOMARK20000` is decisive on its own: **51,894 bytes sailed through** while 20,001 ASCII bytes did not. A byte cap
cannot produce that. The full monotone ladder — 2,030 characters up to 21,891, plus the three Korean cells — is in
`measurements.json`; every cell below 20,001 characters was delivered whole and every cell above it was capped, with no
exceptions.

**This contradicts an assumption already in the code.** `MIN_CONTENT_BYTES` is a byte floor, and the probe's README
described the usable window as "8 KiB up to the cap" as though both ends were bytes. They are not the same unit. On
Korean or other non-ASCII source a result can be three times the byte size and still be under the host's ceiling, so a
byte-denominated ceiling would switch the filter off exactly where it has the most to save.

## What the earlier "26.8KB" was

It was the size of the output, not the threshold. The host's notice reads `Output too large (21.4KB)` for a
21,891-character result and `Output too large (19.6KB)` for a 20,001-character one — it reports what it measured, never
the limit it applied. Reading 26.8 KB as the threshold would have put the ceiling 6 KB too high, and every result
between 20,000 and 27,400 characters would have been filtered in a range where the host had already replaced it.

## The other ceiling, which is nearer

`head_limit` defaults to **250 lines**, and it binds first on ordinary results. The first ladder used 56-character
padding and never exceeded 21,891 characters, because at ~87 bytes per line 250 lines is all there is: the cells for
22,000 through 28,000 all returned the identical 21,891 characters with `appliedLimit: 250, totalLines: 286…320`. A
result only reaches the character cap when its lines are long — the second ladder used 200-character padding, which
puts 20,000 characters inside 87 lines. Both ceilings are real and the line one is hit more often.

## Cost, and why it was ten times the estimate

$4.5851 across 35 cells — about $0.13 each — against an estimate of $0.20–0.50 for the whole run, given before it
started. The estimate was wrong about where the money goes. Almost none of it is the search result: a representative
cell reports `input_tokens: 4, output_tokens: 107` beside `cache_creation_input_tokens: 42036` and
`cache_read_input_tokens: 72074`. **The cost is booting a fresh session**, and it is nearly identical whether the cell
measures 2 KB or 21 KB.

One session per size was chosen so that nothing accumulated between measurements. That reasoning was sound and the
conclusion was still expensive: batching the ladder into one session would have paid the boot once instead of
thirty-five times. For a sweep whose per-cell payload is small, a single session with many tool calls is the cheap
shape, and cross-cell independence should be bought some other way — a fresh working directory per call, not a fresh
session.

## Not settled here

- **The preview size.** Capped ASCII cells rendered 2,115–2,117 bytes and the capped Korean cell rendered 5,338. The
  notice says "first 2KB". Whether the preview is 2,000 characters, 2 KiB of bytes, or something else was not measured:
  these numbers include the notice text and the saved-output path, and neither was subtracted.
- **Whether a *replacement* above the cap is itself capped.** No cell emitted `updatedToolOutput`; this run only
  observed. A filter that returns more than 20,000 characters may well be persisted the same way.
- **`appliedOffset`.** Still no cell used `offset > 0`, so the key is checked on the host's naming, not on an observation.
- **Interactive TUI.** Every cell was headless `-p`, as in the earlier probe.
- **Other tools.** Only `Grep` was measured. Whether the same 20,000-character rule governs `Read`, `Bash` or `Glob`
  output was not tested, and nothing here should be read as saying it does.
