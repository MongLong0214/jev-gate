---
name: jev-gate
description: Use Jev Gate policies in native Codex. Use for owned dispatches through jev_agent or diagnosing the Jev Gate Codex plugin. Automatic policies require the native session connection.
---

# Jev Gate in Codex

Owned dispatches run in the background by default. End the main turn after dispatch and answer new user messages while they work. Use `jev_agent` with `action: "status"` and the returned `agent_id` for a nonblocking result lookup; use `action: "cancel"` only for explicit user cancellation. A launch receipt is not a completed worker.

The native hooks record lifecycle metadata. A spawn receipt is not a completed worker. A stop event is not Jev contract acceptance. Missing events mean unknown; no fake activity is generated.

The installed plugin automatically connects ordinary native Codex sessions. No Jev terminal or workspace export is required. Codex owns hook trust and authentication; review/trust the hooks when prompted and start a new native session if the current host loaded its provider before installation. Never forge trust or claim connection merely from installation.

The installed MCP opens a local API key screen when no key is available. The user enters one Jev key, shared with Claude Code in the private local credential file. Do not ask users to edit settings or export a key for ordinary use. Existing explicit environment keys remain authoritative. Saving a key is not proof of API validity or policy application. Never send a key through tool arguments, prompts or logs.

Use `jev_agent` only with the exact owned profile and marker in current Gate guidance. Code owns acceptance; workers inherit the captured native permission scope. Unknown input, invalid judgments and timeouts preserve the baseline. Router/Compact application requires actual provider requests through the local connection; consult observed records. Do not silently approve permissions, modify transcripts or infer savings.

Use the absolute installed plugin path for diagnostics:

```sh
node <plugin>/dist/cli.mjs doctor
node <plugin>/dist/cli.mjs dashboard
```

The default trace directory is `$XDG_STATE_HOME/jev-gate/codex/traces` or `~/.local/state/jev-gate/codex/traces`; `JEV_CODEX_TRACE_DIR` overrides it. The dashboard supports Korean/English and light/dark themes. Use `/hooks` in Codex to review and trust the installed hook definitions. Installation alone does not trust hooks.
