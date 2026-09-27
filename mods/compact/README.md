# jev-gate-compact

A Claude Code Function Hooks plugin that answers the host's auto compaction itself. The conversation before a recent
tail becomes one built user message (the digest): the previous summary, the person's requests, and a log of earlier
steps with each tool call's input and, while room lasts, an excerpt of its output. The tail stays as the engine has it,
except a last message that answers tool calls, which is handed up rebuilt with a closing line after its results (below).
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
- **The closing line.** When the tail ends in tool results (555 of 581 auto compactions in a week of transcripts), that
  last message is handed up built rather than by its handle: the same results, as text, with their ids and error flags,
  then one line saying the kept messages end there. The text is all a rebuild can carry, so it is done only when every
  result answers a built-in tool that returns text alone (Bash, Edit, Write, Grep, Agent, …; a Read unless its path is
  an image, a PDF or a notebook). A result with no text, or from any other tool (an MCP tool may send a screenshot
  beside its text), leaves that compaction to the engine (`opaque_result`). In a later week of transcripts that was 1
  of 376 compactions ending in results (an image Read); the other 375 came from Bash (290), Write, Edit, Read,
  SubagentHandback, Agent, SendMessage, AskUserQuestion, Glob and Grep.
- **The ceiling.** Sizes are characters of text, tool inputs and results, plus each call's and result's id and 40
  characters of structure, and 16 per message (the digest's own message included), so a stretch of many small calls is
  not counted as nearly free. Because
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
  printed oldest first. A long request or previous summary is cut in the middle, so its end survives: the last line of
  a request is often the instruction, and the engine's summary ends with the current work and the next step.
- **Requests** are what a user message says once the engine's own additions are cut out: blocks in its tags
  (`<system-reminder>`, task notifications, command echoes and output, `!` shell input and output) that start a line,
  as its own text blocks do, and the caveat it puts before command output. A message the engine wrote alone is not a
  request; one it added a reminder to still is, and a tag quoted inside a sentence stays part of it. The host does not
  say who wrote a message, so this is read from the text and can be wrong at the edges.
- **A digest it wrote earlier** (recognized by its whole header line and a last line carrying a checksum of the rest,
  exact but for whitespace around the whole message; one changed inside, even by a space, is read as a request,
  and only where a summary opens the conversation, before the first assistant message, so a request that starts with,
  quotes or pastes a digest and adds to it stays a request) is taken apart at the next
  compaction: its previous summary stays the summary, its
  requests and steps join the new ones as the oldest, so the newest survive the cut rather than the oldest. A content
  line that starts like a section heading (`## `) or a request marker (`▸ `) is written indented by one space, so a
  request or result that quotes them cannot move the parse.

## Evidence (2026-09-27)

**Offline, the shipped function over real compactions** (`bench/compact/eval.ts`, 40 seeded auto compactions from the
past week's local transcripts, main and subagent). Each digest is built from what the engine held at that boundary: the
records since the previous boundary, with the messages that boundary preserved placed after its summary. The metric is
the share of referents (paths, SHAs, `#N`, identifiers) that the next 12 assistant messages used in tool inputs and that
existed in that input, found in what the model holds afterwards. The host's side counts its summary, the messages it
kept and the files it re-attached.

| | recall | ≥ host | text (chars) |
|---|---|---|---|
| host: summary + kept messages | 0.721 | — | 32,900 |
| host: the same + re-attached files | 0.753 | — | 45,800 |
| digest, 30,000 | 0.712 | 23/39 | 29,300 |
| digest, 40,000 (default) | 0.767 | 28/39 | 39,000 |
| digest, 50,000 | 0.816 | 31/39 | 48,700 |

"≥ host" is against the host with its re-attached files. One of the 40 points, a subagent's, fell back
(`tail_too_large`). At the default the digest recalled less at 11 of 39 points, by 0.03 to 0.31. Both sides' sizes are
the rendered text the model holds (the budget's own count, with ids and structure, runs higher). The sample is the week
before the run and moves as new transcripts arrive, so changes to the module are compared on one sample (the last three
changes left every figure unchanged on theirs); two later samples put the host with its files at 0.677 and 0.736 and
the default digest at 0.733 and 0.777. Earlier runs on 2026-09-27 counted 12 transcript records rather than 12
messages, a shorter horizon, and drew higher recall on both sides; they are not comparable with these.

Chained, as if active through whole sessions (each digest built over the previous digest, its tail and the messages
since): 189 later compactions in 12 sessions, host 0.655, digest 0.665 (≥ host at 115). **The digest does not stay
ahead with depth:** it is ahead at the 1st–7th compaction (host 0.664–0.680, digest 0.708–0.726), behind at the
8th–15th (0.654 vs 0.617) and the 16th–31st (0.641 vs 0.614), and ahead again at the 32nd–63rd (0.638 vs 0.687).
No chained compaction fell back. A larger budget closes the gap: over the same chains the digest came to 0.695 at
50,000 (even at the 8th–31st), 0.725 at 60,000 (ahead at every depth, 0.682 to 0.776 against 0.638 to 0.680) and
0.765 at 80,000. At 60,000 a single digest holds about 58,300 characters against the host's 45,800.

The same 7-day transcripts put the host's own compactions at a 95-second median wait each.

**On an installed host** (2.1.283, Sonnet, `bench`-style probes in `~/jev-gate-runs/compact-probe-2026-09-27/`):
- One process, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=80000`, twelve 22 KB files read one per turn: three auto compactions
  answered in 2 to 7 ms over two runs (the boundary's `durationMs`), each from 67–69K tokens down to 7.3–9.5K (`preTokens`,
  `postTokens`); at the end the model listed all twelve secret words without re-reading, the early ones from chained
  digests.
- The host stored each digest unchanged, which the exact checksum relies on: rerun with the checksum in place, all
  three stored digests passed it and had the length the hook logged (5,179, 9,450 and 13,727 characters), and the
  second and third carried the opening request from the first. (An earlier run, before the checksum, compared lengths
  only.)
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

## Host placement: the session's own context lands after the kept messages

For its own compaction the engine re-attaches the session's instructions and context (CLAUDE.md files, date,
reminders) ahead of its summary. For messages a hook hands up it appends them after the last one, and it joins text that
follows a tool result into that result's content (2.1.283), so behind a tail that ends in tool results the owner's
CLAUDE.md arrived as part of the last tool's output. The result type has no field to place them.

On the installed host (2.1.283, Sonnet, the owner's full settings, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=120000`, the
twelve-file probe), after the first auto compaction the model said the tool output "carried a large injected
system-reminder block presenting itself as global CLAUDE.md orchestration rules", set it aside and ended its turn after
6 turns and 3 of the 12 files. A sentence in the digest header saying what that context was helped in two runs (all
twelve files, 4 hook compactions each) but not a third, which ended its turn after its third compaction at 9 of 12 files;
and a header that vouches for text the tool result ends with would vouch for a forged copy there too.

So the last message is rebuilt instead. The engine lays a built user message out as its tool results followed by its
text, and appends after a closing text block rather than into it; the re-attached context then comes after the closing
line, outside the results, where nothing a tool returned can follow it. Checked on the installed host by pointing it at a
local stand-in for the Messages API (no model runs; `bench/compact/fake-api.py`): at the first hook compaction
the last turn went out as the tool result alone (23,971 characters), the closing line, then the CLAUDE.md reminder as a
block of its own; with 622bbdf the same turn was one tool result of 42,570 characters with the CLAUDE.md reminder inside.
How a model continues after the rebuilt turn has not been run on the host.
