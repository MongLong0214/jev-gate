# jev-gate-router

A Claude Code Function Hooks plugin that asks Jev, once per decision, whether a root turn's effort (and optionally its
model) or a built-in subagent's model should change. It is independent of the Lean handoff in the repository root and
of V5 orchestration; composing them is #44.

**Status.** Written against the Function Hooks declarations shipped with Claude Code 2.1.282
(`types/claude-code.d.ts`). Every path is exercised with a fake engine and fake HTTP (`tests/router/*.test.ts`), and
the host's own test kit loads the plugin and confirms the default is off (`tests/register.test.ts`). **No routed turn
has been observed on a real host, and no saving is claimed.**

## Enable

Function Hooks are gated in the host:

```sh
export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1
claude --plugin-dir /path/to/jev-gate/mods/router
```

The plugin is **off by default**. With `enabled` false it registers no hook at all, so the session is exactly native.
Set the options in `/config`. They are stored in settings.json under `pluginConfigs["jev-gate-router"].options` (or
`jev-gate-router@inline` for a `--plugin-dir` load), except a sensitive one, which the host keeps in secure storage.

The key comes from `typesafeApiKey` (a sensitive option) or, when that is empty, from `TYPESAFE_API_KEY` in the
environment. An explicit key that cannot ride in a header is refused and the environment is **not** consulted, so a
typo never silently switches credentials. The key is sent only in the `Authorization` header and never logged.

## Options

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. |
| `routeSubagentModel` | `true` | Choose the model of a built-in subagent that would inherit its parent's. |
| `routeMainEffort` | `true` | Choose the root turn's effort among the levels its model takes unconditionally. |
| `routeMainModel` | `false` | Also choose the root turn's model. Exact identifiers only, never to a smaller context window, and only along a verified switch: none is verified yet, so today this asks nothing. |
| `typesafeApiKey` | — | Explicit key; overrides `TYPESAFE_API_KEY`. |
| `fastModel` / `standardModel` / `deepModel` | `haiku` / `sonnet` / `opus` | Profiles. A spawn takes aliases; the root takes exact identifiers only. |
| `frontierModel` | empty | An exact identifier only (`claude-fable-5-1`); an alias cannot authorize it. |
| `minUpgradeConfidence` | `0.8` | Floor for moving up. |
| `minDowngradeConfidence` | `0.9` | Floor for moving down, which also needs an `ordinary` risk answer at this floor. |
| `timeoutMs` | `800` | Wait for Jev, 50–30000. The request is still observed for its usage after the wait ends. |
| `logDecisions` | `true` | One `jev-router {...}` line per decision in the debug log. |

The host checks each option's declared type before the module loads. An option the Router still cannot use, such as a
number out of range, turns the whole Router off and logs only the field name, never its value
(`{"event":"router","disabled":"invalid_option","field":"timeoutMs"}`). Two profiles that name one family drop every
profile, since each rank lookup would then be a guess.

## When it leaves a call native

Every gate below leaves the call exactly as it was and logs why.

- **Environment pins.** `ANTHROPIC_MODEL` pins the root model and `CLAUDE_CODE_EFFORT_LEVEL` its effort.
  `CLAUDE_CODE_SUBAGENT_MODEL` or `…_FORCE` pins spawns (`subagent_model_pinned`), and any
  `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` makes an alias mean something else (`alias_remapped`). An environment
  it cannot read counts as pinned everywhere. Pins are read again at every step, since another plugin can set one
  mid-session: a pin set after a decision ends that override from the next step (`model_pinned`, `effort_pinned`).
  Pins and the allowlist are read again once Jev has answered, too: a spawn is left native if either now excludes its
  target (`{"event":"spawn_stop",…}`), and a stored root model override stops once the allowlist drops it
  (`model_not_allowed`). The pins are read last, after the allowlist, so no wait separates them from `next`. When a
  pin ends a root effort override, a model override whose target cannot take the effort the request keeps ends too
  (`pair_invalid`).
- **Spawns it cannot vouch for.** A fork (`fork`), an explicit model (`explicit_model`), a type other than the
  inheriting built-ins `general-purpose`, `claude`, `Plan` and `Explore` (`type_unverified`), a built-in's name that the
  engine's own core listing did not offer (`definition_unverified`), a host whose release base is not 2.1.282
  (`host_unverified`, including development builds), an `Explore` under a parent of unknown family
  (`baseline_unknown`), and a prompt that carries a Lean marker (`lean_marker`).
- **The settings allowlist.** A target outside `availableModels` is `target_not_allowed`. A malformed
  `availableModels` allows nothing. An entry allows a variant only by naming it: `claude-opus-5-5` does not allow
  `claude-opus-5-5[1m]`, and an alias allows only the unsuffixed model. A suffix the host does not list for that model
  (anything but `[1m]` on Opus 5.5 and Sonnet 5) makes the profile `unknown_model`.
- **Nothing it could apply.** A model question is asked only when some other profile could actually be applied, with
  an effort it would be sent with (the current one, or one offered alongside) that the profile takes; otherwise the dimension is withheld (`no_applicable_target`, or `rank_unknown` when the current model has no
  profile), and with nothing else to ask no request is sent. At the root a model change also needs its exact
  `from → to` pair in `VERIFIED_ROOT_SWITCHES` (`controls_unverified`). The hook sees none of the controls the
  retained request carries — thinking, `max_tokens`, tools, media, beta headers, the window — and the 2.1.282
  declarations do not say the engine re-derives them for a model named in `next`. The list is empty until a host
  observation establishes a pair, so every root model stays native.
- **The answer.** Missing, malformed or `preserve` answers, the same model under another spelling, confidence under the
  floor, a `control` answer other than a confident `task_clear`, a downgrade without a confident `ordinary` risk, a
  model that cannot run the effort it would get (`pair_invalid`), and a root model with a smaller context window
  (`capacity_smaller`, which is also why such a profile is never offered).
- **The request.** Nothing is sent for text that looks like a credential (`input_secret`, the same patterns as Lean's
  screen), for a body over 128 KiB or about 25,000 tokens (`input_too_large`, never trimmed to fit), or with eight
  requests already unresolved (`saturated`). After a 401 or 402 nothing more is sent in that activation
  (`credential_refused`). No request is retried. A reply that arrives after its wait ended is never applied; what it
  cost is logged against the turn or tool use that asked (`{"event":"late",…}`).

A root turn is judged once, at its first step, and its patch is reapplied to each later step of that turn. A turn with
no user text (`no_task_text`) is not judged. If a step reports another model than the one requested, or reports none,
the model override stops for the rest of the turn, and so does an effort the observed model cannot take; this holds
for an effort-only patch too, since the host can answer from a fallback. A model override needs its own variant
reported back: a bare `claude-opus-5-5` does not confirm a requested `claude-opus-5-5[1m]`, and ends that override.
An effort-only patch compares by model alone, since effort does not depend on the variant. If a step's incoming model or effort differs from the
baseline, something else changed it, and the Router stops for the rest of the turn (`root_stop`). So it does if the
host dispatched a step without waiting for the hook (`step_abandoned`): a later step never switches away from what that
one ran on.

A spawn is judged per dispatch, on its own prompt, even when a `tool_use_id` repeats; its wait ends with that dispatch
or the session.

Each routed result is logged with what the host reported: `root_result` carries the applied patch, the model the step
reports and the four token counts of its usage (nothing else of it), and `spawn_result` the requested and resolved
model and the agent id, or the denial. These are per-step records, not a saving: overlapping totals are for #45 to
normalize.

## Limits

- **The host's test kit cannot set plugin options**, so `claude plugin test` only covers the default (off) path. The
  enabled paths run through `register.ts` in vitest with a fake `$` (`tests/router/register.test.ts`).
- **One verified host.** Spawn routing depends on how 2.1.282 resolves an inheriting built-in's model. Any other
  release base leaves spawns native until it is verified.
- **A hook never calls `next` after its signal aborts.** By then the host has gone on without it, and a `next` would
  start a second request. A root step returns nothing, and a spawn throws.
- **The credential screen is copied, not imported,** because a Function Hooks module cannot import the Node side of
  the repository. A parity test keeps the two lists identical.
