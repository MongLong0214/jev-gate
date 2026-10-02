# Jev Router

Router chooses a model and reasoning effort for the request the host is about to send. The same root conversation continues with its tools, permissions, provider and input. It does not open another root thread or change your saved model setting.

## Enable

Router ships in the combined `jev-gate` plugin and defaults to on. Install the plugin and enter your Jev key once. No role mapping or project file is required. Configure Claude options in `/plugin` → jev-gate → configure; Codex uses its optional `codex.json` policy.

Turning `routerEnabled` off stops ordinary routing. In the combined plugin, automatic Gate and Lean dispatches still enforce model eligibility; turning Router off cannot bypass that boundary. The standalone Router registers no policy hooks when disabled.

## What a request can do

If the native request would use model A at high effort, Router can keep A/high, choose A/low, choose B/high, or choose B/max when B supports max. Selecting A with `/model`, `--model`, or ordinary model configuration establishes a baseline. It does not permanently forbid B. Explicit environment pins, dimension switches, native organization restrictions and a manual change during the turn take precedence.

Model and effort are independent. A model pin leaves effort open; an effort pin allows only models that can preserve it. When both dimensions are closed, or there is no applicable question, no Jev call is made.

### Restricted automatic models

Astra in Codex and Fable in Claude are **excluded from automatic targets by default**, including ordinary subagents, Gate planners/workers, retries and Lean inheritance. A manual root selection remains usable and can still have its effort routed. It does not authorize automatic children to inherit that restricted model. An ineligible child falls back to main-session work; ownership of an already launched or uncertain worker remains protected.

Only the literal boolean `true` enables the respective option. Null, strings and numbers are invalid. These are independent host/package settings, with no shared master switch:

| Scope | Optional fragment |
| --- | --- |
| Codex `codex.json` | `{"router":{"allowAstra":true}}` |
| Combined Claude plugin options | `{"routerAllowFable":true}` |
| Standalone Claude Router options | `{"allowFable":true}` |

A `frontier` mapping is a preference, not authorization to use a restricted family. Invalid Router configuration preserves the native root and keeps automatic restricted-family filtering conservative.

## Candidates and efforts

**Codex:** the existing `model/list` discovery retains actual IDs, descriptions, hidden/default flags, modalities and supported effort metadata. Duplicate conflicts and malformed entries exclude only the affected candidate. Pagination failures retain partial discovery and report incomplete coverage. All eligible coding candidates can participate, including candidates outside the four role preferences. Hidden or specialist entries remain discovered without becoming general coding targets. Catalog refresh uses initialization and account changes, not per-turn paid probes.

**Claude:** the installed Function Hooks expose no model-list API. Versioned adapter facts come from the official [model overview](https://platform.claude.com/docs/en/models/overview), [model configuration](https://code.claude.com/docs/en/model-config) and [effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort), checked 2026-10-02. Effective aliases, provider mappings and `availableModels` are read from the host. Known versions remain separate candidates. Capabilities do not prove subscription entitlement. Unknown custom IDs or unverified aliases preserve native settings. A smaller root needs a current complete-request safe upper bound, maximum output room and compatible host transformation. Claude 2.1.287 only exposes an estimated summary, so Opus/Sonnet to Haiku root switching remains context_unverified. Fresh Haiku children have a separate context boundary and were verified without effort. Haiku is the preferred bounded fast worker; Codex prefers account-listed Luna for that role.

One bounded Jev batch contains a nominal choice between actual model IDs, keep and abstain, plus separate conditional effort scores for each applicable candidate. Only the chosen model's effort answer is consumed. Models without multiple effort levels need no effort question. Unknown model rank uses the stricter existing confidence floor; catalog order and model spelling do not imply price or capability. Known Claude product roles use the existing downgrade floor (0.6 by default) plus control/ordinary-risk checks; upgrades and same-role version changes retain 0.8. These roles are not measured price/performance rankings. Ordered effort changes retain directional thresholds. If the baseline is outside the target scale, use the first ascending cumulative level reaching max(upgrade,downgrade), not a nominal argmax. Missing effort can resolve from effective host settings; unknown values can use a verified explicit target control. Numeric values and actual pins are preserved.

`keep`, `set(value)` and `omit` are different operations. Literal `none` is a supported effort value, not field removal. Omission deletes only the effort field when the native host permits it; other reasoning settings remain intact. Conditional Claude levels are withheld when the thinking mode is unknown. Codex `ultra` is a host control mode: it is offered only through official turn settings, never sent as a raw Responses API effort. The host resolves the API effort.

## Context, timing and application

Root assessment sees the exact current human request, the previous **completed visible final answer**, and up to three screened recent human requests. Prior text is screened before keeping a 2,000-character tail, with source/truncation metadata. Partial commentary, tool output and self-generated prompts do not become a previous answer. Unsafe or oversized current input stays native without truncating the user's request.

The existing batch includes prior observed cache counts/model/age when available. These inform rebuilding cost without proving current fit or cache transfer between models. A cached root plus a bounded fresh worker can be preferable for a short task. No extra cache warm-up inference, token-count probe or cross-turn decision memoization is added. Each new turn still uses its own judgment.

Assessment runs once at the first request of a user turn. Concurrent entry shares the pending assessment. The validated patch persists across later tool steps; the next user turn is assessed again. A manual model/effort change wins, while a value applied by Router itself is not mistaken for a manual pin. Settings and catalog changes invalidate an unsent patch. Requests already sent are not replayed or cancelled by a settings refresh.

The default 800ms budget covers preparation, Jev and final application checks. Timeout continues the native request once when it is still wanted. Cancellation before native dispatch sends nothing. Native stream errors propagate without a second request. Late Jev usage remains attributed to the original assessment.

Gate B adds candidate-local allocation questions to its existing batch, not a second classifier call. Lean performs eligibility checks only. Optional recording and dashboard failures do not change execution. Durable worker ownership and cancellation remain required for safe dispatch and acceptance.

## Claude options

The standalone names omit the `router` prefix where listed below. Existing names and defaults remain compatible.

| Combined option | Standalone option | Default | Purpose |
| --- | --- | --- | --- |
| `routerEnabled` | `enabled` | true | Ordinary routing |
| `routeMainModel` | same | true | Root model selection |
| `routeMainEffort` | same | true | Root effort selection |
| `routeSubagentModel` | same | true | Automatic child model selection |
| `routeSubagentEffort` | same | true | Apply allocated effort to child steps |
| `routeExplicitSpawnModel` | same | true | Treat an ordinary Agent model argument as a routable default |
| `routerAllowFable` | `allowFable` | false | Restricted automatic family opt-in |
| `typesafeApiKey` | same | unset | Sensitive key; explicit value takes precedence |
| `routerFastModel` / `routerStandardModel` / `routerDeepModel` | `fastModel` / `standardModel` / `deepModel` | haiku / sonnet / opus | Role preferences; do not limit all candidates |
| `routerFrontierModel` | `frontierModel` | claude-fable-5-1 | Role preference; requires opt-in for automatic use |
| `routerMinUpgradeConfidence` | `minUpgradeConfidence` | 0.8 | Upgrade floor |
| `routerMinDowngradeConfidence` | `minDowngradeConfidence` | 0.6 | Downgrade and ordinary-risk floor |
| `routerTimeoutMs` | `timeoutMs` | 800 | Total preparation budget, 50–30000ms |
| `routerLogDecisions` | `logDecisions` | true | Optional diagnostics |

`ANTHROPIC_MODEL` pins the root model; `CLAUDE_CODE_EFFORT_LEVEL` pins effort; `CLAUDE_CODE_SUBAGENT_MODEL` and its `_FORCE` form pin child model resolution. `ANTHROPIC_DEFAULT_*_MODEL` maps an alias to its actual ID and does not disable all routing. Unreadable pin/allowlist facts are conservative. Plugin option changes reload the activation; no polling watcher or global model rewrite is installed.

## Diagnostics and verification

Existing recording and dashboard views distinguish assessment, selection, request submission and response observation. Records include the baseline, effort-field presence/effective source, scope, bounded candidate IDs, exclusions, direction/threshold/selected probability, effort policy, pins/toggles and loaded hook version. Doctor reports installed version independently and cannot prove what an existing host loaded. Restart after updating; explicit environment injector source is unknown unless actually observed. A submitted model is not a confirmed response. Missing response model or effort remains unknown; a mismatch never silently becomes confirmation. Observers cannot consume or delete an execution patch. Prompts, credentials and catalog description text are excluded from diagnostic records.

TypeScript and Vitest cover selection, host adapters, cancellation, races, context, invalid settings, partial catalogs and recording failures. Native tests separately use the real Claude Function Hooks engine and Codex process with scripted providers. They establish control-flow behavior, not model quality or savings. Account access and native permissions are host decisions.

For standalone development, run `node scripts/pack.mjs <out> --profile router`, extract the archive and pass that directory to `--plugin-dir`. The package includes the shared pure policy sources inside its own root. To run its host tests, copy `mods/router/tests` into the extracted directory and run `claude plugin test <directory>`. Combined development uses `--plugin-dir .` after the normal build.
