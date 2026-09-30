# Jev Gate for Codex

The native Codex plugin provides the same Evidence MCP service as Claude Code, conservative Vitest output folding, and a live view of Codex tools, agents and compaction. **It does not provide full Claude Code feature parity.**

Requires Node.js 22+ and Codex CLI 0.158.0 or newer. 0.158.0 is the tested host; newer host behavior must also pass the runtime tests. Codex app builds can expose different capabilities.

## Install from this checkout

At the jev-gate repository root:

```sh
npm ci
npm run build
codex plugin marketplace add "$PWD"
codex plugin add jev-gate@jev-gate-codex
```

In the Git project you want to work on, start a new Codex session with an explicit workspace:

```sh
export JEV_CODEX_WORKSPACE="$PWD"
codex
```

Set this again when switching projects. For desktop Codex, pass this environment variable to the app or configure `JEV_EVIDENCE_CONFIG` before launching it. Open `/hooks` and review/trust the Jev Gate hooks. Plugin installation does not trust hooks automatically. The plugin contains its dependencies; the installed copy needs Node, not `node_modules`. Rebuild before refreshing a local marketplace after source changes.

For a packed plugin, unpack `jev-gate-codex-<version>.zip`, add that extracted directory as the marketplace, then install `jev-gate@jev-gate-codex`. This native package is separate from the Claude marketplace package. Do not install a raw Git snapshot without first building it.

## Use it

Ask Codex to use `jev_evidence` to find source evidence. Results contain exact paths, line ranges and content hashes. Without `TYPESAFE_API_KEY`, searches stay local. With a key and remote enabled, candidate source windows and the search goal are sent to TypeSafe. Do not put keys in repository files.

**Workspace scope is fixed when the MCP server starts.** The MCP server uses the explicit `JEV_CODEX_WORKSPACE` directory to find the Git root; it ignores inherited `CLAUDE_PROJECT_DIR` and shell `PWD`. Codex starts bundled MCP processes in the installed plugin directory, so the server refuses searches when neither workspace nor explicit config is provided. To set explicit bounds, export `JEV_EVIDENCE_CONFIG` as the absolute path of a JSON file:

```json
{"projectRoot":"/absolute/project","allowedRoots":["src"],"remote":false}
```

Restart the MCP server after changing configuration. The Codex process must receive the environment variables; a desktop app opened outside that shell may not inherit them.

Run from the project you want to inspect, replacing `<plugin>` with the installed plugin directory (or `plugins/codex` in this checkout):

```sh
node <plugin>/dist/cli.mjs doctor
node <plugin>/dist/cli.mjs dashboard
```

The dashboard opens on `http://127.0.0.1:4731`; `--port 4732` selects another port. It streams real records and supports light/dark and Korean/English. From a source checkout, `node dist/cli.js dashboard --host codex` opens the same view.

## Native support

| Feature | Codex behavior |
| --- | --- |
| Evidence | Same local search, Jev judgments, pagination, cache and exact source read-back |
| Output | Folds identical consecutive lines in complete passing `vitest run` output; unknown, failed or truncated formats remain untouched |
| Workers / tools | Observes starts and results; a spawn result is not a terminal worker result or contract acceptance |
| Compact | Observes native compression start/end; does not replace the result |
| Gate A / Gate B | Automatic admission and dispatch mutation are unavailable |
| Planning / dependency acceptance | Unavailable; Claude's owned agent profiles are not loaded by Codex |
| Root guard | Unavailable; Codex sandbox and approval policy govern execution |
| Lean | Automatic transcript selection and input replacement are unavailable |
| Router | Automatic root model/effort overrides are unavailable |

Codex's [hook interface](https://learn.chatgpt.com/docs/hooks) cannot replace compaction output or root model/effort. Input replacement requires `permissionDecision: "allow"`, which this project deliberately never emits. Hosted tools can bypass local tool hooks. The plugin does not claim to observe every internal event or enforce Claude's execution contracts.

`PostToolUse` may provide output without an exit code. Output folding preserves content and repeat counts; a passing summary is not treated as proof of exit code 0. Missing or stale terminal records are shown as unconfirmed. No token savings are inferred from a hook firing.

## Settings and records

| Variable | Default / effect |
| --- | --- |
| `JEV_CODEX_WORKSPACE` | Absolute Git workspace for Evidence; required unless `JEV_EVIDENCE_CONFIG` is set |
| `JEV_CODEX_ENABLED=0` | Disable Codex hooks; the separately enabled MCP server remains available |
| `JEV_CODEX_OUTPUT=off` | Keep original tool output; lifecycle recording continues |
| `JEV_CODEX_TRACE_DIR` | Absolute recording directory; takes precedence over `JEV_GATE_TRACE_DIR` |
| `JEV_GATE_TRACE_DIR` | Optional shared override; host filtering keeps dashboards separate |
| `JEV_DASHBOARD_NO_OPEN=1` | Print the dashboard URL without opening a browser |

Records default to `$XDG_STATE_HOME/jev-gate/codex/traces`, otherwise `~/.local/state/jev-gate/codex/traces`. Hooks and MCP write bounded metadata in private atomic files. Raw prompts, source, tool output, transcript paths and credentials are not recorded. Existing records are not automatically deleted; remove old trace files when no longer needed.

If there are no records, check `/hooks` trust, plugin enablement, environment inheritance, and `doctor`. A symlinked trace directory is refused. A recording failure preserves normal host execution. Doctor reports local readiness, not proof that Codex trusted or ran a hook.

If Codex rejects the configured model for your account, choose an available model with `/model` or `codex --model <available-model>`. Plugin installation does not grant model access; doctor does not validate your login or account's model availability.

## Verification

`npm test` covers the core, native adapter and extracted archive with fake HTTP and no credentials. `npm run test:codex:runtime` additionally requires Codex CLI: it installs a uniquely named disposable plugin, uses a local scripted model (no model API key), checks the actual model-visible output and MCP result, and removes that test installation. It does not establish measured token savings or production model quality.

The [Codex loader](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/loader.rs) and actual 0.158.0 execution were both checked. The tested host uses the Codex compatibility manifest and `.mcp.json`; portable root manifests currently skip plugin hooks in Codex 0.158.0. The MCP declares an explicit environment allowlist and uses a plugin-relative working directory, with no placeholder interpolation in arguments.
