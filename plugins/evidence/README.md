# jev-gate-evidence

A Claude Code plugin with one read-only MCP tool, `jev_evidence`. It searches the one project you configure and
returns exact source windows (16 lines around an exact-symbol hit, otherwise at most 40 lines; 8 KiB at most) with their path, 1-based lines and the SHA-256 of the
whole file, a page at a time. A returned reference can be sent back to read exactly that window again. With `remote`
on and a TypeSafe key, a semantic page is judged by Jev: windows are ordered relevant first, and in `locate` a clearly
unrelated window keeps its reference and judgement but not its text.

It reads only files under the roots you allow, never writes one, and runs no command but a fixed-argument
`git ls-files`. Source leaves the machine only when `remote` is `true`, the key is present and the call is a semantic
search; exact-symbol lookups and read-backs never send anything.

## Configure

The server reads one JSON file named by `JEV_EVIDENCE_CONFIG` (an absolute path, at most 64 KiB) when it starts:

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
of the process: restart the server (or Claude Code) after changing it. For another project or worktree, point
`JEV_EVIDENCE_CONFIG` at another config in that project's settings; a tool argument never moves the root.

The key is read only from `TYPESAFE_API_KEY` in the server's environment, never from the config or a `.env` file.
Both variables come from the environment Claude Code starts in, for example a project's `.claude/settings.local.json`:

```json
{ "env": { "JEV_EVIDENCE_CONFIG": "/absolute/path/to/evidence.json" } }
```

Without a valid config the server still starts and lists the tool, and every call returns `unavailable_config`
without reading a source or sending a request.

## Install

This plugin ships as its own archive; it is not in the marketplace yet. From a checkout:

```sh
npm ci && npm run build
node scripts/pack.mjs dist-pack --profile evidence   # dist-pack/jev-gate-evidence-<version>.zip
```

Unzip the archive anywhere and load it with `claude --plugin-dir <unzipped dir>`, or load the working tree directly
with `claude --plugin-dir plugins/evidence` after `npm run build`. The archive holds the bundled server with the MCP
SDK inside it; it needs Node 22 or later and nothing else. To turn it off, start Claude Code without that
`--plugin-dir`, or disable the `evidence` server in `/mcp`. To remove it, delete the unzipped directory.

`node <plugin dir>/dist/server.mjs --doctor` prints the config state, whether remote is on and whether the key is
present. It reads the config only: no source scan, no request. A passing doctor says the server can start, nothing
about the quality of its answers.

## Use

The manual skill `/jev-gate-evidence:evidence <question>` asks Claude to answer with this tool. It runs only when you
type it; nothing else in a session calls the tool unless Claude chooses to.

| Need | Arguments | Jev |
|---|---|---|
| Where a name occurs | `{ "goal": "…", "exactSymbols": ["parseRequest"] }` | never |
| Code for a question in other words | `{ "goal": "압축 digest 예산 배분", "queryTerms": ["buildDigest", "budget"], "roots": ["src"] }` | when remote |
| The next page | the same arguments plus `"offset"` and `"expectedSnapshot"` from `next` | when remote |
| A window back, exactly | `{ "goal": "…", "sources": [<a returned source object>] }` | never |
| More lines around a hit | the same `path` and `fileSha256` with a wider `startLine`/`endLine` (≤ 40 lines) in `sources` | never |
| Every window in a small scope | `{ "goal": "…", "mode": "audit", "roots": ["src/evidence"] }` | when remote, never folded |

With `remote: false` or no key, searches run locally and say so (`remote_disabled`, `missing_key`).

`status: "partial"` means something was not read, judged or included; `coverage` and `reasonCodes` say what. An
empty page is not proof of absence, and an audit page is not a completed audit. A read-back of a file that changed
returns `stale` without text rather than the new text under the old reference.

## Bounds

At most 200 files, 256 KiB per file and 16 MiB read per call, 1,024 candidates, a page of 16, a 3-second cooperative
deadline of which at most 1.5 seconds go to Jev, two Jev requests of eight candidates per call with no retry, two
calls and four Jev requests at once per server (a third call is refused as `busy`), and 64 KiB per result. Jev
judgements of a completed page are cached in memory for 10 minutes, keyed by the exact text sent.

## Checked

The SDK client tests start the bundled server over stdio and call it. Whether a given Claude Code build lists and
calls the tool is recorded in the repository's changelog for the build it was checked on; a test run is not a host
observation.
