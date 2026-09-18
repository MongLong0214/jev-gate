// Long lines keep the result under the host's 250-line head_limit, and the last line is padded so the rendered
// content lands on the target byte exactly. Every line matches, so ripgrep emits no `--` separators.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, ...targets] = process.argv.slice(2);
mkdirSync(join(outDir, 'src'), { recursive: true });
const PAD = 200;
const plan = [];
for (const t of targets.map(Number)) {
  const rel = `src/c${t}.ts`;
  const marker = `CAPMARK${t}`;
  const bodies = [];
  let size = 0;
  const lineBytes = (i, body) => Buffer.byteLength(`${rel}:${i}:${body}`, 'utf8') + (i === 1 ? 0 : 1);
  for (;;) {
    const i = bodies.length + 1;
    const full = `${marker} ${'x'.repeat(PAD)}`;
    const next = size + lineBytes(i, full);
    if (next > t) {
      // Last line: shrink its padding so the total is exactly the target.
      // The bare last line may still not fit; drop a full line and try again with the freed room.
      let idx = i;
      let base = size;
      while (t - base - lineBytes(idx, `${marker} `) < 0) {
        const dropped = bodies.pop();
        if (dropped === undefined) throw new Error(`target ${t} is smaller than one line`);
        idx -= 1;
        base -= lineBytes(idx + 1, dropped);
      }
      bodies.push(`${marker} ${'x'.repeat(t - base - lineBytes(idx, `${marker} `))}`);
      size = t;
      break;
    }
    bodies.push(full);
    size = next;
  }
  writeFileSync(join(outDir, rel), bodies.join('\n') + '\n');
  plan.push({ target: t, marker, path: rel, lines: bodies.length, predicted_bytes: size });
}
writeFileSync('plan.json', JSON.stringify(plan, null, 2));
console.log(plan.map((p) => `${p.marker} lines=${p.lines} predicted=${p.predicted_bytes}`).join('\n'));
