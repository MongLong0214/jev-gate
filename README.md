# jev-gate

**Use frontier intelligence only when the task actually needs it.**

`jev-gate` is an experimental Claude Code plugin that puts TypeSafe's Jev in front of every supported natural-language turn.

You keep Claude Code on **Sonnet**. Jev quickly interprets the request, structures it into a compact execution brief, and recommends whether Sonnet should handle it directly or delegate once to **Opus** or **Fable**.

The goal is simple: **reduce unnecessary Fable usage and total coding time without reducing task success.** That is a hypothesis to measure, not a result we claim yet.

> Status: **MVP specification complete; implementation in progress.** Start with [#1 PRD](https://github.com/MongLong0214/jev-gate/issues/1) → [#2 ADR](https://github.com/MongLong0214/jev-gate/issues/2) → [#3 first implementation ticket](https://github.com/MongLong0214/jev-gate/issues/3).

## The idea

Normally, you choose a Claude model before you know how hard the next request really is.

```text
user
  ↓
Fable for everything
```

`jev-gate` keeps the everyday session on Sonnet and makes one fast decision at the front of each supported turn:

```text
user prompt
    ↓
Claude Code UserPromptSubmit hook
    ↓
Jev — one System One request
    ├─ task type
    ├─ goal / constraint / acceptance annotations
    └─ recommended execution tier
    ↓
code renders a short, lossless execution brief
    ↓
main Claude Code session: Sonnet
    ├─ Sonnet → handle directly
    ├─ Opus   → foreground native subagent
    └─ Fable  → foreground native subagent
    ↓
actual code / tests / result
```

There is no separate dispatcher model, Claude proxy, MCP server, background daemon, or second authentication system.

## Why Jev is more than a router

Jev does **not** generate a rewritten prompt. It is a decision model, not a text-generation model.

For a request like:

```text
Fix the bug where an older search response can overwrite a newer result.
Do not change the API response shape or add dependencies.
Add a test that reproduces the late-response case.
```

Jev evaluates the original blocks and returns typed decisions such as:

```text
task: debug

u1 → goal
u2 → constraint
u3 → acceptance

route → opus
```

`jev-gate` then deterministically renders those decisions into additional context for the current turn:

```text
Task kind: debug
Execution: delegate once to jev-gate:opus

Request annotations, original order:
- goal:       <original text>
- constraint: <original text>
- acceptance: <original text>

The original user request and prior instructions remain authoritative.
```

The user's text is never replaced by a generated summary. Negations, exceptions, code, numbers, and constraints stay intact. Jev's annotations are hints, not new requirements.

## Native Claude Code, not another agent framework

The MVP uses Claude Code's own primitives:

- [`UserPromptSubmit`](https://code.claude.com/docs/en/hooks) runs after the user submits a prompt and before Claude processes it.
- [`additionalContext`](https://code.claude.com/docs/en/hooks) carries the Jev brief into that turn.
- [custom subagents](https://code.claude.com/docs/en/sub-agents) run Opus or Fable in their own context when delegated.
- the main session stays on Sonnet.

The hook does **not** change the current model itself and does not invoke Claude. The Sonnet main session receives the recommendation and, when appropriate, invokes one named foreground subagent.

A user instruction, higher-priority Claude instruction, plan mode, permissions, unavailable model, or missing context can override the recommendation. We record the recommendation and the model that actually ran separately.

## Authentication

Only one new API key is required:

```bash
export TYPESAFE_API_KEY=...
```

Jev is called through TypeSafe's native endpoint:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

The MVP pins `jev-1.13.0` by default so measurements do not silently change when an alias moves.

Claude models use the **existing Claude Code login**. There is no `WORKER_API_KEY`, `FRONTIER_API_KEY`, Anthropic API adapter, OAuth token extraction, or subscription proxy.

If you are already signed in to Claude Code with a Claude.ai subscription, Claude Code owns that authentication. `jev-gate` never reads or stores the OAuth credential.

> Claude Code also supports API keys, cloud providers, and gateways. The first measured MVP targets a normal Claude.ai subscription/OAuth setup and reports unsupported or ambiguous authentication rather than silently changing it.

## What Jev sees

For the MVP, the automatic Jev request contains only:

- the **current user text**, split losslessly into blocks;
- fixed task/role/routing criteria.

It does **not** automatically upload:

- repository source files;
- the Claude transcript or prior conversation;
- `.env` files or credentials;
- shell output;
- hidden benchmark answers.

If a turn says something like “fix that one” and essential meaning lives in prior conversation, Jev can return `context_required`. The existing Sonnet session already has the conversation and resolves that context before any delegation.

## Routing tiers

The initial routing hypotheses are deliberately simple:

| Tier | Intended shape |
| --- | --- |
| **Sonnet** | bounded routine changes, explanations, localized fixes, straightforward tests |
| **Opus** | non-trivial investigations, cross-file changes, interacting constraints |
| **Fable** | unusually difficult debugging, architecture, broad interacting invariants, long-horizon reasoning |

Jev returns the full probability distribution and confidence for the choice. Low-confidence or ambiguous routing is handled conservatively; thresholds are experimental and must be validated against real coding tasks.

Current Claude Code documentation exposes the `sonnet`, `opus`, and `fable` aliases. Fable requires a sufficiently recent Claude Code version and account access; `jev-gate` does not rename a fallback model as Fable.

## Failure behavior

The gate must never make Claude Code unusable.

If the TypeSafe key is absent, Jev times out, the response is invalid, the prompt is outside the supported input bounds, or the hook fails:

```text
Jev recommendation unavailable
        ↓
continue the original Claude Code turn natively
```

No previous route is reused. The hook does not retry Jev, start a fallback Claude process, or automatically escalate through multiple models.

## Target install flow

The repository is currently at the implementation stage. The intended local workflow after [#3–#7](https://github.com/MongLong0214/jev-gate/issues/3) are implemented is:

```bash
git clone https://github.com/MongLong0214/jev-gate.git
cd jev-gate
npm ci
npm run build

export TYPESAFE_API_KEY=...
node dist/cli.js doctor

# Run Claude Code normally, with Sonnet as the main session.
cd /path/to/your/project
claude --model sonnet --plugin-dir /absolute/path/to/jev-gate
```

Then use Claude exactly as usual:

```text
> fix this race condition without changing the API
> review this implementation
> refactor this without adding dependencies
> redesign the auth flow and implement it
```

No `/jev` command is required per turn.

## Does it actually save tokens or time?

That is the reason this project exists, so the MVP includes a small real-coding benchmark instead of relying on intuition.

We compare the same coding tasks under four configurations:

| Arm | Root model | jev-gate | Question |
| --- | --- | --- | --- |
| `frontier_raw` | Fable | off | What does always using the strongest model cost? |
| `frontier_enriched` | Fable | enrich only | Does the Jev brief reduce work even with the same root model? |
| `sonnet_native` | Sonnet | off | Is simply using Sonnet already enough? |
| `sonnet_gated` | Sonnet | auto | Does the actual product add value over native Sonnet? |

We measure together:

- actual task pass / fail / unknown using behavior checks;
- Fable token usage;
- all Claude model usage, including parent and subagents;
- Jev usage and gate latency;
- end-to-end wall time;
- Claude's reported API-equivalent cost where available;
- routing recommendation versus the model that actually executed.

A run that avoids Fable but fails the task is **not** a token-saving success. A gated run that is slower than plain Sonnet is also a useful negative result.

OAuth subscription usage is not the same thing as API billing, so the project does not pretend that token counts equal the user's subscription charge or quota consumption.

See [#6](https://github.com/MongLong0214/jev-gate/issues/6) for the measurement contract.

## MVP scope

The first release intentionally does **not** include:

- automatic tier escalation after failure;
- multi-agent review loops;
- a separate worker model provider;
- Anthropic API proxying or custom OAuth;
- repository indexing or vector search;
- transcript summarization;
- UI, database, MCP server, or daemon;
- automatic commit, push, or deploy.

The product is a hook, one Jev decision, a compact brief, and two native Claude Code subagents. We will add machinery only when measurements or real failures justify it.

## Development map

| Issue | Responsibility |
| --- | --- |
| [#1 — PRD](https://github.com/MongLong0214/jev-gate/issues/1) | product goal, UX, scope, measurement question |
| [#2 — ADR](https://github.com/MongLong0214/jev-gate/issues/2) | hook contract, types, auth, failure boundaries |
| [#3 — Hook](https://github.com/MongLong0214/jev-gate/issues/3) | Claude Code plugin, `UserPromptSubmit`, doctor, native fallback |
| [#4 — Jev](https://github.com/MongLong0214/jev-gate/issues/4) | TypeSafe API, questions, validation, execution brief |
| [#5 — Delegation](https://github.com/MongLong0214/jev-gate/issues/5) | Sonnet main session, Opus/Fable native subagents, context handoff |
| [#6 — Measurement](https://github.com/MongLong0214/jev-gate/issues/6) | real coding comparison, usage/time/quality accounting |
| [#7 — Delivery](https://github.com/MongLong0214/jev-gate/issues/7) | build, install, offline CI, live smoke, MVP handoff |

**Implementation agents:** read [#1](https://github.com/MongLong0214/jev-gate/issues/1) and [#2](https://github.com/MongLong0214/jev-gate/issues/2), then start coding from [#3](https://github.com/MongLong0214/jev-gate/issues/3). Do not create another planning framework before implementing the first hook path.

## Official references

Contracts were checked against the live documentation on 2026-09-17:

- [TypeSafe introduction](https://docs.typesafe.ai/introduction)
- [TypeSafe HTTP API](https://docs.typesafe.ai/api.md)
- [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice.md)
- [TypeSafe confidence](https://docs.typesafe.ai/confidence.md)
- [TypeSafe models](https://docs.typesafe.ai/models.md)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code subagents](https://code.claude.com/docs/en/sub-agents)
- [Claude Code model configuration](https://code.claude.com/docs/en/model-config)
- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [frontier-simplify](https://github.com/MongLong0214/frontier-simplify/blob/96b07ad17e90fd4e69e1a7748641d7f30c06fcf0/skills/frontier-simplify/SKILL.md)

## License

TBD until the repository license is added.
