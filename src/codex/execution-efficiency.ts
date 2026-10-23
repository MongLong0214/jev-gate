import { obj, type Obj } from './source.js';

const GUIDANCE = 'Jev routed execution: Minimize total model/tool round trips while completing every user requirement. Plan the related reads together and batch independent reads using the available native tools. Reuse context already read when it is still current. Once enough context is available, make coherent related edits, then run the required checks; use one native tool round for this sequence only when the existing tool supports it and every result remains observable. Avoid repeated tiny edits, unchanged rereads and redundant checks. Keep dependent operations sequential and never race writes. Stop and inspect unexpected failures before continuing. Native tool instructions, user constraints, permissions and required verification remain authoritative; never skip a check or invent success to reduce usage.';

/** A request-local tail hint: a changed route never rewrites the native reusable prefix.
 * This is not persisted history or a promise of server cache reuse. */
export const routedExecution = (original: Obj, selected: Obj): Obj => {
  if (original === selected || original['model'] === selected['model'] && obj(original['reasoning'])?.['effort'] === obj(selected['reasoning'])?.['effort']) return selected;
  // Incremental contexts belong to the native server; do not reconstruct or prepend their history.
  if (selected['previous_response_id']) return selected;
  if (selected['instructions'] !== undefined && typeof selected['instructions'] !== 'string' || !Array.isArray(selected['input'])) return selected;
  const input = selected['input'] as unknown[];
  const last = obj(input.at(-1)); const content = last?.['content'];
  if (last?.['type'] === 'message' && last['role'] === 'developer' && Array.isArray(content) && content.length === 1 && obj(content[0])?.['type'] === 'input_text' && obj(content[0])?.['text'] === GUIDANCE) return selected;
  // Responses Lite carries both instructions and tool definitions in input, rather than top-level fields.
  return { ...selected, input: [...input, { type: 'message', role: 'developer', content: [{ type: 'input_text', text: GUIDANCE }] }] };
};
