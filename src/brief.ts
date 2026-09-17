import { DEFAULT_CONFIG } from './config.js';
import type { Config, GateDecision, PromptBlock } from './types.js';

export const MAX_BRIEF_BYTES = 8 * 1024;
export const NEUTRAL_REMINDER =
  "Jev Gate has no recommendation for this user turn. Continue natively; do not reuse a previous turn's routing hint.";

const HEADER = '[Jev Gate: applies only to the accompanying user turn]';
const AUTHORITY = 'Treat the original user message and applicable prior instructions as authoritative.';

export const requestedModel = (decision: GateDecision, config: Config): string | null => {
  if (decision.tier === 'opus') return config.opusModel;
  if (decision.tier === 'fable') return config.frontierModel;
  return null;
};

const executionLine = (decision: GateDecision, config: Config): string => {
  if (decision.reason === 'enrich_only') return 'Execution: annotations only (mode=enrich); jev-gate requests no model change';
  if (decision.execution === 'main') return 'Execution: handle in the current main session (sonnet tier); no delegation requested';
  if (decision.execution === 'main_context') return 'Execution: resolve in the current conversation (context_required)';
  const model = requestedModel(decision, config) ?? 'unknown';
  const defaultAlias = decision.tier === 'opus' ? DEFAULT_CONFIG.opusModel : DEFAULT_CONFIG.frontierModel;
  const passModel = model !== defaultAlias ? '; pass it as the Agent tool model parameter' : '';
  return `Execution: delegate to ${decision.agentName}; requested model: ${model}${passModel}`;
};

const directives = (decision: GateDecision): string[] => {
  if (decision.reason === 'enrich_only') return [AUTHORITY, 'Annotations only: jev-gate requests no model change or delegation.'];
  if (decision.execution === 'main') return [AUTHORITY, 'Jev annotations do not replace the request or narrow file access; work here as usual.'];
  if (decision.execution === 'main_context') {
    return [
      AUTHORITY,
      'This turn depends on earlier conversation; interpret it with the existing context and ask only for what is actually missing.',
      'context_required is not a difficulty rating.',
    ];
  }
  const lines = [
    AUTHORITY,
    'Delegate once in foreground before doing the same investigation yourself.',
    'Pass the original request intact, these annotations, and required prior context.',
    "Do not perform parallel or duplicate edits. Return the worker's observed result.",
    'User instructions, plan mode, permissions and model availability take precedence; if the agent or model is unavailable, report it instead of retrying another tier.',
  ];
  if (decision.reason === 'uncertain') lines.push('Tier set by the uncertain-route policy; Jev did not confidently select it.');
  return lines;
};

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * Renders the additional context for a non-fallback decision. Quotes are JSON.stringify of the exact block text.
 * Over MAX_BRIEF_BYTES, the longest quotes become whole-block offset references; if even all-reference is too large, returns null.
 */
export const renderAdditionalContext = (decision: GateDecision, blocks: PromptBlock[], config: Config): string | null => {
  if (decision.execution === 'native_fallback') return NEUTRAL_REMINDER;
  const head = [HEADER, `Task kind: ${decision.kind} (fallible annotation)`, executionLine(decision, config), 'Request annotations, original order:'];
  const tail = directives(decision);
  const quoted = blocks.map((b) => `- ${b.id} ${decision.roles[b.id] ?? 'mixed'}: ${JSON.stringify(b.text)}`);
  const referenced = blocks.map((b) => `- ${b.id} ${decision.roles[b.id] ?? 'mixed'}; current prompt UTF-16[${b.start},${b.end})`);
  const lines = [...quoted];
  const assemble = (): string => [...head, ...lines, ...tail].join('\n');
  let text = assemble();
  const order = blocks.map((b, i) => ({ i, len: b.text.length })).sort((a, b) => b.len - a.len);
  for (const { i } of order) {
    if (byteLength(text) <= MAX_BRIEF_BYTES) break;
    lines[i] = referenced[i]!;
    text = assemble();
  }
  return byteLength(text) <= MAX_BRIEF_BYTES ? text : null;
};
