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
  /**
   * Host tools withheld in frontmatter. `tools` stays absent so connected MCPs are still inherited; withholding Skill
   * drops the skills listing, and Artifact its large definition. Every profile also sets `omitClaudeMd: true`: its
   * prompt carries what it needs.
   */
  disallowedTools: readonly string[];
}

/** Effort is the only per-agent fact not already in OWNED_AGENTS. */
const EFFORT: Record<string, string | null> = {
  'jev-gate:worker-fast': 'low',
  'jev-gate:worker': null,
  'jev-gate:worker-deep': 'high',
  'jev-gate:worker-frontier': 'xhigh',
};

const WORKER_DISALLOWED = ['Agent', 'SendMessage', 'Skill', 'Artifact', 'ArtifactComments', 'ArtifactData'];
const DISALLOWED: Record<OwnedRole, readonly string[]> = { worker: WORKER_DISALLOWED };

/** The four tiered profiles. */
export const OWNED_AGENT_PROFILES: readonly OwnedAgentProfile[] = OWNED_AGENT_NAMES.map((name) => {
  const owned = OWNED_AGENTS[name];
  if (!owned || !(name in EFFORT)) throw new Error(`agents.ts: OWNED_AGENTS and EFFORT must agree on ${name}`);
  return { name, file: `${name.slice('jev-gate:'.length)}.md`, role: owned.role, tier: owned.tier, effort: EFFORT[name] ?? null, disallowedTools: DISALLOWED[owned.role] };
});
