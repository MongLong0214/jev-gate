import { foldVitest, isVitestCommand, MARK, MAX_BYTES, MIN_SAVING, utf8Bytes } from '../../mods/output/hooks/filter.ts';

type Rec = Record<string, unknown>;
const record = (v: unknown): Rec | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null;
export type CodexFold = { applied: true; text: string; before: number; after: number; runs: number } | { applied: false; reason: string };

/** Lossless repeated-line folding. A passing summary is not evidence of the process exit code. */
export const foldCodexOutput = (command: unknown, response: unknown): CodexFold => {
  if (typeof command !== 'string' || !isVitestCommand(command)) return { applied: false, reason: 'command' };
  let prefix = '';
  let output: string;
  if (typeof response === 'string') {
    // Native unified-exec's model-facing envelope. No partial/running session, truncation or error is eligible.
    const match = /^(Chunk ID: [A-Za-z0-9_-]+\nWall time: [\d.]+ seconds\nProcess exited with code 0\n(?:Final output:|Output:)\n)([\s\S]*)$/.exec(response);
    // Codex 0.158.0 delivers raw stdout without exit status. Preserve that fact; never invent code 0.
    prefix = match?.[1] ?? '';
    output = match?.[2] ?? response;
  } else {
    const r = record(response);
    if (!r || r['exit_code'] !== 0 || typeof r['output'] !== 'string' || r['session_id'] != null || r['truncated'] === true
      || r['original_token_count'] !== undefined) return { applied: false, reason: 'response_format' };
    // Only the known completed unified-exec object; unknown fields may carry stderr or truncation metadata.
    if (Object.keys(r).some(k => !['exit_code', 'output', 'chunk_id', 'wall_time_seconds', 'session_id', 'truncated'].includes(k))) return { applied: false, reason: 'response_format' };
    prefix = `Process exited with code 0\n`;
    output = r['output'];
  }
  if (utf8Bytes(output) > MAX_BYTES || /(?:truncated|output omitted|omitted \d+ lines)/i.test(output)) return { applied: false, reason: 'incomplete_or_large' };
  const folded = foldVitest(output);
  if (!folded.ok) return { applied: false, reason: folded.reason };
  const text = `${prefix}${MARK} Identical consecutive lines are shown once with their exact count. All other output is preserved.\n\n${folded.text}`;
  const before = utf8Bytes(prefix + output);
  const after = utf8Bytes(text);
  return before - after >= MIN_SAVING ? { applied: true, text, before, after, runs: folded.runs } : { applied: false, reason: 'saving_small' };
};
