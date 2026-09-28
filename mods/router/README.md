# jev-gate-router

A Claude Code Function Hooks plugin that asks Jev, once per decision, whether a root turn's effort (and optionally its
model), a subagent's model, or a subagent's effort should change. It is independent of the Lean handoff in the repository root and
of V5 orchestration; composing them is #44.

**Status.** Written against the Function Hooks declarations shipped with Claude Code 2.1.282
(`types/claude-code.d.ts`); the 2.1.283 declarations differ only in UI and cost documentation. Every path is exercised
with a fake engine and fake HTTP (`tests/router/*.test.ts`), and the host's own test kit loads the plugin and confirms
the default is off (`tests/register.test.ts`). On an installed 2.1.283 host (2026-09-27, one session per condition,
`bench/results/host-obs-2026-09-27/`), the host passed on a root turn's steps at the effort the Router patched in (seen
at the hook boundary, not on the wire), and an `Explore` and a `general-purpose` spawn under Opus ran on the Sonnet
the Router asked for. **Those are single observations that the
patches take effect, not a saving; no saving is claimed.**

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
typo never silently switches credentials. The key is sent only in the `Authorization` header and never logged. It is
read once per session. A call that the event and configuration alone leave with nothing to ask (a fork, a numeric
effort, a spawn whose model is not routed while subagent effort is off) goes on without waiting for it. Otherwise the key comes before
anything optional: without one (`key_missing`, `key_invalid`) no pin, setting or host version is read for the call.
Every wait, for the key or a read, ends when its turn is retired or its dispatch or session ends.

## Options

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch. |
| `routeSubagentModel` | `true` | Choose a subagent's model: an inheriting built-in that names none, or (below) any Agent call that names one. |
| `routeExplicitSpawnModel` | `true` | Treat the model an Agent call names (`model: "opus"`) as a default the Router may move. Off, such a call keeps it (`explicit_model`). |
| `routeSubagentEffort` | `true` | Set each subagent's effort from its spawn's answer, on every request its loop makes. |
| `routeMainEffort` | `true` | Choose the root turn's effort among the levels its model takes unconditionally. |
| `routeMainModel` | `false` | Also choose the root turn's model. Exact identifiers only, never to a smaller context window, and only along a verified switch: none is verified yet, so today this asks nothing. |
| `typesafeApiKey` | — | Explicit key; overrides `TYPESAFE_API_KEY`. |
| `fastModel` / `standardModel` / `deepModel` | `haiku` / `sonnet` / `opus` | Profiles. A spawn takes aliases; the root takes exact identifiers only. |
| `frontierModel` | empty | An exact identifier only (`claude-fable-5-1`); an alias cannot authorize it. |
| `minUpgradeConfidence` | `0.8` | Floor for moving up: Jev's probability mass at or above the target. |
| `minDowngradeConfidence` | `0.6` | Floor for moving down: Jev's probability mass at or below the target. A downgrade also needs `ordinary` risk at this probability. On a week of the owner's traffic (2026-09-21..28), 0.9 moved 2 of 174 routable spawns and 2 of 245 root turns. |
| `timeoutMs` | `800` | Wait for Jev, 50–30000. The request is still observed for its usage after the wait ends. |
| `logDecisions` | `true` | One `jev-router {...}` line per decision in the debug log. |

The host checks each option's declared type before the module loads. An option the Router still cannot use, such as a
number out of range, turns the whole Router off and logs only the field name, never its value
(`{"event":"router","disabled":"invalid_option","field":"timeoutMs"}`). Two profiles that name one family drop every
profile, since each rank lookup would then be a guess.

## When it leaves a call native

Every gate below leaves what it gates exactly as it was and logs why. On a spawn, a gate on its model leaves the model
native while its subagent's effort is still asked (unless `routeSubagentEffort` is off); a fork, a lean marker, a
missing key, an effort pin and a suspension leave both native. A spawn type the Router does not route is caller text,
so it is logged as `other`, never by name.

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
- **Spawns it cannot vouch for.** A fork (`fork`, whose loop shares its parent's context), an explicit model when
  `routeExplicitSpawnModel` is off (`explicit_model`), for a spawn that names no model a type other than the
  inheriting built-ins `general-purpose`, `claude`, `Plan` and `Explore` (`type_unverified`), a built-in's name that the
  engine's own core listing did not offer (`definition_unverified`), a host whose release base is not 2.1.N with N at
  least 282 (`host_unverified`, including development builds), any spawn after this session's routing was suspended
  (`spawn_suspended`, below), an `Explore` under a parent of unknown family
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
- **The answer.** Missing or malformed answers, the same model under another spelling, too little probability mass
  on either side (below), a `control` answer whose `task_clear` probability is under the floor, a downgrade whose `ordinary` risk probability is under the downgrade floor, a model that cannot run the
  effort it would get (`pair_invalid`), and a root model with a smaller context window (`capacity_smaller`, which is
  also why such a profile is never offered).
- **The request.** Nothing is sent for text that looks like a credential (`input_secret`, the same patterns as Lean's
  screen), for a body over 128 KiB or about 25,000 tokens (`input_too_large`, never trimmed to fit), or with eight
  requests already unresolved (`saturated`). After a 401 or 402 nothing more is sent in that activation
  (`credential_refused`). No request is retried. A reply that arrives after its wait ended is never applied; what it
  cost is logged against the turn or tool use that asked (`{"event":"late",…}`).

**How an answer becomes a move.** Model and effort are asked as Jev Score questions, one level per line, each
describing work rather than naming a model: lookup or a mechanical edit; ordinary multistep work with clear
requirements; hard debugging, design under competing constraints or subtle correctness; exceptional reasoning beyond
that (`TIER_LEVELS` in `hooks/policy.ts`). The wording is the contract: a level's name never reaches Jev, and editing
a description changes what the Router does. The model question lists the offered profiles' levels in rank order.
Effort is always the four levels, mapped to `low`, `medium`, `high` and `xhigh`, except that exceptional work keeps a
current level above `xhigh`, so a configured `max` is never lowered for it; a target the model does not take moves up
to the next one it does. Hard work asks for `high`, so a configured `xhigh` is lowered for it: on five paired
development cells native `xhigh` cost 11 % more in total than a fixed `high` with every cell passing
(`bench/results/router-vs-high-2026-09-28`, stopped at 16 of 45 cells and not adjudicated).

Jev returns a probability for every level. The Router orders the levels together with the current one and moves
down to the lowest whose mass at or below it reaches `minDowngradeConfidence`, else up to the highest whose mass at
or above it reaches `minUpgradeConfidence`, else nowhere (`low_confidence`, or `same_value` when the current level
holds the most mass). So `[0.74, 0.26, 0]` under an Opus parent moves the spawn to `sonnet`: 1.0 says the work needs
no more than ordinary, while lookup alone is under 0.9.

The `control` question stays a choice, and it is the escape hatch: a root move needs `task_clear` at the floor for its
direction, so a request that depends on earlier conversation or names its own model or effort stays where it is. A
root turn is sent with the tail of the conversation's last visible reply (`previous_reply`, 2,000 characters; a reply
the credential screen flags anywhere is not sent at all), which
most of the owner's turns answer ("ㅇㅇ", "다진행해": a median 22 characters over 245 turns); replayed with it, Jev
judged 54 of them `needs_context` rather than 115. A spawn's prompt is everything its subagent gets, so a spawn is
held only by `explicit_lock`: `needs_context` and `unclear` judge the same text the subagent works from. No
level has a `preserve` answer; declining is `control`'s job. Every decision logs its receipt, `answers`, with the
`control` choice, the `task_clear` and `ordinary` probabilities and each Score's levels.

Why levels rather than labels (2026-09-27, `bench/results/host-obs-2026-09-27/`). The same 25 development tasks
and 8 requests that should stay put (context-dependent or explicitly pinned) went through the shipped path
(`createRouter`, live Jev, one call each) under both question forms, from an Opus parent and an `xhigh` root:

| | labels (previous) | levels |
|---|---|---|
| spawns moved, of 18 not deep | 12 | 14 |
| root turns moved, of 18 not deep | 6 | 13 |
| deep tasks lowered, of 7 | 1 (root, `xhigh` → `high`) | 0 |
| negatives moved, of 8 | 0 | 0 |

The four spawns the levels left native were held by `control` (`task_clear` 0.68–0.82 against the 0.9 floor), not by
the level answer. A call used about 870 input and 105 output units of Jev usage and returned in about 200 ms. The
prompts are short and written by us, and the level wording was drafted after seeing an earlier panel; the 12 held-out
tasks and the negatives were fixed before any run. These are counts of moves, not a saving: whether a moved task
still succeeds, and what it saves, is unmeasured. The floors are policy numbers, not a calibration.

A root turn is judged once, at its first step, and its patch is reapplied to each later step of that turn. A turn with
no user text (`no_task_text`) is not judged. If a step reports another model than the one requested, or reports none,
the model override stops for the rest of the turn, and so does an effort the observed model cannot take; this holds
for an effort-only patch too, since the host can answer from a fallback. A model override needs its own variant
reported back: a bare `claude-opus-5-5` does not confirm a requested `claude-opus-5-5[1m]`, and ends that override.
An effort-only patch compares by model alone, in both directions (bare against `[1m]` and back), since effort does
not depend on the variant. If a step's incoming model or effort differs from the
baseline, something else changed it, and the Router stops for the rest of the turn (`root_stop`). So it does if the
host dispatched a step without waiting for the hook (`step_abandoned`): a later step never switches away from what that
one ran on.

**Root effort and the prompt cache.** Changing the effort always invalidates a conversation's cached messages
(platform docs, *Prompt caching*), and the host sends each turn's effort both as a per-message change and
as the top-level value (2.1.283, observed on a local fake API). So on a warm cache — a response that the requested model
itself gave (by the model its usage reports) within the last 55 minutes, under the host's one-hour cache lifetime — a lower effort is held at the one the cache was
written at (`held_for_cache` names what was asked), and only a rise pays the rewrite. Lowering waits for a cold cache:
a session's first turn, a model change, or an hour's pause. Replayed on the owner's 245 root turns of 2026-09-21..28,
whose first requests re-read a median 185K tokens, lowering freely moved effort at 71 warm turns and, with each
rewrite priced, cost 2.7 % more than it saved; held, 12 warm turns moved and it saved whichever way the cache behaves.
The savings in that replay are assumed shares of each turn's cost, not measured ones.

**Subagent effort.** A subagent's loop steps through `turn.step` with its own `agentId`, which the spawn's result
carries (2.1.283, observed). The spawn is asked the effort question on the full scale before its subagent's effort
is known; its loop's first step reads that answer against the model and effort the loop actually runs at and decides
for the whole loop, so one subagent keeps one effort and its cache is never restarted. A first step that could not
wait for the spawn's id (1.5 s) runs native and so does the rest of its loop. A step that arrives on another model or
effort, an effort pin, or a patched step answered by another model leaves that loop native too (`child_stop`). On the fake API, a probe plugin making the same two patches (a named `model: "opus"` spawn to
`sonnet`, each of its loop's steps to `low`) sent every subagent request as `claude-sonnet-5` at `effort: low` while
the root stayed at `xhigh` (`~/jev-gate-runs/router-v2-2026-09-28/probe-child/`).

A spawn is judged per dispatch, on its own prompt, even when a `tool_use_id` repeats. Every wait it makes (the pins,
the host release, the allowlist, Jev) ends with that dispatch or with the session it began in. A spawn whose session
ended meanwhile sends nothing more and stays native (`session_ended`).

Each routed result is logged with what the host reported: `root_result` carries the applied patch, the model the step
reports and the four counts of its usage (nothing else of it), and `spawn_result` the requested and resolved
model and the agent id, or the denial. Usage counts are logged as `input`, `output`, `cache_read` and
`cache_creation`, for the Router's own Jev calls and for the host's: the host's debug log replaces the value of any
key containing `token` with a bare `[REDACTED]`, which leaves the line unparsable, so logs written before this change
carry no readable usage. These are per-step records, not a saving: overlapping totals are for #45 to normalize.

## Limits

- **The host's test kit cannot set plugin options**, so `claude plugin test` only covers the default (off) path. The
  enabled paths run through `register.ts` in vitest with a fake `$` (`tests/router/register.test.ts`).
- **Hosts are checked at run time, not pinned.** Spawn routing depends on how the host resolves an inheriting
  built-in's model: 2.1.282 was read from its declarations, and 2.1.283 was observed. A pin to one exact release left
  every spawn native after each host update, so any 2.1.N with N at least 282 is accepted, and the session checks
  what the host reports instead. If a routed spawn reports another model than the one requested
  (`model_mismatch`), or an unrouted inheriting spawn does not run on its parent's model (`baseline_mismatch`, which
  means the baseline the Router ranks from is wrong), every later spawn in that activation stays native,
  model and subagent effort alike (`spawn_suspended`, logged once), including one whose assessment was still waiting
  on Jev and a subagent whose loop has sent no patched step yet (even one whose first step is still being prepared).
  A spawn already handed to the host keeps the model it was sent with; if it returns after the suspension, its
  subagent gets no effort from it. A loop already running keeps its effort. A spawn that a pin
  kept native, even one set while Jev answered, runs on the pinned model and is not checked against the parent's. The suspension outlives a session end, so a host that broke it once is not
  trusted again until the plugin reloads. The check comes after the fact: the spawn that reveals the mismatch has
  already run.
- **A hook never calls `next` after its signal aborts.** By then the host has gone on without it, and a `next` would
  start a second request. A root step returns nothing, and a spawn throws. While the signal is live, the handler
  checks, with nothing awaited before `next`, that the session it began in has not ended (and, at the root, that the
  turn is still live); otherwise the step or spawn goes on native (`session_ended`, `turn_stopped`). A failing
  diagnostic or bookkeeping call never keeps an event from being forwarded.
- **The credential screen is copied, not imported,** because a Function Hooks module cannot import the Node side of
  the repository. A parity test keeps the two lists identical.
