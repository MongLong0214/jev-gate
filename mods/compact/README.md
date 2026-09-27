# jev-gate-compact

A Claude Code Function Hooks plugin that answers the host's auto compaction itself. The conversation before a recent
tail becomes one built user message (the digest): the previous summary, the person's requests, and a log of earlier
steps with each tool call's input and, while room lasts, an excerpt of its output. The tail stays as the engine has it.
No model is asked, so a compaction sends no summarizer request and takes milliseconds instead of a minute or more.

**It calls no Jev.** Jev was tried in two places and neither earned it (below): ranking which tool exchanges to keep, and
deciding when a digest should fall back to the engine's own summary.

## Enable

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
claude --plugin-dir /path/to/jev-gate/mods/compact
```

Off by default; off registers no hook at all. Options live under `pluginConfigs["jev-gate-compact"].options` (or
`jev-gate-compact@inline` for a `--plugin-dir` load).

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. |
| `mode` | `shadow` | `shadow` builds and logs the digest and lets the engine compact, logging how long that took and what its summarizer used. `active` answers the compaction with the digest. |
| `budgetChars` | `40000` | Target characters for the digest and the kept tail together, 8000–400000. See the ceiling below. |
| `compactSubagents` | `true` | Also answer a subagent's own auto compactions. |
| `compactManual` | `false` | Also answer `/compact` typed without instructions. Keep it off: see the host defect below. |

An option it cannot use turns it off and logs the field name once per session. Every compaction it is asked about logs
one `jev-compact {...}` debug line: why it deferred to the engine, or the sizes, the fallback reason, and in shadow the
engine's time and usage.

## What it keeps

- **The tail** starts at an assistant message and holds both halves of every tool exchange in it, matched by
  `tool_use_id`: parallel calls in separate rows ahead of one row of results move the start back to the first call,
  and a result whose call is nowhere leaves the compaction to the engine. It always holds the last assistant message and
  what follows (often the large result that crossed the threshold) and every call still in flight (a tool_use no result
  answers yet), and grows back within 40% of the budget.
- **The ceiling.** Sizes are characters of text, tool inputs and results, plus each call's and result's id and 40
  characters of structure, and 16 per message, so a stretch of many small calls is not counted as nearly free. Because
  the last exchange is kept whole, the total can pass `budgetChars`: up to twice it for the
  tail plus 30% for the digest, 2.3 times in all. Past twice for the tail, or when the digest and tail would come to more
  than half of the conversation they replace, the engine compacts instead, so an answered compaction always at least
  halves what it was given. Both bounds hold in that count, ids and structure included, not in text alone: 500
  one-word exchanges and a 60K result went from 161.6K to 72.2K counted that way, but from 72.9K to 72.0K in text,
  since what was dropped was mostly ids and structure. Where the host compacts (well over 100K tokens of conversation)
  the ceiling is a small part of it either way.
- **The digest** gets the rest, and never less than 30%: the newest request (up to 2,000 characters), the previous
  summary (up to 30% of the budget and half of what is left, so a long summary cannot crowd out the newest request),
  earlier requests (400 each), then for each earlier assistant message, newest first, its narration (400) and
  tool inputs (240 each), then result excerpts (1,200 each), newest first. Pieces are chosen by that priority and
  printed oldest first. Engine-injected user text (`<system-reminder>`, task notifications, command echoes) is not a
  request.
- **A digest it wrote earlier** (recognized by its whole header line followed by nothing or one of its own section
  headings, and only where a summary opens the conversation, before the first assistant message, so a request that
  starts with or quotes the header stays a request) is taken apart at the next
  compaction: its previous summary stays the summary, its
  requests and steps join the new ones as the oldest, so the newest survive the cut rather than the oldest. A content
  line that starts like a section heading (`## `) or a request marker (`▸ `) is written indented by one space, so a
  request or result that quotes them cannot move the parse.

## Evidence (2026-09-27)

**Offline, the shipped function over real compactions** (`bench/compact/eval.ts`, 40 seeded auto compactions from the
past week's local transcripts, main and subagent). Each digest is built from what the engine held at that boundary: the
records since the previous boundary, with the messages that boundary preserved placed after its summary. The metric is
the share of referents (paths, SHAs, `#N`, identifiers) that the next 12 assistant turns used in tool inputs and that
existed in that input, found in what the model holds afterwards. The host's side counts its summary, the messages it
kept and the files it re-attached.

| | recall | ≥ host | text (chars) |
|---|---|---|---|
| host: summary + kept messages | 0.751 | — | 36,400 |
| host: the same + re-attached files | 0.792 | — | 49,400 |
| digest, 30,000 | 0.791 | 28/40 | 30,200 |
| digest, 40,000 (default) | 0.839 | 30/40 | 39,700 |
| digest, 50,000 | 0.865 | 34/40 | 49,200 |

"≥ host" is against the host with its re-attached files. At the default the digest recalled less at 10 of 40 points,
by 0.04 to 0.40. Both sides' sizes are the rendered text the model holds (the budget's own count, with ids and
structure, runs higher). The sample is the week before the run (2026-09-27), so a rerun on a later day draws different
points: an earlier run the same day, on a slightly different week, had host 0.732 and digest 0.803 at the default.

Chained, as if active through whole sessions (each digest built over the previous digest, its tail and the messages
since): 179 later compactions in 12 sessions, host 0.715, digest 0.761 (≥ host at 123). The gap narrows but holds with
depth: at the 8th–15th compaction 0.731 vs 0.733, the 16th–31st 0.700 vs 0.726, the 32nd–63rd 0.713 vs 0.789. No
compaction fell back.

The same 7-day transcripts put the host's own compactions at a 95-second median wait each.

**On an installed host** (2.1.283, Sonnet, `bench`-style probes in `~/jev-gate-runs/compact-probe-2026-09-27/`):
- One process, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=80000`, twelve 22 KB files read one per turn: three auto compactions
  answered in 2 to 3 ms (the boundary's `durationMs`), each from 67–69K tokens down to 7.3–9.4K (`preTokens`,
  `postTokens`); at the end the model listed all twelve secret words without re-reading, the early ones from chained
  digests.
- The same twelve files read in one turn of parallel calls make a single exchange over twice the budget: the hook
  defers, and the engine's own path declines as well ("no assistant messages in summarize set"), so that request goes
  out uncompacted, as it would without the hook.
- A resumed session after those auto compactions reloaded only the post-compaction state (about 67K, not the whole
  history), and an auto compaction inside a resumed process linked every record correctly.

**Recall is a proxy.** It counts referents the next turns used, not whether the work that followed was as good. The
engine's summary also states intent and the next step in prose; the digest carries the requests and the model's own
narration instead. The probes are single runs on a toy task.

## What Jev was asked, and why it is not here

- **Which exchanges to keep.** Jev Noul P(still needed) for each earlier tool exchange, with the latest request and
  recent narration as state, 40 points, 1.37M input tokens: the kept extract recalled 0.783 against 0.788 for plain
  recency at 1.5× the host's size; as a classifier of exchanges holding a later-used referent, AUC 0.589 against
  recency's 0.536.
- **When to fall back.** Jev Noul P(the extract suffices to continue), 39 points: AUC 0.653 between digests at least
  as good as the host's and the 8 worse ones, with every answer between 0.16 and 0.5. Not a threshold to route on, so a digest that can be built is used instead
  of asking.

## Host defect: keep `compactManual` off

When a `/compact` in a resumed headless session was answered by this hook, the host wrote the kept tool_result with
its pre-compaction parent: the next `--resume` followed that link and sent the whole old conversation (43.7K tokens,
all of it read from cache). Auto compactions, in a fresh or a resumed process, linked correctly in every probe. The
cause is in the host's transcript writer, not in what the hook returns.
