// TEST-ONLY. Appends one JSON line per hook event. Emits nothing back to the host: this probe must not
// alter what the model receives, only observe it.
import { appendFileSync, readFileSync } from 'node:fs';

const log = process.env['CAP_PROBE_LOG'];
let raw = '';
try { raw = readFileSync(0, 'utf8'); } catch { raw = ''; }

const sizeOf = (s) => (typeof s === 'string' ? Buffer.byteLength(s, 'utf8') : null);

let out;
try {
  const e = JSON.parse(raw);
  const event = e.hook_event_name ?? null;
  if (event === 'PostToolBatch') {
    // Carries tool_response as the RENDERED string: this is what the model actually received.
    out = {
      event,
      calls: (e.tool_calls ?? []).map((c) => ({
        tool: c.tool_name ?? null,
        pattern: c.tool_input?.pattern ?? null,
        rendered_bytes: sizeOf(c.tool_response),
        rendered_head: typeof c.tool_response === 'string' ? c.tool_response.slice(0, 220) : null,
      })),
    };
  } else {
    const r = e.tool_response ?? {};
    out = {
      event,
      tool: e.tool_name ?? null,
      pattern: e.tool_input?.pattern ?? null,
      mode: r.mode ?? null,
      hook_content_bytes: sizeOf(r.content),
      hook_content_chars: typeof r.content === 'string' ? r.content.length : null,
      numLines: r.numLines ?? null,
      totalLines: r.totalLines ?? null,
      appliedLimit: r.appliedLimit ?? null,
    };
  }
} catch (err) {
  out = { event: 'parse_failed', error: String(err), raw_bytes: sizeOf(raw) };
}
if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), ...out }) + '\n');
