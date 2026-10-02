import { readJob, updateJob, own, release } from './job.js';
import { DEFAULT_CONFIG } from './config.js';
import { claudeAllocation } from './claude-allocation.js';
import { OWNED_AGENTS } from './types.js';
import { pathToFileURL } from 'node:url';

/** Called at native agent.spawn, before next. Reuses the existing atomic job writer; never creates a new state store. */
export const dispatchPolicy = (session: string, tool: string, proposed: string, allowFable: boolean, env = process.env, agent = '', eligible = true, unstartedToken = ''): unknown => {
  if (!session || session.length > 160 || !tool || tool.length > 160) return { deny: 'Invalid dispatch identity; no child started.' };
  const loaded = readJob(env, session); if (!loaded.ok) return { deny: 'Dispatch ownership unavailable; no child started.' };
  const owner = own(loaded.value?.current.active ?? {}, tool);
  const adapter = claudeAllocation({ ...env, CLAUDE_PLUGIN_OPTION_ROUTERALLOWFABLE: String(allowFable) });
  const model = owner?.allocation_pair?.model ?? (owner?.role === 'executor' ? proposed : proposed || (owner?.tier ? DEFAULT_CONFIG.models[owner.tier] : OWNED_AGENTS[agent] ? DEFAULT_CONFIG.models[OWNED_AGENTS[agent]!.tier] : ''));
  const canonical = adapter.canonical?.(model) ?? model;
  if (eligible && adapter.allowed(canonical)) return owner?.allocation_pair ? { ...owner.allocation_pair, model: canonical } : { model: canonical, effort_edit: { kind: 'keep' } };
  if (owner) {
    let released = false;
    const written = updateJob(env, session, prev => {
      const current = prev ? own(prev.current.active, tool) : undefined;
      if (!prev || !current || prev.current.prompt_id !== loaded.value?.current.prompt_id ||
          current.started_at !== owner.started_at || current.rev !== owner.rev || current.attempt !== owner.attempt ||
          current.codex_execution || current.background_execution && (current.background_execution.agent_id ||
            !/^[a-f0-9-]{36}$/.test(unstartedToken) || current.background_execution.token !== unstartedToken)) return null;
      released = true;
      return { ...prev, current: { ...release(prev.current, tool), root_fallback: true, root_fallback_reason: 'delivery_failed', background_context: 'No eligible automatic child model. Continue in the main session; no child started.' } };
    });
    if (!written.ok || !released) return { deny: 'No child started. Ownership cleanup pending; reservations remain protected.' };
  }
  return { deny: 'No eligible automatic child model. Continue in the main session; no child started.' };
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [session = '', tool = '', model = '', allow = 'false', agent = '', eligible = 'true', token = ''] = process.argv.slice(2);
  try { process.stdout.write(JSON.stringify(dispatchPolicy(session, tool, model, allow === 'true', process.env, agent, eligible === 'true', token))); }
  catch { process.stdout.write(JSON.stringify({ deny: 'Dispatch policy unavailable; no child started.' })); }
}
