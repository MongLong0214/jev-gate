// Generates the prior-context material the session reads before the job starts. Each file stays under the host's
// 20,000-character model-facing cap so it arrives whole; thirty of them put roughly 140K tokens of *conversation*
// into the main session, which is what a subagent does not inherit.
import { mkdirSync, writeFileSync } from 'node:fs';
const N = 30, WIDTH = 18800;
mkdirSync('reference', { recursive: true });
let seed = 20260919;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const WORDS = Array.from({ length: 420 }, (_, i) => `sym${String(i).padStart(4, '0')}`);
for (let n = 1; n <= N; n += 1) {
  const lines = [`# reference/note-${String(n).padStart(2, '0')}.md`, '', 'Background material from earlier work. It records what was looked at; it sets no rules.', ''];
  let size = lines.join('\n').length;
  let i = 0;
  while (size < WIDTH) {
    const l = `- entry ${n}.${i}: ` + Array.from({ length: 11 }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
    if (size + l.length + 1 > WIDTH) break;
    lines.push(l); size += l.length + 1; i += 1;
  }
  writeFileSync(`reference/note-${String(n).padStart(2, '0')}.md`, lines.join('\n') + '\n');
}
