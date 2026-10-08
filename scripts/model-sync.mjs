import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { build } from 'esbuild';

// Public metadata only. This does not probe inference or claim account entitlement.
export const SOURCES = {
  overview: 'https://platform.claude.com/docs/en/models/overview.md',
  effort: 'https://platform.claude.com/docs/en/build-with-claude/effort.md',
  releases: 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md',
  codex: 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json',
  caching: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md',
  sol: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol.md',
  luna: 'https://developers.openai.com/api/docs/models/gpt-6-luna.md',
  astra: 'https://developers.openai.com/api/docs/models/gpt-6-astra.md',
};
const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const requireFact = (condition, message) => { if (!condition) throw new Error(message); };
const cells = line => line.trim().slice(1, -1).split('|').map(c => c.trim());
const unquote = value => value.replace(/`/g, '').trim();
const tokens = value => {
  const match = /^(\d+(?:\.\d+)?)([KM]) tokens$/.exec(value);
  requireFact(match, `Unknown token capacity: ${value}`);
  const count = Number(match[1]) * (match[2] === 'M' ? 1_000_000 : 1_000);
  requireFact(Number.isSafeInteger(count) && count > 0, `Invalid token capacity: ${value}`);
  return count;
};

export function parseClaude(overview, effort) {
  const lines = overview.split('\n');
  const headers = lines.flatMap((line, index) => /^\| Feature\s*\|/.test(line) ? [index] : []);
  requireFact(headers.length === 1, 'Missing or ambiguous current Claude model table');
  const header = cells(lines[headers[0]]);
  requireFact(header.length === FAMILIES.length + 1, 'Claude family set changed; review the routing policy');
  const following = lines.slice(headers[0] + 1);
  const end = following.findIndex(line => !line.trim().startsWith('|'));
  const rows = end < 0 ? following : following.slice(0, end);
  const field = label => {
    const matches = rows.map(cells).filter(row => row[0] === label || row[0]?.startsWith(`[${label}](`));
    requireFact(matches.length === 1 && matches[0].length === header.length, `Missing or ambiguous Claude ${label}`);
    return matches[0].slice(1).map(unquote);
  };
  const ids = field('Claude API ID'), windows = field('Context window'), outputs = field('Max output');
  const defaults = field('Default effort'), thinking = field('Thinking'), roles = field('Description'), bedrock = field('Amazon Bedrock ID');
  const seen = new Set();
  const result = ids.map((id, i) => {
    const identity = /^claude-(fable|opus|sonnet|haiku)-(\d+(?:-\d+)*)$/.exec(id);
    requireFact(identity, `Unknown current Claude ID: ${id}`);
    const family = identity[1], version = identity[2].replaceAll('-', '.');
    requireFact(header[i + 1] === `Claude ${family[0].toUpperCase() + family.slice(1)} ${version}` && !seen.has(family), 'Claude header/ID mismatch');
    seen.add(family);
    const title = `### Recommended effort levels for ${header[i + 1]}`;
    const sections = effort.split(title + '\n');
    requireFact(sections.length === 2, `Missing or ambiguous effort section: ${id}`);
    const section = sections[1].split(/\n#{2,3} /)[0];
    requireFact(/supports all five effort levels/.test(section), `Unrecognized effort support: ${id}`);
    requireFact(EFFORTS.includes(defaults[i]) && new RegExp('`' + defaults[i] + '`(?:\\*\\*)?[,]? (?:(?:is )?the )?default').test(section), `Effort default disagreement: ${id}`);
    let unconditionalEffort, conditionalEffort;
    if (thinking[i] === 'Adaptive (always on)') {
      unconditionalEffort = [...EFFORTS]; conditionalEffort = [];
    } else {
      requireFact(thinking[i] === 'Adaptive' && /(?:between_tools|disabled)/.test(section) &&
        /At `xhigh` or `max`,[\s\S]*?400 error/.test(section) &&
        /(?:`low`, `medium`, and `high`|`high` effort or below)/.test(section), `Unknown thinking/effort restrictions: ${id}`);
      unconditionalEffort = EFFORTS.slice(0, 3); conditionalEffort = EFFORTS.slice(3);
    }
    requireFact(roles[i]?.length > 10 && roles[i].length < 500 && bedrock[i] === `anthropic.${id}`, `Unknown Claude role/provider identity: ${id}`);
    return { ids: [id, bedrock[i]], suffixes: [], family, contextTokens: tokens(windows[i]), maxOutputTokens: tokens(outputs[i]),
      role: roles[i], defaultEffort: defaults[i], unconditionalEffort, conditionalEffort };
  });
  requireFact(FAMILIES.every(f => seen.has(f)), 'Incomplete current Claude families');
  return result;
}

export function hostRelease(changelog, model) {
  const [, family, rawVersion] = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/.exec(model) ?? [];
  requireFact(family && rawVersion, 'Unrecognized Claude identity');
  const display = new RegExp(`${family}[- ]${rawVersion.replaceAll('-', '[.-]')}(?![\\d.])`, 'i');
  const matches = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)]
    .filter(m => m[2].split('\n').some(line => display.test(line) && /add|introduc|support/i.test(line)));
  requireFact(matches.length > 0, `No verified native host introduction for ${model}`);
  const releases = matches.map(m => {
    requireFact(/^2\.1\.\d+$/.test(m[1]), `New Claude host version scheme for ${model}; review required`);
    return Number(m[1].split('.')[2]);
  });
  return Math.min(...releases);
}

export function synchronizeClaude(existing, official, changelog) {
  requireFact(FAMILIES.every(f => existing.filter(m => m.family === f && !m.legacy).length === 1), 'Ambiguous installed Claude current families');
  const result = existing.map(m => ({ ...m }));
  for (const facts of official) {
    const index = result.findIndex(m => m.ids.includes(facts.ids[0]));
    if (index >= 0) {
      requireFact(!result[index].legacy, `Official table points back to a retired Claude model: ${facts.ids[0]}`);
      result[index] = { ...result[index], ...facts, suffixes: result[index].suffixes };
    } else {
      const previous = result.find(m => m.family === facts.family && !m.legacy);
      const version = id => id.split('-').slice(2).map(Number);
      const old = version(previous.ids[0]), next = version(facts.ids[0]);
      requireFact(next.some((v, i) => v > (old[i] ?? 0) && next.slice(0, i).every((n, j) => n === old[j])), 'Claude version regression or unknown lineage');
      previous.legacy = true;
      result.push({ ...facts, minimumHostRelease: hostRelease(changelog, facts.ids[0]) });
    }
  }
  return result;
}

export function parseCodex(value) {
  requireFact(value && Array.isArray(value.models) && value.models.length > 0, 'Empty or invalid official Codex catalog');
  const ids = new Set();
  return value.models.map(m => {
    requireFact(typeof m.slug === 'string' && !ids.has(m.slug) && typeof m.description === 'string' &&
      ['list', 'hide', 'hidden'].includes(m.visibility) && Array.isArray(m.supported_reasoning_levels) &&
      m.supported_reasoning_levels.length > 0 && typeof m.default_reasoning_level === 'string' &&
      m.supported_reasoning_levels.every(e => typeof e.effort === 'string') &&
      new Set(m.supported_reasoning_levels.map(e => e.effort)).size === m.supported_reasoning_levels.length &&
      m.supported_reasoning_levels.some(e => e.effort === m.default_reasoning_level) &&
      Array.isArray(m.input_modalities) && m.input_modalities.every(x => typeof x === 'string'), 'Invalid official Codex model capability');
    ids.add(m.slug);
    return { model: m.slug, description: m.description, hidden: m.visibility !== 'list', inputModalities: m.input_modalities,
      defaultReasoningEffort: m.default_reasoning_level, supportedReasoningEfforts: m.supported_reasoning_levels.map(e => ({ reasoningEffort: e.effort })) };
  });
}

export function verifyCodex(catalog, { normalizeCatalog, generalCodexModel, codexCandidates, catalogTierModels }) {
  const normalized = normalizeCatalog(catalog, true);
  requireFact(normalized.models.length === catalog.length && Object.keys(normalized.excluded).length === 0, 'Production rejects official Codex catalog');
  const eligible = catalog.filter(generalCodexModel);
  requireFact(eligible.length >= 2, 'No usable current Codex routing catalog');
  const candidates = codexCandidates(catalog, true);
  requireFact(candidates.length === eligible.length && eligible.every(m => {
    const candidate = candidates.find(c => c.id === m.model);
    return candidate && JSON.stringify([...candidate.efforts].sort()) === JSON.stringify(m.supportedReasoningEfforts.map(e => e.reasoningEffort).sort()) && candidate.rank !== undefined;
  }), 'Codex model role or effort support changed; production policy needs an update');
  const baseline = eligible.find(m => /latest.*workhorse/i.test(m.description))?.model;
  requireFact(baseline, 'Official Codex workhorse changed; review required');
  const tiers = catalogTierModels(baseline, catalog);
  requireFact(Object.values(tiers).every(id => eligible.some(m => m.model === id)) &&
    candidates.find(c => c.id === tiers.fast)?.rank === 0 && candidates.find(c => c.id === tiers.deep)?.rank === 2 &&
    candidates.find(c => c.id === tiers.frontier)?.rank === 3, 'Codex tier defaults lost the current fast/workhorse/frontier roles');
  // A previous-generation root remains a readable native baseline, but never becomes a new target/default.
  requireFact(catalog.filter(m => /\b(?:older|previous generation|legacy)\b/i.test(m.description)).every(m => !candidates.some(c => c.id === m.model)), 'Legacy Codex model offered as an automatic target');
  return tiers;
}

export async function fetchSource(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { accept: 'text/plain, application/json' } });
  requireFact(response.ok, `Official model metadata HTTP ${response.status}: ${url}`);
  const reader = response.body?.getReader(); requireFact(reader, `Missing metadata body: ${url}`);
  let size = 0; const parts = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length;
      requireFact(size <= 2_000_000, `Oversized official model metadata: ${url}`); parts.push(value); }
  } finally { await reader.cancel(); }
  requireFact(size > 0, `Empty official model metadata: ${url}`);
  return Buffer.concat(parts).toString('utf8');
}

export function replaceFacts(source, facts) {
  const file = ts.createSourceFile('claude-models.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = file.statements.filter(ts.isVariableStatement).flatMap(s => [...s.declarationList.declarations])
    .filter(d => ts.isIdentifier(d.name) && d.name.text === 'MODEL_FACTS');
  requireFact(declarations.length === 1 && declarations[0].initializer && ts.isArrayLiteralExpression(declarations[0].initializer), 'Cannot locate the single production Claude fact table');
  const node = declarations[0].initializer;
  const value = v => Array.isArray(v) ? '[' + v.map(x => JSON.stringify(x)).join(', ') + ']' : JSON.stringify(v);
  const literal = '[\n' + facts.map(f => `  { ${Object.entries(f).map(([key, v]) => `${key}: ${value(v)}`).join(', ')} },`).join('\n') + '\n]';
  return source.slice(0, node.getStart(file)) + literal + source.slice(node.end);
}

export function priceMetadata(raw, official) {
  const result = [];
  const add = (host, model, source, bands) => result.push({ host, model, source,
    revision: createHash('sha256').update(JSON.stringify(bands)).digest('hex').slice(0, 16), bands });
  for (const model of official) {
    const [, family, ...version] = model.ids[0].split('-');
    const name = `Claude ${family[0].toUpperCase() + family.slice(1)} ${version.join('.')}`;
    const lines = raw.caching.split('\n').filter(l => l.startsWith('| ' + name + ' ') && l.includes('$'));
    requireFact(lines.length > 0, `Missing official cache pricing: ${name}`);
    const bands = lines.map(line => {
      const values = [...line.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => Number(m[1]));
      requireFact(values.length === 5 && values.every(v => Number.isFinite(v) && v >= 0), `Ambiguous cache rates: ${name}`);
      const bound = /up to ([\d,]+) tokens/.exec(line);
      requireFact(!/prompts/.test(line) || bound || /over [\d,]+ tokens/.test(line), `Unknown long-context band: ${name}`);
      return { maxPrompt: bound ? Number(bound[1].replaceAll(',', '')) : model.contextTokens,
        input: values[0], write5m: values[1], write1h: values[2], read: values[3], output: values[4] };
    }).sort((a, b) => a.maxPrompt - b.maxPrompt);
    add('claude', model.ids[0], SOURCES.caching.replace(/\.md$/, ''), bands);
  }
  for (const key of ['sol', 'luna', 'astra']) {
    const text = raw[key];
    const model = /Model ID: `([^`]+)`/.exec(text)?.[1];
    const value = name => Number(new RegExp('^\\| ' + name + ' \\| \\$(\\d+(?:\\.\\d+)?) \\| 1M tokens \\|$', 'm').exec(text)?.[1]);
    const context = /Maximum input tokens: ([\d,]+)/.exec(text)?.[1];
    const base = { input: value('Input'), read: value('Cached input'), write: value('Cache writes'), output: value('Output') };
    requireFact(model && context && Object.values(base).every(v => Number.isFinite(v) && v >= 0), `Unknown OpenAI price contract: ${key}`);
    const limit = Number(context.replaceAll(',', ''));
    const long = /Prompts with more than (\d+)K input tokens are priced at 2x input and cache rates and 1\.5x output/.exec(text);
    const bands = long ? [{ ...base, maxPrompt: Number(long[1]) * 1000 }, { maxPrompt: limit, input: base.input * 2, read: base.read * 2, write: base.write * 2, output: base.output * 1.5 }] : [{ ...base, maxPrompt: limit }];
    add('codex', model, SOURCES[key].replace(/\.md$/, ''), bands);
  }
  return result;
}

export async function run(mode, root = resolve(import.meta.dirname, '..')) {
  requireFact(['--check', '--write'].includes(mode), 'Usage: node scripts/model-sync.mjs --check|--write');
  const entries = await Promise.all(Object.entries(SOURCES).map(async ([key, url]) => [key, await fetchSource(url)]));
  const raw = Object.fromEntries(entries);
  const official = parseClaude(raw.overview, raw.effort);
  // Run the production selectors against upstream metadata, without maintaining a second Codex model registry.
  const compiled = await build({ stdin: { contents: 'export { MODEL_FACTS } from "./src/claude-models.ts"; export { normalizeCatalog, generalCodexModel } from "./src/codex/catalog.ts"; export { codexCandidates } from "./src/codex/router.ts"; export { catalogTierModels } from "./src/codex/config.ts";', resolveDir: root, loader: 'js' },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const facts = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].contents).toString('base64'));
  const codex = verifyCodex(parseCodex(JSON.parse(raw.codex)), facts);
  const next = synchronizeClaude(facts.MODEL_FACTS, official, raw.releases);
  const prices = priceMetadata(raw, official);
  for (const model of new Set(Object.values(codex))) requireFact(prices.some(p => p.host === 'codex' && p.model === model), `Current Codex model has no verified price source: ${model}`);
  const pricesPath = resolve(root, 'src/provider-prices-data.ts');
  const priceContent = '// Generated from official provider metadata by scripts/model-sync.mjs.\nexport default ' + JSON.stringify(prices, null, 2) + ';\n';
  const priceChanged = await readFile(pricesPath, 'utf8') !== priceContent;
  const changed = JSON.stringify(next) !== JSON.stringify(facts.MODEL_FACTS);
  if (priceChanged && mode === '--write') await writeFile(pricesPath, priceContent);
  if (changed && mode === '--write') {
    const path = resolve(root, 'src/claude-models.ts');
    const source = await readFile(path, 'utf8');
    await writeFile(path, replaceFacts(source, next).replace(/read \d{4}-\d{2}-\d{2}\./, `read ${new Date().toISOString().slice(0, 10)}.`));
  }
  console.log(JSON.stringify({ changed, priceChanged, claude: official.map(m => ({ model: m.ids[0], default: m.defaultEffort, efforts: m.unconditionalEffort, conditional: m.conditionalEffort })), codex, sources: SOURCES }, null, 2));
  requireFact(mode !== '--check' || !changed && !priceChanged, 'Model or price metadata is stale. Run npm run models:update, rebuild, and review the diff.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.length === 3 ? process.argv[2] : undefined).catch(error => { console.error(error.message); process.exitCode = 1; });
}
