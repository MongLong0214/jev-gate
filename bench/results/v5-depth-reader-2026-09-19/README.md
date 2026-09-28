# The depth reader — the number that decides is one the hook can compute — 2026-09-19

Step 1 of `DECISION-depth-gate-2026-09-19.md`. Every previous result in this repository was conditional on one thing
the gate could not see: how much context the main session was already carrying. Forced orchestration measured **+182 %**
at 55K and **−57 %** at 406K. That number is now read from the host's own transcript, in code, before Gate A is asked
anything — and below the floor no request is sent at all.

## Proof (a) — the reader reproduces the replay's number on the real sessions

`replay.mjs` runs the shipped `readSessionDepth` against every recorded transcript over 20 MB and compares it with the
forward scan `prompts-depth.mjs` used for `v5-context-locality-2026-09-19`.

| | |
|---|---|
| transcripts (> 20 MB) | **11**, largest 276.3 MB |
| agreement at EOF | **11 / 11** |
| agreement at real prompt positions (4 per file, prefix copies) | **44 / 44** |
| `depth_unknown` at EOF | **0 / 11** |
| bytes read | **262,144 on every file** — one chunk, never more |
| slowest read | **0.7 ms** |

The falsifier Fable named — the last usage line regularly sitting beyond the read cap — did not occur once. The 8 MB
cap is 32× the distance actually needed on the worst of these files.

## Proof (b) — a real session, through a real hook

A `UserPromptSubmit` hook running the built `dist/depth.js` over three prompts of one session:

| prompt | reading | wall |
|---|---|---|
| 1 (fresh session) | `depth_unknown` — the transcript does not exist yet | 0.09 ms |
| 2 | 39,050 | 1.98 ms |
| 3 | 39,265 | 0.34 ms |

An independent forward scan of the same file after the session ended reads 39,337: the third prompt's reading is the
depth **at prompt time**, before that turn's own usage line was written, which is the number the decision needs.

The first prompt of a fresh session reads unknown and therefore stays direct. That is the limitation Fable flagged
("depth at prompt time misses jobs that start shallow"), and it is also the correct call: a fresh session is the
condition under which delegation measured +182 %.

## Proof (c) — the host actually sends it

`transcript_path` is present on `UserPromptSubmit` in the current build. The keys observed on a live event:

```
cwd  hook_event_name  permission_mode  prompt  prompt_id  session_id  transcript_path
```

`parseInput` had been dropping it. The hook budget is 5,000 ms; the worst read measured here is 0.7 ms.

## What the reader is, exactly

The last non-sidechain transcript entry carrying `message.usage`, summed as
`cache_read_input_tokens + cache_creation_input_tokens + input_tokens` — the same definition the 61-prompt replay used,
so the recorded distribution (median 657K, 61/61 above the crossing point) applies to what the gate now reads.

Sidechain lines are skipped because a subagent's context is not this session's; reading one would admit a job on a
number describing a different turn. The read is bounded twice (8 MB, 200 ms) and runs backwards from the end, because
the sessions this is aimed at have transcripts of hundreds of megabytes.

## Not settled here

- **The floor is derived, not measured.** 300,000 sits between the only two end-to-end points that exist, nearer the
  measured win. Step 2 — a bench case that presents the job prompt at real depth — is what moves it.
- **4 of these 11 transcripts sit below 300K at EOF** (179K, 192K, 221K, 256K). The shipped floor would refuse those
  sessions entirely. Whether that is correct is exactly what step 2 measures; it is not evidence either way yet.
- **Nothing here is an end-to-end cost.** This step changed what the gate knows, not yet what a job costs. The forced
  arm remains the only evidence of the cost difference itself.
- The `depth_unknown` path has been exercised against a fresh session and a missing file, never against a corrupt or
  concurrently-rotated transcript.
