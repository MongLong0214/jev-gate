# Pre-registration — is delegation being measured at the wrong point? 2026-09-19

Written before the run. The prediction below is the thing that must not move afterwards.

## Why this run exists

Every comparison this repository has ever made started from an empty session. Measured on the cells themselves:

| | turn-1 context | peak |
|---|---|---|
| bench cells (all arms, all jobs) | 39,554 – 41,007 | 44,449 – 57,426 |
| this operator's real sessions | — | **mean 516,711 per turn** |

That gap is not incidental, because delegation's saving is a function of exactly that number. A worker starts in its
own session at its own prefix and does not inherit the main session's accumulated conversation. So for a job of `T`
turns adding `d` tokens each, from a main session already carrying `X`:

```
direct      ≈ Σ (X + d·i)                      i = 1..T
delegated   ≈ 2X + (Agent result)  +  Σ (P + d·i)
saving      ≈ (T − 2)·X  −  T·P
```

with the measured values `d = 916` tokens per turn, `P ≈ 45,000` (a fresh session's prefix) and an Agent result
averaging 1,198 bytes. Delegation therefore pays only when **X > P·T/(T−2)**, which for anything but a two-turn job is
approximately **X > 45,000**.

The bench runs at `X ≈ 44,000`. That is the crossing point. **Every run in this repository — including V4's recorded
"forced delegation cost 37.7 % more" — measured delegation at the one context depth where the model says it cannot
pay.** This run tests that claim by moving the depth and nothing else.

## Design

Two jobs, identical work, differing only in what the session carries when the work starts:

- `wide-validators` — the job alone, `X ≈ 40K`.
- `wide-validators-loaded` — the same job, preceded by reading 30 reference files one `cat` at a time, putting roughly
  **140K tokens of accumulated conversation** into the main session first, `X ≈ 180K`.

The preload is conversation, not configuration, on purpose: a project `CLAUDE.md` would be inherited by the worker and
would cancel the effect being tested. It is sized to stay under the compaction threshold — measured at 262,608 with the
300,000 window now in force — so the preload survives into the job phase instead of being summarised away.

Three arms. `sonnet_native` (no plugin). `jev_hierarchy` (plugin, `auto`). `jev_forced_orchestration`, the harness's
existing diagnostic arm, which starts an orchestrated job without asking Gate A — because Gate A has answered `direct`
on every job put to it so far, and this run needs to separate *"does the gate admit"* from *"does orchestration pay
once admitted"*. Defaults elsewhere; `maxParallelWorkers` stays at 1.

## The prediction

| condition | prediction |
|---|---|
| `wide-validators` (X ≈ 40K) | `jev_forced_orchestration` costs **more** than `sonnet_native` — reproduces V4 |
| `wide-validators-loaded` (X ≈ 180K) | `jev_forced_orchestration` costs **less** than `sonnet_native` |
| both | `jev_hierarchy` answers `direct` and tracks `sonnet_native` |

**What refutes it:** forced orchestration costing more in *both* conditions refutes the context-locality account
outright. Costing less in *both* refutes the explanation offered for the earlier failures — the depth would not have
been what was wrong. `jev_hierarchy` answering `orchestrated` on either job is new information either way and is
reported whatever it does.

**What counts as a result:** the sign of the difference flipping between the two conditions. One repetition per cell
cannot establish a magnitude — the 2026-09-18 runs showed ±5 % between two mechanically identical arms — so no
percentage from this run is a claim on its own. A flip earns repetitions; anything else is reported as it lands.

Pass rate is checked first. If the arms do not all pass their checker, cost is not compared at all.
