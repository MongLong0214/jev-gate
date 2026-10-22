type Rec = Record<string, unknown>;
const record = (v: unknown): Rec | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Rec : null;

/** Only explicit structured status or native headers; never infer success from a completed code-mode script. */
export const toolOutcome = (value: unknown): { exit_code: number | null; is_error: boolean } => {
  const response = record(value);
  let code = Number.isSafeInteger(response?.['exit_code']) ? response!['exit_code'] as number : null;
  if (typeof value === 'string') {
    // Codex can omit Chunk ID and include a truncation count before Output.
    const match = /^(?:Chunk ID: [A-Za-z0-9_-]+\n)?Wall time: \d+(?:\.\d+)? seconds\nProcess exited with code (-?\d+)\n(?:Original token count: \d+\n)?(?:Final output:|Output:)\n/.exec(value.slice(0, 512));
    if (match && Number.isSafeInteger(Number(match[1]))) code = Number(match[1]);
  }
  // Code-mode owns the first content block. "Script completed" says only that JS completed:
  // a nested shell call may still have failed. Only its explicit outer failure is evidence.
  const first = Array.isArray(value) ? record(value[0]) : null;
  const scriptFailed = first?.['type'] === 'input_text' && typeof first['text'] === 'string' &&
    /^Script failed\nWall time \d+(?:\.\d+)? seconds(?: \(code-mode \d+(?:\.\d+)? seconds; overhead -?\d+(?:\.\d+)? seconds\))?\nOutput:\n$/.test(first['text']);
  return { exit_code: code, is_error: response?.['isError'] === true || response?.['is_error'] === true || scriptFailed || code !== null && code !== 0 };
};
