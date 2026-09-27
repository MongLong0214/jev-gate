import type { OwnedRole, Tier } from './types.js';
import { OWNED_AGENT_NAMES, OWNED_AGENTS } from './types.js';

/**
 * #48 P0-2: one table of the per-profile facts that used to live in three places -- `DEFAULT_CONFIG.models`, each
 * agent's own frontmatter, and doctor's hard-coded `AGENT_EXPECTATIONS` -- and disagreed. `role` and `tier` are read
 * from `OWNED_AGENTS` (types.ts) rather than repeated here, so this table cannot itself become a second copy of the
 * map the guard, eligibility check and tier router already key off. `model` is deliberately absent: it is
 * `DEFAULT_CONFIG.models[tier]` (config.ts), read at the two call sites that need it (`gen-agents`, doctor) instead
 * of copied a third time.
 */
export interface OwnedAgentProfile {
  /** The scoped name the host discovers this agent under, e.g. `jev-gate:worker-frontier`. */
  name: string;
  /** File under `agents/`, e.g. `worker-frontier.md`. */
  file: string;
  role: OwnedRole;
  tier: Tier;
  /** `null` means the profile inherits the session's effort rather than declaring its own frontmatter line. */
  effort: string | null;
  tools: readonly string[];
}

const WORKER_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] as const;
const PLANNER_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** Effort and tools are the only per-agent facts not already in OWNED_AGENTS; everything else is derived from it. */
const EFFORT_AND_TOOLS: Record<string, { effort: string | null; tools: readonly string[] }> = {
  'jev-gate:worker-fast': { effort: 'low', tools: WORKER_TOOLS },
  'jev-gate:worker': { effort: null, tools: WORKER_TOOLS },
  'jev-gate:worker-deep': { effort: 'high', tools: WORKER_TOOLS },
  'jev-gate:worker-frontier': { effort: 'xhigh', tools: WORKER_TOOLS },
  'jev-gate:planner': { effort: 'high', tools: PLANNER_TOOLS },
  'jev-gate:planner-frontier': { effort: 'xhigh', tools: PLANNER_TOOLS },
};

/** The six tiered profiles. JGL-01's lean executor is deliberately not here: it is `inherit`, not tiered, and it is
 * not a key of OWNED_AGENTS either -- see `LEAN_EXECUTOR_AGENT` in types.ts. */
export const OWNED_AGENT_PROFILES: readonly OwnedAgentProfile[] = OWNED_AGENT_NAMES.map((name) => {
  const owned = OWNED_AGENTS[name];
  const et = EFFORT_AND_TOOLS[name];
  if (!owned || !et) throw new Error(`agents.ts: OWNED_AGENTS and EFFORT_AND_TOOLS must agree on ${name}`);
  return { name, file: `${name.slice('jev-gate:'.length)}.md`, role: owned.role, tier: owned.tier, effort: et.effort, tools: et.tools };
});
