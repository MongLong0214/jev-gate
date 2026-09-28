import { readSessionDepth } from '/Users/isaac/projects/jev-gate/dist/depth.js';
import { readFileSync, appendFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const t0 = process.hrtime.bigint();
const r = readSessionDepth(input.transcript_path);
appendFileSync('/private/tmp/claude-501/-Users-isaac/7e6c9912-42a3-40e9-a21b-c0b1ae3f3c7d/scratchpad/hooksmoke/probe.jsonl',
  JSON.stringify({ transcript: input.transcript_path, reading: r, wall_ms: Number(process.hrtime.bigint() - t0) / 1e6 }) + '\n');
