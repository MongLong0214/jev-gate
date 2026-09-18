import { MAX_OUTPUT_BYTES } from '../brief.js';
import type { ContextCode, SearchBlock } from '../types.js';
import { contentBytesOf, renderGrepResponse, type GrepMeta } from './blocks.js';

/**
 * §8: the one PostToolUse object this feature emits. `updatedToolOutput` is the host's own Grep shape, rebuilt by the
 * adapter from the selected original bytes, and `additionalContext` is a short notice generated entirely by code.
 *
 * The notice states counts and where the original is, and nothing else: it never summarises an omitted block and never
 * claims what the omitted text did or did not contain.
 */
export const NOTICE_HEADER = '[Jev Gate selected search view]';

export type RenderCode = Extract<ContextCode, 'replacement_not_smaller' | 'replacement_too_large'>;

export const renderDisclosure = (returned: number, shown: number, recoveryPath: string): string =>
  [
    NOTICE_HEADER,
    `The search returned ${returned} result blocks; ${shown} are shown here.`,
    'This is a non-exhaustive selection of the original result, not a summary of it.',
    `The complete original result is recoverable with Read at ${recoveryPath}`,
  ].join(' ');

export interface ContextOutput {
  ok: true;
  stdout: string;
  updatedToolOutput: Record<string, unknown>;
  additionalContext: string;
  /** The model-facing size after replacement, measured the same way as `beforeBytes`. */
  afterBytes: number;
  beforeBytes: number;
}

export type RenderResult = ContextOutput | { ok: false; code: RenderCode };

export interface RenderInput {
  meta: GrepMeta;
  kept: readonly SearchBlock[];
  /** Total blocks the search returned, including the ones omitted and the protected ones. */
  returned: number;
  recoveryPath: string;
}

/**
 * A replacement is proposed only when the model-facing result including the notice is smaller than the original.
 *
 * The comparison is selected content bytes plus notice bytes against original content bytes. That is the closest measure
 * available inside the hook; the probe has to confirm how the native renderer sizes what it actually sends, and a byte
 * reduction is not by itself a token or price reduction.
 */
export const buildContextOutput = (input: RenderInput): RenderResult => {
  const additionalContext = renderDisclosure(input.returned, input.kept.length, input.recoveryPath);
  const beforeBytes = input.meta.contentBytes;
  const afterBytes = contentBytesOf(input.kept) + Buffer.byteLength(additionalContext, 'utf8');
  if (afterBytes >= beforeBytes) return { ok: false, code: 'replacement_not_smaller' };
  const updatedToolOutput = renderGrepResponse(input.meta, input.kept);
  const stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput, additionalContext } });
  if (Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) return { ok: false, code: 'replacement_too_large' };
  return { ok: true, stdout, updatedToolOutput, additionalContext, afterBytes, beforeBytes };
};
