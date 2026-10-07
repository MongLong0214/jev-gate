import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, validateConfig, loadConfig } from '../src/config.js';
import { frontierRoutingEnabled } from '../src/frontier-config.js';
import { claudeAllocation } from '../src/claude-allocation.js';
import { loadCodexPolicy } from '../src/codex/config.js';
import { codexCandidates } from '../src/codex/router.js';
import { claudeCandidates } from '../src/claude-candidates.js';
import { offerPairs, selectPair } from '../src/router-selection.js';
import { choice } from './router/fake-engine.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const fixture = () => {
  const root = mkdtempSync('/tmp/jev-frontier-config-'); roots.push(root);
  const dir = join(root, '.config', 'jev-gate'); mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json'); const env = { HOME: root };
  return { env, path, write: (frontierEnabled: unknown) => writeFileSync(path, JSON.stringify({ version: 5, frontierEnabled })) };
};
const catalog = [
  { model: 'gpt-6.1-sol', description: 'Latest workhorse model for coding and everyday work.', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })) },
  { model: 'gpt-6-astra', description: 'Frontier intelligence for the most demanding work.', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'].map(reasoningEffort => ({ reasoningEffort })) },
];

describe('shared frontier routing opt-in', () => {
  it('offers Luna, Terra and Sol by default, and Astra only with the common opt-in', () => {
    const all=[['gpt-6-luna','Fast and affordable model for easier tasks.'],['gpt-6-terra','Model for standard coding work.'],['gpt-6.1-sol','Latest workhorse model for coding and everyday work.'],['gpt-6-astra','Frontier intelligence for the most demanding work.']].map(([model,description])=>({model:model!,description:description!,supportedReasoningEfforts:[{reasoningEffort:'high'}]}));
    expect(codexCandidates(all,false).map(c=>c.id)).toEqual(['gpt-6-luna','gpt-6-terra','gpt-6.1-sol']);
    expect(codexCandidates(all,true).map(c=>c.id)).toEqual(all.map(m=>m.model));
  });
  it('does not disable Gate when the user adds only a shared frontier setting', () => {
    const f=fixture();f.write(true);
    expect(loadConfig(f.env,undefined,'auto')).toMatchObject({ok:true,config:{mode:'auto',frontierEnabled:true}});
    expect(loadConfig(f.env)).toMatchObject({ok:true,config:{mode:'off'}});
    writeFileSync(f.path,JSON.stringify({version:5,mode:'off',frontierEnabled:true}));
    expect(loadConfig(f.env,undefined,'auto')).toMatchObject({ok:true,config:{mode:'off'}});
  });
  it('defaults OFF without requiring a config file', () => {
    const f = fixture();
    expect(DEFAULT_CONFIG.frontierEnabled).toBe(false);
    expect(frontierRoutingEnabled(f.env)).toBe(false);
    expect(loadCodexPolicy(f.env, catalog).router.allowAstra).toBe(false);
    expect(claudeAllocation(f.env).allowed('claude-fable-5-1')).toBe(false);
    expect(validateConfig({ version: 5, frontierEnabled: 'on' })).toMatchObject({ ok: false });
  });
  it('changes both hosts and owned dispatches with one file, including OFF over legacy opt-ins', () => {
    const f = fixture(); const codex = join(f.env.HOME, 'codex.json');
    writeFileSync(codex, JSON.stringify({ router: { allowAstra: true } }));
    const env = { ...f.env, JEV_CODEX_CONFIG: codex, CLAUDE_PLUGIN_OPTION_ROUTERALLOWFABLE: 'true' };
    for (const value of [false, true, false]) {
      f.write(value);
      expect(frontierRoutingEnabled(env, true)).toBe(value);
      expect(loadCodexPolicy(env, catalog).router.allowAstra).toBe(value);
      expect(claudeAllocation(env).allowed('claude-fable-5-1')).toBe(value);
      expect(claudeAllocation(env).candidates('claude-opus-5-5').some(c => c.id === 'claude-fable-5-1')).toBe(value);
      expect(validateConfig({ version: 5, frontierEnabled: value })).toMatchObject({ ok: true, config: { frontierEnabled: value } });
    }
  });
  it.each(['true', 1, null, {}])('does not authorize frontier targets from invalid config values: %j', value => {
    const f = fixture(); f.write(value);
    expect(frontierRoutingEnabled(f.env, true)).toBe(false);
    expect(loadCodexPolicy(f.env, catalog).router.allowAstra).toBe(false);
    expect(claudeAllocation(f.env).allowed('claude-fable-5-1')).toBe(false);
  });
  it('rejects malformed and symlinked config and honors the same custom path for both hosts', () => {
    const f = fixture(); writeFileSync(f.path, '{'); expect(frontierRoutingEnabled(f.env, true)).toBe(false);
    const override = join(f.env.HOME, 'owner-config.json'); writeFileSync(override, JSON.stringify({ version: 5, frontierEnabled: true }));
    const env = { ...f.env, JEV_GATE_CONFIG: override };
    expect(loadCodexPolicy(env, catalog).router.allowAstra).toBe(true);
    expect(claudeAllocation(env).allowed('claude-fable-5-1')).toBe(true);
    rmSync(f.path); symlinkSync(override, f.path); expect(frontierRoutingEnabled(f.env, true)).toBe(false);
  });
  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('selects frontier models at their own supported effort: %s', effort => {
    const f = fixture(); f.write(true);
    for (const [baseline, target, candidates] of [
      ['claude-opus-5-5', 'claude-fable-5-1', claudeCandidates({ baseline: 'claude-opus-5-5', aliases: {}, allowFable: frontierRoutingEnabled(f.env) })],
      ['gpt-6.1-sol', 'gpt-6-astra', codexCandidates(catalog, loadCodexPolicy(f.env, catalog).router.allowAstra)],
    ] as const) {
      const offer = offerPairs({ baseline: { model: baseline, effort: 'high' }, candidates, model: true, effort: true, upgrade: .8, downgrade: .6 })!;
      const targetQuestion = offer.effortQuestions.get(target)!;
      const answers = Object.fromEntries(Object.entries(offer.questions).map(([name, question]) => [name,
        question.type === 'choice' ? choice(Object.keys(question.criteria), [name === 'model' ? target : name === 'control' ? 'task_clear' : 'ordinary', .99])
          : { type: 'score', probabilities: Object.fromEntries(question.criteria.map((_, i) => [i, i === (name === targetQuestion.name ? targetQuestion.values.indexOf(effort) : 0) ? 1 : 0])) },
      ]));
      expect({ effort: 'high', ...selectPair(offer, answers).patch }).toMatchObject({ model: target, effort });
    }
  });
});
