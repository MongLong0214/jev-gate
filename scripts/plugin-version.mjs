// Function Hooks load JavaScript/TypeScript only. Capture the package identity at build time,
// so an already loaded module cannot start reporting a later installation's version.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const target = new URL('mods/router/hooks/version.ts', root);
const source = `// Generated from package.json by scripts/plugin-version.mjs.\nexport const ROUTER_HOOK_VERSION = ${JSON.stringify(version)};\n`;
let previous;
try { previous = readFileSync(target, 'utf8'); } catch { /* A fresh checkout has no generated module. */ }
if (previous !== source) writeFileSync(target, source);
