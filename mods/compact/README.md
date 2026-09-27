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
| `budgetChars` | `40000` | Characters for the digest and the kept tail together, 8000–400000. |
| `compactSubagents` | `true` | Also answer a subagent's own auto compactions. |
| `compactManual` | `false` | Also answer `/compact` typed without instructions. Keep it off: see the host defect below. |

An option it cannot use turns it off and logs the field name once per session. Every decision logs one
`jev-compact {...}` debug line (sizes, the fallback reason, and in shadow the engine's time and usage).

## What it keeps

- **The tail** starts at an assistant message, so every tool_result in it answers a tool_use in it, and it always
  holds the last assistant message and what follows (often the large result that crossed the threshold). It grows back
  within 40% of the budget. When the last exchange alone is over twice the budget, the engine compacts instead.
- **The digest** gets the rest, and never less than 30%: the previous summary (up to 30%), the requests (the newest up
  to 2,000 characters, earlier ones 400), then for each earlier assistant message, newest first, its narration (400) and
  tool inputs (240 each), then result excerpts (1,200 each), newest first. Pieces are chosen by that priority and
  printed oldest first. Engine-injected user text (`<system-reminder>`, task notifications, command echoes) is not a
  request.
- **A digest it wrote earlier** is taken apart at the next compaction: its previous summary stays the summary, its
  requests and steps join the new ones as the oldest, so the newest survive the cut rather than the oldest.

## Evidence (2026-09-27)

**Offline, the shipped function over real compactions** (`bench/compact/eval.ts`, 40 seeded auto compactions from the
past week's local transcripts, main and subagent). The metric is the share of referents (paths, SHAs, `#N`,
identifiers) that the next 12 assistant turns used in tool inputs and that existed before the compaction, found in
what the model holds afterwards. The host's side counts its summary, the messages it kept and the files it re-attached.

| | recall | ≥ host | size (chars) |
|---|---|---|---|
| host: summary + kept messages + re-attached files | 0.742 | — | 38,600 |
| digest, 30,000 | 0.800 | 27/40 | 30,000 |
| digest, 40,000 (default) | 0.850 | 30/40 | 40,000 |
| digest, 50,000 | 0.878 | 32/40 | 50,000 |

Chained, as if active through whole sessions (each digest built over the previous digest, its tail and the messages
since): 191 later compactions in 12 sessions, host 0.699, digest 0.742 (≥ host at 133). The gap holds with depth: at
the 16th–31st compaction 0.682 vs 0.712, at the 32nd–63rd 0.727 vs 0.801. No compaction fell back.

The same 7-day transcripts put the host's own compactions at a 95-second median wait each.

**On an installed host** (2.1.283, Sonnet, `bench`-style probes in `~/jev-gate-runs/compact-probe-2026-09-27/`):
- One process, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=80000`, twelve 22 KB files read in order: three auto compactions
  answered in 6, 2 and 21 ms (the boundary's `durationMs`), each taking the context from about 67K to about 37K
  tokens; at the end the model listed all twelve secret words without re-reading, the early ones from chained digests.
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
