# Evidence (in the jev-gate plugin)

A Claude Code MCP server with one read-only tool, `jev_evidence`. It searches the one project you configure and
returns exact source windows (16 lines around an exact-symbol hit, otherwise at most 40 lines; 8 KiB at most) with their path, 1-based lines and the SHA-256 of the
whole file, a page at a time. A returned reference can be sent back to read exactly that window again. With `remote`
on and a TypeSafe key, a semantic page is judged by Jev: windows are ordered relevant first, and in `locate` a clearly
unrelated window keeps its reference and judgement but not its text.

It reads only files under the roots you allow, never writes one, and runs no command but a fixed-argument
`git ls-files`. Source leaves the machine only when `remote` is `true`, the key is present and the call is a semantic
search; exact-symbol lookups and read-backs never send anything.

## Configure

Nothing, by default (v0.6.2). Started by Claude Code, the server searches the Git worktree that holds the session's
directory (`CLAUDE_PROJECT_DIR`, which the host sets for a plugin's server), all of it, with remote on when
`TYPESAFE_API_KEY` is present: installing the plugin with a key is the opt-in to sending a semantic page to Jev. A
session outside any Git worktree gets `unsupported_inventory` on every call.

To narrow the roots, exclude paths or keep a project's source on the machine, the server instead reads one JSON file
named by `JEV_EVIDENCE_CONFIG` (an absolute path, at most 64 KiB) when it starts:

```json
{
  "projectRoot": "/absolute/path/to/worktree",
  "allowedRoots": ["src", "tests"],
  "excludeGlobs": ["**/private/**"],
  "remote": false
}
```

`projectRoot` must be a Git worktree. `.git`, `.env*`, keys and other credential files, dependency, vendor and build
directories, symlinks, submodules, binary and non-UTF-8 files are always excluded. The config is fixed for the life
of the process. Editing the JSON does not change a server that is already running, and `/reload-plugins` is not a
guarantee that a live MCP process re-reads it. End the Claude session and start it again. For another project or worktree, point
`JEV_EVIDENCE_CONFIG` at another config in that project's settings; a tool argument never moves the root. Do not put the API key in this file.

The key is read only from `TYPESAFE_API_KEY` in the server's environment, never from the config or a `.env` file.
Both variables come from the environment Claude Code starts in, for example a project's `.claude/settings.local.json`:

```json
{ "env": { "JEV_EVIDENCE_CONFIG": "/absolute/path/to/evidence.json" } }
```

With `JEV_EVIDENCE_CONFIG` set but invalid, the server still starts and lists the tool, and every call returns
`unavailable_config` without reading a source or sending a request; it never falls back to the session default.

## Install

It ships inside the `jev-gate` plugin (v0.6.0; v0.5.0 and v0.5.1 shipped it as its own `jev-gate-evidence`), which
the marketplace pins to the release archive by SHA-256:

```text
/plugin marketplace add MongLong0214/jev-gate
/plugin install jev-gate@jev-gate
```

From a checkout, `npm ci && npm run build` and then `claude --plugin-dir .` loads the whole plugin from the working
tree; `claude --plugin-dir plugins/evidence` loads this server alone (as `jev-gate-evidence`), and
`node scripts/pack.mjs dist-pack --profile evidence` still builds that standalone archive. The bundled server has the
MCP SDK inside it; it needs Node 22 or later and nothing else. To turn it off, disable the `evidence` server in `/mcp`.

`node <plugin dir>/plugins/evidence/dist/server.mjs --doctor` (`<dir>/dist/server.mjs` for the standalone archive) prints where the config came from (`explicit` or `session`), the project root, how many roots and exclusions are in force, whether remote is on, and whether the key is present. It reads the config only: no source scan, no request. A passing doctor says the server can start, nothing about key validity, answer quality, or that a later edit of the JSON is already in effect.

## Use

The manual skill `/jev-gate:evidence <question>` asks Claude to answer with this tool. It runs only when you
type it; nothing else in a session calls the tool unless Claude chooses to.

| Need | Arguments | Jev |
|---|---|---|
| Where a name occurs | `{ "goal": "…", "exactSymbols": ["parseRequest"] }` | never |
| Code for a question in other words | `{ "goal": "압축 digest 예산 배분", "queryTerms": ["buildDigest", "budget"], "roots": ["mods/compact/hooks"] }` | when remote |
| The next page | the same arguments plus `"offset"` and `"expectedSnapshot"` from `next` | when remote |
| A window back, exactly | `{ "goal": "…", "sources": [{ "path": "<path>", "startLine": 1, "endLine": 16, "fileSha256": "<64 lowercase hex digits>" }] }` | never |
| More lines around a hit | the same `path` and `fileSha256` with a wider `startLine`/`endLine` (≤ 40 lines) in `sources` | never |
| Every window in a small scope | `{ "goal": "…", "mode": "audit", "roots": ["src/evidence"] }` | when remote, never folded |

`remote: false` turns off Evidence's sends to TypeSafe only. The server still reads local files, and Claude's own model calls are unchanged. It is not an offline mode for Claude. To stop this server from reading files, disable the `evidence` MCP server (or the plugin). A Native Read deny is not inherited by this reader; if the same restriction cannot be applied here, disable the server. Built-in exclusions are a filter, not a DLP, a retention promise, or proof that an organization approved the send. A key being present is not proof that it is valid or that a request will succeed.

With `remote: false` or no key, searches run locally and say so (`remote_disabled`, `missing_key`). The two are different: remote off is a setting, a missing key is an absent credential while remote is still on.

`queryTerms`, when you pass them, are the only lexical hints. The goal is not trimmed and is still the question sent
for semantic judgement, along with `constraints`. Without `queryTerms`, locate takes terms from the goal. More than
128 unique terms is an input error (`invalid_input`): pass short `queryTerms` or a narrower question. Narrowing
`roots` does not raise that cap. Exact-symbol, audit, and `sources` reads are not rejected for unused words in the goal.

`status: "partial"` means something was not read, judged or included; `coverage` and `reasonCodes` say what. A page
stopped by the 1,024-candidate cap or by the cooperative search budget is the prefix collected in file and line order
(locate then scores only that prefix), not the repository's global top. An empty page is not proof of absence, and an
audit page is not a completed audit. Continuing requires the same snapshot (`next.offset` and `next.expectedSnapshot`).
A stop that depends on time can differ between calls; there is no cursor for it. A read-back of a file that changed
returns `stale` without text rather than the new text under the old reference.

## Bounds

At most 200 files, 256 KiB per file and 16 MiB read per call, 128 unique lexical terms, 1,024 candidates, a page of
16, and one 3-second cooperative budget for the whole call — reading, candidate generation and at most 1.5 seconds of
Jev share it. That budget is cooperative: it is not an operating-system or network guarantee. Two Jev requests of
eight candidates per call with no retry, two calls and four Jev requests at once per server (a third call is refused
as `busy`), and 64 KiB per result. Jev judgements of a completed page are cached in memory for 10 minutes, keyed by
the exact text sent. A page stopped because candidate generation ran out of budget is not sent to Jev; the files
already chosen for that page may still be re-read while the total budget and the verify reserve remain.

## Checked

On Claude Code 2.1.283, headless (`-p`), with `--plugin-dir plugins/evidence` and with `--plugin-dir` on the packed
archive unzipped under a path with spaces, run from another directory:

- **Observed:** the server connects; the tool is listed as `mcp__plugin_jev-gate-evidence_evidence__jev_evidence`
  (deferred, loaded through ToolSearch) and the skill as `jev-gate-evidence:evidence`; an `exactSymbols` call and a
  `remote: true` search with a real key return results; the skill, given a Korean question, sent English
  `queryTerms` and answered from two calls.
- **Not observed on a host:** a cancellation from the host, `busy`, an interactive session, and any saving in tokens or time.

The SDK client tests start the bundled server from an unpacked archive over stdio; they are not a host observation.

In v0.6.0, inside the `jev-gate` plugin (2.1.283, `--plugin-dir` of the repository): the server connected as
`plugin:jev-gate:evidence`, the skill loaded as `jev-gate:evidence`, and ToolSearch returned
`mcp__plugin_jev-gate_evidence__jev_evidence`. The observations above were made on v0.5.x, under the old names.
