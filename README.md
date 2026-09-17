# jev-gate

**Use frontier models where they make a difference.**

An experimental Claude Code plugin for allocating models to coding work. The goal is not simply to use fewer frontier tokens. It is to complete the same work with a better balance of quality, total model consumption, and elapsed time.

> **Status — September 18, 2026:** the runtime on `main` is still **V3**, reviewed at [`2c1236f`](https://github.com/MongLong0214/jev-gate/commit/2c1236f9e928b01b30354c8e88af7939fdf0be54). **V4 is specified but not implemented or validated.** The first V3 pilot did not beat plain Sonnet. Native integration, file/evaluation hardening, and V4 effectiveness remain tracked work—not completed claims.

[Current results](#what-the-first-pilot-reported) · [Try V3](#try-the-current-v3-prototype) · [V4 design](#v4-route-the-next-task-not-the-entire-project) · [Implementation issues](#development)

## Why this exists

“Build a space-simulation game” contains very different kinds of work: resolve the simulation architecture, implement camera controls, connect the HUD, write tests, and integrate everything. Sending the entire project to one expensive model also assigns that model every routine step.

But the opposite extreme is no better: hundreds of tiny agents can repeat repository exploration, lose constraints, and spend more on handoffs than they save.

`jev-gate` is testing a middle ground: keep a capable main session, delegate coherent outcomes, and evaluate the model choice at the point where a concrete task is ready to run. A cheaper model is not assumed to be sufficient, and a larger model is not assumed to be better on every task.

## V4: route the next task, not the entire project

**The following is the planned V4 behavior, not the current V3 runtime.**

```text
Your original request
        │
        ▼
Sonnet main session
Understand the task, preserve constraints, coordinate and integrate
        │
        ├── Small self-contained work ─────────────► Finish directly
        │                                           No Jev call
        │
        ├── Concrete planning uncertainty ────────► Read-only planner
        │
        └── Ready implementation outcome ─────────► Coding worker
                                                        │
                                              PreToolUse: Agent
                                                        │
                                              Jev: one evaluation
                                                        │
                                       Preserved task + selected model
                                                        │
                                           Sonnet / Opus / Fable
                                                        │
                                          Results return to the main
```

V4 will use two native roles: a coding `worker` and a read-only `planner`. Model choice will not change a role's tools or permissions. Planning is optional; small work should not spawn an agent just to justify the gate.

Jev returns typed decisions, not a generated rewrite. The hook will preserve the complete Agent input and original task text, adding only a bounded annotation and a configured model identifier. It will not auto-approve the tool call.

On uncertainty, invalid input, unsupported execution, or a Jev failure, V4 will preserve the original native invocation. **Low confidence will no longer automatically escalate to Fable.** An explicit model argument remains a caller pin.

### What V4 will—and will not—control

| Boundary | Planned behavior |
|---|---|
| User submits a request | Fixed coordinator guidance; no Jev request |
| New, owned, eligible foreground Agent task | At most one Jev attempt before execution |
| Small work handled by the main session | No forced decomposition or routing |
| Explicit model, another plugin's agent, background/team/fork task | Leave the invocation unchanged |
| Existing agent resumed, including through `SendMessage` | No model reallocation |
| Worker internal reasoning and tool loops | Continue natively; no per-turn model swapping |
| Native permissions and user restrictions | Preserve them; never approve a call to make routing work |

Sequential foreground work is the initial support target, not a promise of global scheduling or file locking. The coordinator can still make poor plans, omit context, or bypass delegation. These are limitations to observe, not invisible successes.

V4 will default to `off`. Its `native` mode will provide the same hierarchy without Jev; `auto` will explicitly enable external task evaluation. Setting mode off does not unload installed agent definitions. Removing the plugin is the clean absent-plugin condition.

The complete contract and evidence requirements are in [the V4 ADR, #10](https://github.com/MongLong0214/jev-gate/issues/10).

## Try the current V3 prototype

**These commands run V3.** V3 evaluates the current user prompt through `UserPromptSubmit`, adds a brief, and recommends direct Sonnet work or an Opus/Fable subagent. It does not perform V4 task-boundary allocation.

Requirements: Node.js 22+, official Claude Code with an existing Claude.ai subscription login, and a TypeSafe API key for active evaluation. Account access to the selected Claude models is required. The author's recorded V3 host checks used Claude Code 2.1.274 on macOS; broader interactive support remains unverified.

```sh
git clone https://github.com/MongLong0214/jev-gate.git
cd jev-gate
npm ci
npm run build
PLUGIN_DIR="$PWD"

# Diagnostic only: no model inference.
JEV_GATE_MODE=off node dist/cli.js doctor

# Set TYPESAFE_API_KEY in this shell using your preferred local secret workflow.
# Do not put the value in chat, an issue, a committed file, or a shared log.
# The hook does not automatically load a project's .env file.

cd /path/to/your/project
JEV_GATE_MODE=auto \
CLAUDE_CODE_FORK_SUBAGENT=0 \
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 \
claude --model sonnet --plugin-dir "$PLUGIN_DIR"
```

Type requests normally; there is no required `/jev` command. The scoped environment settings request the non-fork foreground path. They do not prove that every possible concurrent tool batch is serialized.

V3 modes are `auto`, `enrich`, and `off`; **V4's `native` mode is not implemented in this checkout**. V3 also still defaults to `auto` and retains its original uncertainty-to-Fable policy. These defaults differ from the planned V4 configuration. See the [archived V3 contract](https://github.com/MongLong0214/jev-gate/issues/2) before changing settings.

To stop the V3 hook, launch with `JEV_GATE_MODE=off`. To remove the plugin's influence entirely, stop loading it and start a new session. The plugin does not rewrite your global settings or credentials.

`doctor` is an inference-free diagnostic, not a certificate of model availability, OAuth configuration, native patch support, or measurement correctness. Investigate API-key, gateway, cloud-provider, or model-override warnings before interpreting a session as the supported subscription setup.

## Authentication and task data

Claude inference stays inside official Claude Code using its existing login. `jev-gate` does not implement OAuth, extract or refresh login tokens, or require `WORKER_API_KEY` or `FRONTIER_API_KEY`.

TypeSafe is separate: active Jev evaluation uses `TYPESAFE_API_KEY` with its [System One API](https://docs.typesafe.ai/api.md). Its account charges and limits are independent of the Claude subscription.

| Version | Text sent to TypeSafe |
|---|---|
| Current V3 | The current user prompt, losslessly split, plus fixed evaluation criteria |
| Planned V4 | The delegated Agent prompt and description, plus fixed evaluation criteria |

A V4 delegated prompt may contain source excerpts, file paths and earlier user constraints. Neither version independently collects the entire repository or conversation for Jev, but caller-provided text can already contain sensitive information. **There is no automatic secret-scrubbing or zero-retention guarantee.** Do not enable external evaluation for data you are not authorized to send.

Detailed local tracing is opt-in through `JEV_GATE_TRACE_DIR` and can contain task content. It is not automatically uploaded. Existing trace-loss and accounting defects are being corrected in [#14](https://github.com/MongLong0214/jev-gate/issues/14); a missing trace must not be interpreted as zero consumption.

## What the first pilot reported

The V3 pilot used four development fixtures, four configurations, one run, and a scheduling seed of 42 on September 17, 2026. These are **reported exploratory observations**, not V4 results or a production benchmark.

| Configuration | Passed | Fable tokens | Total estimated cost | Mean runtime |
|---|---:|---:|---:|---:|
| Fable, original request | 3/4 | 657,473 | $2.3940 | 50.9 s |
| Fable, Jev-enriched request | 3/4 | 770,218 | $2.4951 | 51.9 s |
| Sonnet, plugin absent | 4/4 | 0 | $0.5781 | 22.2 s |
| Sonnet, V3 Jev gate | 4/4 | 259,205 | $1.4242 | 41.5 s |

The gate used less Fable volume and lower estimated cost than the always-Fable configuration. **Plain Sonnet was still the better observed option:** the gate cost about 2.46 times as much and took about 1.87 times as long for the same four passes.

One search-race task accounted for much of the overhead. Jev's top option was Sonnet, but its confidence fell below the configured floor, and V3's policy escalated to Fable. The extra frontier execution did not improve that task's observed pass result.

The search-race checker was also corrected after the run: adding a regression test to an existing file must not fail a test-file-count rule. Both the original and corrected reports are preserved. Public aggregate files are available; the complete private raw execution artifacts are not all included.

[Published report](bench/results/run-1-2026-09-17/report.md) · [Original checker report](bench/results/run-1-2026-09-17/report.checker-v1.md) · [Historical evaluation](https://github.com/MongLong0214/jev-gate/issues/6)

Costs combine Claude's API-equivalent estimate with Jev's estimated usage; they are **not subscription invoices, quota measurements, or cash saved**. Open file, grading, interruption and aggregation fixes are assigned to [#14–#16](https://github.com/MongLong0214/jev-gate/issues/14). Do not treat these aggregates as independent verification that every measurement boundary is correct.

## How V4 will be evaluated

The main question is whether Jev adds value beyond an otherwise identical native hierarchy. The planned comparisons include plain Sonnet, native hierarchy, Jev hierarchy, frontier-native, and fixed worker/planner model defaults. The fixed-role control checks whether inexpensive defaults already explain an apparent gain.

The unit of evaluation is a **complete user job**, not a child-agent count. All parent, planner, worker, helper and Jev consumption counts—including failed and unfinished work. A timeout duration is not successful completion latency. Missing costs stay unknown.

Small frozen-task probes can diagnose model allocation and hint effects. New mixed end-to-end jobs must establish the product result. Neither a successful API call nor a hundred child tasks from one game constitute a hundred independent demonstrations of effectiveness.

[Evaluation specification, #17](https://github.com/MongLong0214/jev-gate/issues/17) · [Reporting contract, #16](https://github.com/MongLong0214/jev-gate/issues/16)

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
```

The existing tests use fake HTTP/native execution and local fixtures; ordinary tests do not require a TypeSafe key or a Claude login. Passing them establishes the exercised code paths, not model quality or every installed-host behavior.

**Implement from [#9 PRD](https://github.com/MongLong0214/jev-gate/issues/9) → [#10 ADR](https://github.com/MongLong0214/jev-gate/issues/10) → [#11 native boundary](https://github.com/MongLong0214/jev-gate/issues/11).**

| Work | Issue |
|---|---|
| Native Agent patch and permissions | [#11](https://github.com/MongLong0214/jev-gate/issues/11) |
| Coordinator, roles and configuration | [#12](https://github.com/MongLong0214/jev-gate/issues/12) |
| Jev task evaluation | [#13](https://github.com/MongLong0214/jev-gate/issues/13) |
| Actual models, OAuth and usage | [#14](https://github.com/MongLong0214/jev-gate/issues/14) |
| Files, snapshots and grading | [#15](https://github.com/MongLong0214/jev-gate/issues/15) |
| Complete job reporting | [#16](https://github.com/MongLong0214/jev-gate/issues/16) |
| Comparative evaluation | [#17](https://github.com/MongLong0214/jev-gate/issues/17) |
| Packaging, migration and host support | [#18](https://github.com/MongLong0214/jev-gate/issues/18) |

Issues #1–#8 are historical; their closure does not certify inherited defects as fixed. Keep original evidence and user changes. Build the product and test real behavior rather than adding a new orchestration framework or document-validation system.

## Research and contracts

The [ADR's research review](https://github.com/MongLong0214/jev-gate/issues/10) covers task-level routing, intermediate-state information, simple control policies, coordination overhead and evaluation failure modes. It records both what influenced V4 and what does not transfer from another paper's models or benchmarks. Published results are not forecasts for this plugin.

Official references: [Claude Code hooks](https://code.claude.com/docs/en/hooks), [subagents](https://code.claude.com/docs/en/sub-agents), [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking), [authentication](https://code.claude.com/docs/en/authentication), [TypeSafe API](https://docs.typesafe.ai/api.md), [confidence](https://docs.typesafe.ai/confidence.md), and [Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md).

## License

No license file is present in the reviewed runtime revision. Licensing has not yet been specified.
