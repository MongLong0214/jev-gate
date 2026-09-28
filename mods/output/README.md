# jev-gate-output

A Claude Code Function Hooks plugin for one kind of Bash result: a passing `vitest run` log too large for the host to
send inline. The host saves such output to a file and gives the model a 2 KB preview of it. This plugin reads that
file, from the path the host's own result names, folds each run of three or more byte-identical consecutive lines to
one line followed by its exact count, and sends the whole folded log instead, with a first line saying that only
repeats were folded and where the host's original is. Every other line stays, in order: test and suite names,
statuses, skipped and todo, warnings, totals.

**It calls no Jev, sends no HTTP request, and writes no file.** It does not summarize and does not guess which lines
matter.

## Enable

Install it from the repository's marketplace. Function Hooks are gated in the host, so
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` must be in the environment Claude Code starts in (for example under `env` in
`~/.claude/settings.json`):

```sh
claude plugin marketplace add MongLong0214/jev-gate
claude plugin install jev-gate-output@jev-gate --config enabled=true
```

From a checkout, `claude --plugin-dir /path/to/jev-gate/mods/output` loads the working tree instead.

Off by default; off registers no hook at all. Options live under `pluginConfigs["jev-gate-output@jev-gate"].options`
(`jev-gate-output@inline` for a `--plugin-dir` load).

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. |

An option it cannot use turns it off and logs the field name once per session. Each `vitest run` it looks at logs one
`jev-output {...}` debug line: `applied` with the number of folded runs, or the reason it skipped.

## When it applies

One `tool.call` hook on Bash. The command runs once, as the host runs it (`next` is called once and never again; an
error or cancellation of the call passes up untouched). The result is changed only when all of these hold, and is
otherwise handed on as the same object:

- **The command** is `vitest run` called directly (`npx`, `pnpm exec`, `yarn`, `bunx` in front are fine) with plain
  arguments. `npm test`, a pipe, a redirect or a compound command is left alone: its output is not a known log.
- **The host says it finished normally**: no deny, no `isError` (the host raises one for a non-zero exit), not
  interrupted, not an image, not backgrounded, no `returnCodeInterpretation`, empty `stderr`, no structured content, and
  no hint the host appends (`staleReadFileStateHint`, `ghRateLimitHint`).
- **The host persisted it**: `persistedOutputPath` and `persistedOutputSize` are both set. An inline result is left
  alone. Only that path is read; a path printed in the output is never read.
- **Its size is 1 MiB or less** by `persistedOutputSize` (bytes), checked before anything is read. The file read must
  then have exactly that many UTF-8 bytes, or it is not the file the host described.
- **The log is a complete passing Vitest run**: it opens with ` RUN  v…` and ends with Vitest's summary with nothing
  failed (`Test Files`, `Tests`, `Start at`, `Duration`). A line with a colour or redraw escape, a carriage return, a
  failure or error marker (`FAIL`, `failed`, `Error`, `×`, `❯`, `⎯`), a code frame, a diff, JSON or source code
  leaves it alone, as does a log with nothing to fold.
- **It is smaller**: the folded log with its note is at least 512 UTF-8 bytes under the text the model would have read
  (the host's preview, not the whole file). This avoids a change that is not worth making; it is no promise of saved
  tokens.

Any failure of its own step (the read, the fold) hands on the host's result. The folded result keeps every field the
host set except `persistedOutputPath` and `persistedOutputSize`: with them, the host's mapper would send a 2 KB preview
of the folded text instead of the text. The path is in the note instead, and the file stays where the host put it for
as long as the host keeps it; this plugin promises nothing past that. Read and Grep of it are not hooked.

Only byte-identical consecutive lines are folded. Terminal progress redraws and repeated banners are not: without a TTY,
Vitest 5 prints neither, and a log with escape codes or carriage returns is left alone. There is no metadata saying the
exact output was asked for, so nothing is bypassed on that ground; the rule above removes no unique line either way.

## What the host exposes (2.1.283)

- **The Bash result** at `tool.call` (`claude-code.d.ts`, `BuiltinToolResults.Bash`): `stdout`, `stderr`,
  `interrupted`, `isImage`, `backgroundTaskId`, `returnCodeInterpretation`, `persistedOutputPath` ("Path to the
  persisted full output in tool-results dir") and `persistedOutputSize` ("Total size of the output in bytes"), and
  `text`, the result as the model reads it. In this owner's transcripts on 2.1.283, `persistedOutputSize` equalled the
  file's size in bytes, `stdout` held its first 30,000 bytes and the model read a preview of about 2.1 KB.
- **The mapper** (read from the 2.1.283 binary): with `persistedOutputPath` set it sends a `<persisted-output>` preview
  of about the first 2 KB of `stdout` (its limit is 2000); without it, `stdout` trimmed, then `stderr` and the hints,
  joined by newlines. A non-zero exit that is not reinterpreted raises the call as an error.
- **Reading**: `$.fs.read(path)` returns the whole file as text and rejects over 4 MiB, so no read copies more than
  that; there is no ranged read. The 1 MiB limit is checked on the host's size before the read.

## Checked on the installed host

2.1.283, Haiku, `claude -p --plugin-dir mods/output` with `enabled` set, one `npx vitest run --reporter=verbose` whose
tests log one line 3,000 times (54,817 bytes, persisted by the host): the hook logged `applied`, the tool result the
model received was the folded log with the note (1,214 bytes, where the host's preview is about 2.1 KB), the
transcript stored the result without the persisted fields, the original stayed at the host's path, and a Read of that
path in the same session returned its lines. That is one run on a toy suite.
