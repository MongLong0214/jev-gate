// Korean padding: characters and bytes diverge by ~3x, which separates a character cap from a byte cap.
import { writeFileSync } from 'node:fs';
const [outDir, target] = [process.argv[2], Number(process.argv[3])];
const rel = `src/k${target}.ts`, marker = `KOMARK${target}`;
const bodies = []; let chars = 0;
for (;;) {
  const i = bodies.length + 1;
  const body = `${marker} ${'한글'.repeat(60)}`;
  const line = `${rel}:${i}:${body}`;
  if (chars + line.length + (i === 1 ? 0 : 1) > target) break;
  chars += line.length + (i === 1 ? 0 : 1);
  bodies.push(body);
}
writeFileSync(`${outDir}/${rel}`, bodies.join('\n') + '\n');
const rendered = bodies.map((b, n) => `${rel}:${n + 1}:${b}`).join('\n');
console.log(`${marker} lines=${bodies.length} chars=${rendered.length} bytes=${Buffer.byteLength(rendered, 'utf8')}`);
