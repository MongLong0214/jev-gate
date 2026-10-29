import { obj, type Obj } from './source.js';

const GUIDANCE = 'Jev routed execution: Complete the exact user contract with fewer model/tool round trips. Before editing, establish the original public signatures, input types, validation and invariants from authoritative requirements, including earlier turns. Do not infer an API from its name or adapt the contract to an existing implementation. Reuse reliably visible requirements; if they are missing, ambiguous or buried in old context, recover the original source with native tools before implementing. Check the public interface against those requirements, including follow-up work; passing a smoke test or tests written around your implementation is not proof of contract compliance. Plan related reads together and batch independent reads using the available native tools. When the user names target files, inspect those files, applicable workspace instructions, existing tests and package configuration together in one native discovery call when possible. After editing, run required checks and inspect the final diff in a single native tool call when supported; keep dependent checks sequential and make every check result observable. Once enough context is available, make coherent related edits, then run required checks; combine operations only when the tool supports it and every result stays observable. Avoid redundant work after requirements are established. Keep dependent operations sequential and never race writes. Stop and inspect unexpected failures before continuing. Native tool instructions, user constraints, permissions and required verification remain authoritative; never skip a check or invent success to reduce usage.';

/** A request-local tail hint: a changed route never rewrites the native reusable prefix.
 * This is not persisted history or a promise of server cache reuse. */
export const routedExecution = (original: Obj, selected: Obj, preRouted = false): Obj => {
  if (!preRouted && (original === selected || original['model'] === selected['model'] && obj(original['reasoning'])?.['effort'] === obj(selected['reasoning'])?.['effort'])) return selected;
  // Incremental contexts belong to the native server; do not reconstruct or prepend their history.
  if (selected['previous_response_id']) return selected;
  if (selected['instructions'] !== undefined && typeof selected['instructions'] !== 'string' || !Array.isArray(selected['input'])) return selected;
  const input = selected['input'] as unknown[];
  const last = obj(input.at(-1)); const content = last?.['content'];
  if (last?.['type'] === 'message' && last['role'] === 'developer' && Array.isArray(content) && content.length === 1 && obj(content[0])?.['type'] === 'input_text' && obj(content[0])?.['text'] === GUIDANCE) return selected;
  // Responses Lite carries both instructions and tool definitions in input, rather than top-level fields.
  return { ...selected, input: [...input, { type: 'message', role: 'developer', content: [{ type: 'input_text', text: GUIDANCE }] }] };
};
