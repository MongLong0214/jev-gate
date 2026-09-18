<div align="center">

# jev-gate

### Not every coding task needs your best model.

Jev-powered model routing for Claude Code.<br>
An experiment in using frontier intelligence for the hard parts—not every part.

[The idea](#the-idea) · [How V4 will work](#how-v4-will-work) · [Try the prototype](#try-the-prototype) · [Results](#the-first-benchmark-changed-the-design) · [Build with us](#build-with-us)

</div>

> **Early-stage project · September 18, 2026.** The V3 prototype is available. V4 task-level routing is specified, not yet shipped. Savings and quality improvements are still hypotheses. [Implementation roadmap →](https://github.com/MongLong0214/jev-gate/issues/9)

## The idea

You ask your coding agent:

> “Build a space-simulation game.”

That is one request, but many different jobs: work out the physics, design the state model, implement camera controls, connect the HUD, and test the result.

**Why give all of those jobs the same model?**

`jev-gate` explores a different default: **Sonnet coordinates. Jev evaluates the next delegated task. A suitable Claude model does the work.**

The question is not just *“Is this project hard?”* It is *“Does this next piece of work need a frontier model?”*

We are not aiming for hundreds of tiny agents. The useful unit is a coherent outcome—camera controls and their tests, for example—not each file read. Handoffs, repeated exploration, and integration all have costs. The gate only helps if it saves more than it adds.

## How V4 will work

**Planned behavior; the current prototype below is V3.**

```text
You: “Build a space-simulation game.”
                    │
                    ▼
             Sonnet main session
          Understand · coordinate · integrate
                    │
       ┌────────────┴─────────────┐
       │                          │
   Small task                Delegated task
   Finish directly       Coding worker or read-only planner
   No Jev call                    │
                                  ▼
                         PreToolUse: Agent
                                  │
                           Jev evaluates
                           this task once
                                  │
                       ┌──────────┼──────────┐
                       ▼          ▼          ▼
                    Sonnet      Opus       Fable
                       └──────────┼──────────┘
                                  ▼
                       Result back to Sonnet
                       Integrate, then continue
```

The selected model is illustrative, not a fixed assignment for any particular game feature. Account access and actual model resolution still matter.

**Native Claude Code, not another agent framework.** V4 uses hooks and two native roles: a coding `worker` and an optional read-only `planner`. There is no required planning ceremony, proxy, MCP server, or separate Claude login.

**A task handoff, not a generated rewrite.** Jev returns typed decisions. Code preserves the original Agent input, chooses a configured model, and appends a short task hint. It does not invent a solution, delete constraints, or compress the original request away.

**Uncertainty means abstain.** When Jev cannot support a decision, V4 keeps the original invocation. It will not turn low confidence into an automatic Fable call. Explicit model arguments stay pinned, and routing does not approve tools or expand permissions.

<details>
<summary><strong>Technical boundary: exactly where the gate runs</strong></summary>

V4 targets eligible, new, root-origin, foreground calls to its own `jev-gate:worker` and `jev-gate:planner` agents. `UserPromptSubmit` adds fixed coordinator guidance without calling Jev; `PreToolUse:Agent` makes at most one HTTP attempt per eligible handler invocation. Post-tool hooks only observe.

It does not switch models inside a running worker, reroute resumes or `SendMessage`, intercept another plugin's agents, or force the main session to delegate. Background, fork, team, and unsupported call shapes pass through unchanged. Sequential guidance is not a global scheduler or file lock.

V4 defaults to `off`. `native` provides the same hierarchy without Jev; `auto` explicitly enables Jev task evaluation. These V4 modes are not all available in the current V3 runtime.

The installed-host model patch and permission behavior still need verification. The exact contract is [ADR #10](https://github.com/MongLong0214/jev-gate/issues/10), starting with [the native integration in #11](https://github.com/MongLong0214/jev-gate/issues/11).

</details>

## Try the prototype

**This runs V3, not the V4 flow above.** V3 evaluates each supported user prompt and recommends direct Sonnet work or one native Opus/Fable delegation. Start on a disposable project: file/evaluation hardening and broader host verification are still tracked work.

You need **Node.js 22+**, **official Claude Code signed in with a Claude.ai subscription**, and a **TypeSafe API key**. The selected Claude models must be available to your account. The recorded V3 checks used macOS and Claude Code 2.1.274; they do not establish V4 compatibility or general interactive support.

```sh
git clone https://github.com/MongLong0214/jev-gate.git
cd jev-gate
npm ci
npm run build
PLUGIN_DIR="$PWD"

# Diagnostics only: no inference.
JEV_GATE_MODE=off node dist/cli.js doctor

# Before continuing, set TYPESAFE_API_KEY in this shell using your
# local secret workflow. Read the data disclosure below first.
# The plugin does not automatically load a project's .env file.

cd /path/to/your/project
JEV_GATE_MODE=auto \
CLAUDE_CODE_FORK_SUBAGENT=0 \
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 \
claude --model sonnet --plugin-dir "$PLUGIN_DIR"
```

Then type normally. No required `/jev` command and no second coding interface.

V3 supports `auto`, `enrich`, and `off`. It still defaults to `auto` and retains the old uncertainty-to-Fable policy. **V4's `native` mode and abstention policy are planned changes**, not instructions to apply to this checkout. [V3 configuration reference →](https://github.com/MongLong0214/jev-gate/issues/2)

To disable the hook, launch with `JEV_GATE_MODE=off`. To remove the plugin entirely, omit `--plugin-dir` and start a new session; disabling hooks does not unload agent definitions. The plugin does not rewrite global settings or credentials. `doctor` reports configuration and environment issues; it is not proof that every model or host path works.

## The first benchmark changed the design

**Our first gate lost to plain Sonnet. We kept the result.**

The V3 pilot ran four development fixtures under four configurations on September 17, 2026. These are the published exploratory results, not V4 performance:

| Configuration | Passed | Estimated total cost | Mean runtime |
|---|---:|---:|---:|
| Fable, original request | 3/4 | $2.3940 | 50.9 s |
| Fable, Jev-enriched request | 3/4 | $2.4951 | 51.9 s |
| **Sonnet, plugin absent** | **4/4** | **$0.5781** | **22.2 s** |
| Sonnet, V3 Jev gate | 4/4 | $1.4242 | 41.5 s |

The gate was cheaper than the always-Fable baseline. But plain Sonnet completed the same four cases at less cost and in less time. One low-confidence decision triggered an unnecessary policy escalation to Fable and dominated the overhead.

> **Beating an expensive default is not enough. A router has to beat simpler alternatives.**

That is the bar for V4. It moves the decision from a broad user request to a concrete delegated task, removes automatic escalation on uncertainty, and compares Jev against the same hierarchy without Jev—not only against an expensive model.

[Published report](bench/results/run-1-2026-09-17/report.md) · [Original checker report](bench/results/run-1-2026-09-17/report.checker-v1.md) · [What changed and why](https://github.com/MongLong0214/jev-gate/issues/6)

<details>
<summary><strong>Measurement notes and the V4 comparison</strong></summary>

The pilot used one run, four development fixtures, sequential execution, and a scheduling seed of 42. A search-race checker initially counted test files instead of accepting a regression test added to an existing file. Correcting it changed the native Sonnet result to pass. Both report revisions remain available; not all private raw execution artifacts are published.

The estimates combine Claude's API-equivalent usage and Jev's estimated cost. **They are not subscription invoices, quota measurements, or cash saved.** Open [observation](https://github.com/MongLong0214/jev-gate/issues/14), [grading](https://github.com/MongLong0214/jev-gate/issues/15), and [reporting](https://github.com/MongLong0214/jev-gate/issues/16) fixes limit what can be concluded from the existing aggregates. Four observed passes do not prove quality equivalence.

V4's primary comparison is **Jev hierarchy versus native hierarchy**. Additional controls are plain Sonnet, frontier-native, and a hierarchy with fixed worker/planner model defaults. The last control asks whether inexpensive defaults already explain a gain.

The unit is a complete user job. Main-session work, planning, workers, integration, Jev, and failed or unfinished execution all count. Missing consumption stays unknown. A timeout is not time-to-success, and a hundred children from one game are not a hundred independent projects.

Frozen task probes diagnose allocation and hint effects; new mixed end-to-end jobs test the product. [Full evaluation specification →](https://github.com/MongLong0214/jev-gate/issues/17)

</details>

## Your login. Your data. Your choice.

Claude runs through its existing official login. `jev-gate` does not extract OAuth tokens or require `WORKER_API_KEY`, `FRONTIER_API_KEY`, or a new Claude API connection. Jev is a separate hosted service and needs **`TYPESAFE_API_KEY`**; its charges and limits are separate from your Claude subscription.

| Version | What is sent to TypeSafe |
|---|---|
| Current V3 | The current user prompt, split without dropping text, plus fixed evaluation criteria |
| Planned V4 | The delegated Agent prompt and description, plus fixed evaluation criteria |

Delegated text can include source excerpts, file names, and earlier user constraints. The hook does not independently upload your repository or full conversation, but text supplied by the caller can contain sensitive information. **Only enable it for data you are authorized to send.** There is no automatic secret-scrubbing or zero-retention guarantee.

Detailed local traces are optional through `JEV_GATE_TRACE_DIR`, may contain task content, and are not automatically uploaded. Do not post keys, private code, or raw private traces in an issue. This is a model-allocation experiment, not a security sandbox or a hard spending limit.

## Build with us

**The most useful contribution is a real coding task—not another optimistic percentage.** Share a sanitized task, what a correct result should do, the host/model versions, and what actually happened. Easy tasks that were over-escalated and expensive tasks that did not benefit from a stronger model are both useful.

[Report a finding](https://github.com/MongLong0214/jev-gate/issues/new) · [Follow the V4 roadmap](https://github.com/MongLong0214/jev-gate/issues/9)

For implementation, start at **[#9 PRD](https://github.com/MongLong0214/jev-gate/issues/9) → [#10 ADR](https://github.com/MongLong0214/jev-gate/issues/10) → [#11 native boundary](https://github.com/MongLong0214/jev-gate/issues/11)**. The remaining tickets cover roles and routing (#12–#13), trustworthy measurement (#14–#16), evaluation (#17), and packaging (#18). Issues #1–#8 preserve earlier work and findings; closure does not mean every inherited defect is fixed.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Ordinary tests use fake HTTP/native execution and local fixtures, without API keys or paid inference. Native-host compatibility and model quality require separate observations. Keep contributions focused on working behavior; there is no need for another orchestration framework.

## Research and references

The [research review in ADR #10](https://github.com/MongLong0214/jev-gate/issues/10) connects routing, execution-state information, simple baselines, and coordination overhead to the design. Results from other models and benchmarks are not forecasts for this plugin.

[Claude Code hooks](https://code.claude.com/docs/en/hooks) · [Native subagents](https://code.claude.com/docs/en/sub-agents) · [TypeSafe System One API](https://docs.typesafe.ai/api.md) · [Confidence](https://docs.typesafe.ai/confidence.md)

## License

A license has not yet been selected. No license file is present in the reviewed runtime revision.

---

**Keep the hard thinking. Question the expensive default.**
