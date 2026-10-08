import { obj, type Obj } from './source.js';

/** Native history ownership/compaction support is not established by API model support. */
export const requestedUpdateEffort = (request: Obj): { present: boolean; effort: string | null } => {
  if (!Array.isArray(request['input'])) return { present: false, effort: null };
  const updates = request['input'].filter(v => obj(v)?.['type'] === 'configuration_update');
  const effort = obj(obj(updates.at(-1))?.['reasoning'])?.['effort'];
  return { present: updates.length > 0, effort: typeof effort === 'string' ? effort : null };
};
