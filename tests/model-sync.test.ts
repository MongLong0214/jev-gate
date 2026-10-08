// @ts-expect-error The maintenance CLI is an ESM script, exercised here without network requests.
import { parseClaude, hostRelease, synchronizeClaude, parseCodex, verifyCodex, fetchSource, replaceFacts } from '../scripts/model-sync.mjs';
import { describe, expect, it } from 'vitest';
import { MODEL_FACTS, type ModelFacts } from '../src/claude-models.js';
import { normalizeCatalog, generalCodexModel } from '../src/codex/catalog.js';
import { catalogTierModels } from '../src/codex/config.js';
import { codexCandidates } from '../src/codex/router.js';

// Minimal synthetic publisher documents: no live API, credential or copied documentation snapshot.
const names = ['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'];
const ids = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const defaults = ['high', 'medium', 'high', 'medium'];
const row = (label: string, values: string[]) => `| ${label} | ${values.join(' | ')} |`;
const overview = [row('Feature', names.map(n => `Claude ${n}`)), row('---', names.map(() => '---')),
  row('Description', names.map(() => 'A current general-purpose model')),
  row('Claude API ID', ids.map(id => '`' + id + '`')),
  row('Amazon Bedrock ID', ids.map(id => '`anthropic.' + id + '`')),
  row('Thinking', ['Adaptive (always on)', 'Adaptive (always on)', 'Adaptive', 'Adaptive']),
  row('[Default effort](https://example.test/effort)', defaults.map(d => '`' + d + '`')),
  row('[Context window](https://example.test/context)', names.map(() => '1M tokens')),
  row('Max output', names.map(() => '128K tokens')), '', 'Other publisher text'].join('\n');
const effort = names.map((name, i) => `### Recommended effort levels for Claude ${name}\n\nThis model supports all five effort levels, and \`${defaults[i]}\` is the default.\n` +
  (i < 2 ? '' : 'The disabled mode accepts `high` effort or below. At `xhigh` or `max`, it returns a 400 error.\n')).join('\n');
const policy = { normalizeCatalog, generalCodexModel, catalogTierModels, codexCandidates };
const rawCodex = {
  models: [
    { slug: 'gpt-6.1-sol', description: 'Latest workhorse model for coding and everyday work.', visibility: 'list' },
    { slug: 'gpt-6-luna', description: 'Fast and affordable model for easier tasks.', visibility: 'list' },
    { slug: 'gpt-6-astra', description: 'Frontier intelligence for the most demanding work.', visibility: 'list' },
    // Deliberately precedes no successor ordering contract: old versions must not get picked by description/rank.
    { slug: 'gpt-5.6-luna', description: 'Older fast model for easier tasks.', visibility: 'list' },
    { slug: 'hidden', description: 'Fast model', visibility: 'hide' },
  ].map(m => ({ ...m, input_modalities: ['text'], default_reasoning_level: 'medium', supported_reasoning_levels:
    ['low', 'medium', 'high', 'xhigh', 'max', ...(m.slug === 'gpt-6-luna' ? [] : ['ultra'])].map(effort => ({ effort })) })),
};

describe('official model freshness CI', () => {
  it('keeps unconditional effort separate from thinking-dependent levels and the published default', () => {
    const models: ModelFacts[] = parseClaude(overview, effort);
    expect(models.find(m => m.family === 'haiku')).toMatchObject({ ids: ['claude-haiku-5-5', 'anthropic.claude-haiku-5-5'],
      contextTokens: 1_000_000, maxOutputTokens: 128_000, defaultEffort: 'medium', unconditionalEffort: ['low', 'medium', 'high'], conditionalEffort: ['xhigh', 'max'] });
    expect(models.find(m => m.family === 'opus')?.unconditionalEffort).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
  it.each([
    ['missing family', overview.replace(' | Claude Haiku 5.5', '')],
    ['duplicate table', overview + '\n' + overview],
    ['ID/header conflict', overview.replace('`claude-haiku-5-5`', '`claude-haiku-5-6`')],
    ['missing output', overview.replace(/\| Max output[^\n]*\n/, '')],
    ['unknown units', overview.replace('128K tokens', 'unlimited')],
    ['changed thinking', overview.replace('Adaptive (always on)', 'Unknown mode')],
  ])('fails closed on %s instead of silently producing an empty/current table', (_, document) => {
    expect(() => parseClaude(document, effort)).toThrow();
  });
  it('rejects a default mismatch and new effort semantics', () => {
    expect(() => parseClaude(overview, effort.replace('`medium` is the default', '`high` is the default'))).toThrow(/default disagreement/);
    expect(() => parseClaude(overview, effort.replace('all five effort', 'all six effort'))).toThrow(/effort support/);
    expect(() => parseClaude(overview, effort.replaceAll('400 error', 'valid request'))).toThrow(/restrictions/);
  });
  it('accepts a complete table at EOF but rejects zero or overflowing capacities', () => {
    expect(parseClaude(overview.split('\n\n')[0], effort)).toHaveLength(4);
    expect(() => parseClaude(overview.replace('1M tokens', '0M tokens'), effort)).toThrow(/Invalid token/);
    expect(() => parseClaude(overview.replace('1M tokens', '999999999999999999M tokens'), effort)).toThrow(/Invalid token/);
  });
  it('retires a superseded model, preserves historical facts and requires a verified host release', () => {
    const official: ModelFacts[] = parseClaude(overview, effort);
    const newer = official.map(m => m.family === 'haiku' ? { ...m, ids: ['claude-haiku-5-6', 'anthropic.claude-haiku-5-6'] } : m);
    const changelog = '## 2.1.300\n\n- Added Haiku 5.6 support.\n\n## 2.1.293\n\n- Added Haiku 5.5.\n';
    const updated: ModelFacts[] = synchronizeClaude(MODEL_FACTS, newer, changelog);
    expect(updated.find(m => m.ids[0] === 'claude-haiku-5-5')?.legacy).toBe(true);
    expect(updated.find(m => m.ids[0] === 'claude-haiku-5-6')).toMatchObject({ minimumHostRelease: 300, family: 'haiku' });
    expect(updated.find(m => m.ids[0] === 'claude-haiku-4-5-20251001')).toEqual(MODEL_FACTS.find(m => m.ids[0] === 'claude-haiku-4-5-20251001'));
    expect(() => synchronizeClaude(MODEL_FACTS, newer, '')).toThrow(/host introduction/);
    expect(() => hostRelease('## 3.0.1\n- Added Haiku 5.6 support.\n', 'claude-haiku-5-6')).toThrow(/version scheme/);
  });
  it('does not revert an automatic family to a historical model when a source is stale', () => {
    const official: ModelFacts[] = parseClaude(overview, effort);
    expect(() => synchronizeClaude(MODEL_FACTS, official.map(m => m.family === 'haiku' ? { ...m, ids: ['claude-haiku-4-5'] } : m), '')).toThrow(/retired/);
  });
  it('updates the production table alone, retains suffixes and is stable on a second sync', () => {
    const official: ModelFacts[] = parseClaude(overview, effort);
    const next = synchronizeClaude(MODEL_FACTS, official, '');
    expect(next.find((m: ModelFacts) => m.family === 'sonnet' && !m.legacy).suffixes).toEqual(['[1m]']);
    expect(synchronizeClaude(next, official, '')).toEqual(next);
    const source = 'const unrelated = "keep me";\nexport const MODEL_FACTS: readonly ModelFacts[] = [];\n// keep this too\n';
    const result = replaceFacts(source, next);
    expect(result.startsWith('const unrelated = "keep me";\n')).toBe(true);
    expect(result.endsWith(';\n// keep this too\n')).toBe(true);
    expect(replaceFacts(result, next)).toBe(result);
    expect(() => replaceFacts('const other = [];', next)).toThrow(/single production/);
  });
  it('checks real Codex selectors: current fast defaults, legacy exclusion and per-model efforts', () => {
    const catalog = parseCodex(rawCodex);
    expect(verifyCodex(catalog, policy)).toEqual({ fast: 'gpt-6-luna', standard: 'gpt-6.1-sol', deep: 'gpt-6.1-sol', frontier: 'gpt-6-astra' });
    expect(codexCandidates(catalog, false).find(m => m.id === 'gpt-6-luna')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(codexCandidates(catalog, true).some(m => m.id === 'gpt-5.6-luna')).toBe(false);
    expect(catalogTierModels('gpt-5.6-luna', catalog).fast).toBe('gpt-6-luna');
  });
  it('does not mistake folders in a current model description for an older model', () => {
    const catalog = parseCodex(rawCodex).map((m: { model: string }) => m.model === 'gpt-6.1-sol' ? { ...m, description: 'Latest workhorse model for coding across folders.' } : m);
    expect(verifyCodex(catalog, policy).deep).toBe('gpt-6.1-sol');
  });
  it('fails on changed Codex effort support or an unclassified new general model', () => {
    const catalog = parseCodex(rawCodex);
    expect(() => verifyCodex([...catalog, { ...catalog[0], model: 'new-general', description: 'New unclassified capabilities' }], policy)).toThrow(/role or effort/);
    expect(() => verifyCodex(catalog.map((m: typeof catalog[number]) => m.model === 'gpt-6-luna' ? { ...m, supportedReasoningEfforts: [...m.supportedReasoningEfforts, { reasoningEffort: 'newlevel' }] } : m), policy)).toThrow(/role or effort/);
    expect(() => parseCodex({ models: [] })).toThrow();
    expect(() => parseCodex({ models: [rawCodex.models[0], rawCodex.models[0]] })).toThrow();
  });
  it('treats HTTP errors, empty bodies and oversized metadata as failures', async () => {
    await expect(fetchSource('https://example.test', async () => new Response('no', { status: 503 }))).rejects.toThrow(/HTTP 503/);
    await expect(fetchSource('https://example.test', async () => new Response(''))).rejects.toThrow(/Empty/);
    await expect(fetchSource('https://example.test', async () => new Response('x'.repeat(2_000_001)))).rejects.toThrow(/Oversized/);
    await expect(fetchSource('https://example.test', async () => new Response('valid metadata'))).resolves.toBe('valid metadata');
  });
});
