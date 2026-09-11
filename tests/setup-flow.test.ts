import { describe, expect, it } from 'vitest';
import {
  backFromReview, backFromRole, isFusion, modelRoles, nextAfterArchitecture,
  nextAfterRole, routeConfigured, saveEnabled,
} from '../shared/setupFlow.js';
import { roleGuidance, roleStepTitle, roleModelExamples, EFFICIENT_MODEL_EXAMPLES, POWERFUL_MODEL_EXAMPLES, providerIsConfigured } from '../shared/setup.js';
import { shuntCanEnable, shuntConfigured, shuntEligible, shuntToggle } from '../shared/shunt.js';
import type { ModelRoute } from '../shared/architectures.js';
import type { Provider } from '../shared/types.js';

/** providerConfigured predicate mirroring a connected gateway. */
const configured = (id: string) => id === 'gateway';
const p = (model: string, providerId = 'gateway'): ModelRoute => ({ providerId, model });

function provider(id: string, overrides: Partial<Provider> = {}): Provider {
  return { id, name: id, kind: 'openai', baseUrl: 'http://localhost', ...overrides };
}

describe('modelRoles', () => {
  it('single needs only the base/driver role, never a supporting role', () => {
    expect(modelRoles('single')).toEqual(['driver']);
  });
  it('every fusion arrangement needs a driver plus one supporting role', () => {
    for (const kind of ['sidekick-fusion', 'team-fusion', 'expert-fusion'] as const) {
      expect(modelRoles(kind)).toEqual(['driver', 'worker']);
      expect(isFusion(kind)).toBe(true);
    }
  });
  it('single is not fusion', () => {
    expect(isFusion('single')).toBe(false);
  });
});

describe('sequential transitions (walkthrough)', () => {
  it('choosing an architecture goes to the driver role when a provider is configured', () => {
    expect(nextAfterArchitecture(true)).toBe('driver');
  });
  it('choosing an architecture goes to the gateway when a provider is needed', () => {
    expect(nextAfterArchitecture(false)).toBe('gateway');
  });
  it('a single driver reaches review directly; fusion driver advances to the supporting role', () => {
    expect(nextAfterRole('single', 'driver')).toBe('review');
    expect(nextAfterRole('sidekick-fusion', 'driver')).toBe('worker');
    expect(nextAfterRole('expert-fusion', 'driver')).toBe('worker');
  });
  it('a supporting model always reaches review in the walkthrough', () => {
    for (const kind of ['single', 'sidekick-fusion', 'team-fusion', 'expert-fusion'] as const) {
      expect(nextAfterRole(kind, 'worker')).toBe('review');
    }
  });
  it('Back is sequential within the walkthrough', () => {
    expect(backFromRole('driver')).toBe('architecture');
    expect(backFromRole('worker')).toBe('driver');
  });
});

describe('routeConfigured', () => {
  it('requires a model and a matching configured provider', () => {
    expect(routeConfigured(p('gpt'), configured)).toBe(true);
    expect(routeConfigured(p('', 'gateway'), configured)).toBe(false);
    expect(routeConfigured(p('gpt', 'missing'), configured)).toBe(false);
    expect(routeConfigured(null, configured)).toBe(false);
  });
});

describe('saveEnabled', () => {
  const base = { driver: p('driver'), worker: p('worker'), providerConfigured: configured };
  it('only enables saving from the review step', () => {
    expect(saveEnabled({ ...base, step: 'driver', kind: 'single', shuntOk: true })).toBe(false);
    expect(saveEnabled({ ...base, step: 'review', kind: 'single', shuntOk: true, driver: p('') })).toBe(false);
  });
  it('single can save with a driver alone and no supporting model', () => {
    expect(saveEnabled({ ...base, step: 'review', kind: 'single', shuntOk: true, worker: null })).toBe(true);
  });
  it('fusion requires both driver and supporting model', () => {
    expect(saveEnabled({ ...base, step: 'review', kind: 'sidekick-fusion', shuntOk: true, worker: null })).toBe(false);
    expect(saveEnabled({ ...base, step: 'review', kind: 'team-fusion', shuntOk: true })).toBe(true);
  });
  it('blocks saving while Shunt is enabled but unconfigured', () => {
    expect(saveEnabled({ ...base, step: 'review', kind: 'single', shuntOk: false, worker: null })).toBe(false);
  });
});

describe('role guidance', () => {
  it('names the example model kinds as recommendations for each role', () => {
    expect(POWERFUL_MODEL_EXAMPLES).toBe('Astra, Fable, Sol, Opus');
    expect(EFFICIENT_MODEL_EXAMPLES).toBe('DeepSeek Flash, Muse Spark, Gemini Flash');
    expect(roleModelExamples('single', 'driver')).toContain('Opus');
    expect(roleModelExamples('sidekick-fusion', 'worker')).toContain('Gemini Flash');
    expect(roleModelExamples('expert-fusion', 'worker')).toContain('Opus');
    expect(roleModelExamples('expert-fusion', 'driver')).toContain('DeepSeek Flash');
  });
  it('builds a concise step title and guidance header (job + recommendation + note)', () => {
    expect(roleStepTitle('single', 'driver')).toBe('Choose your base model');
    expect(roleStepTitle('sidekick-fusion', 'driver')).toBe('Choose your driver model');
    expect(roleStepTitle('sidekick-fusion', 'worker')).toBe('Choose your sidekick model');
    expect(roleStepTitle('team-fusion', 'worker')).toBe('Choose your worker model');
    expect(roleStepTitle('expert-fusion', 'worker')).toBe('Choose your expert model');
    const guidance = roleGuidance('sidekick-fusion', 'driver');
    expect(guidance).toContain('plan, delegate, and review');
    expect(guidance).toContain('Recommended: Astra, Fable, Sol, Opus');
    expect(guidance).toContain('Choose an available model from your provider.');
    expect(guidance.split('\n')).toHaveLength(3);
  });
});

describe('providerIsConfigured', () => {
  it('prefers the configured flag (covers codex/OAuth and anthropic) and falls back to baseUrl', () => {
    expect(providerIsConfigured({ configured: true, baseUrl: '' })).toBe(true);
    expect(providerIsConfigured({ configured: false, baseUrl: 'http://x' })).toBe(false);
    expect(providerIsConfigured({ baseUrl: 'http://x' })).toBe(true);
    expect(providerIsConfigured({ baseUrl: '' })).toBe(false);
  });
});

describe('shunt', () => {
  it('only non-codex providers can power Shunt', () => {
    expect(shuntEligible(provider('p', { kind: 'openai', configured: true }))).toBe(true);
    expect(shuntEligible(provider('c', { kind: 'codex', configured: true }))).toBe(false);
    expect(shuntEligible(provider('a', { kind: 'anthropic', configured: true }))).toBe(true);
  });
  it('can enable only when an eligible provider exists, regardless of how many total', () => {
    expect(shuntCanEnable([provider('c', { kind: 'codex', configured: true })])).toBe(false);
    expect(shuntCanEnable([provider('c', { kind: 'codex', configured: true }), provider('p', { kind: 'openai', configured: true })])).toBe(true);
    expect(shuntCanEnable([])).toBe(false);
  });
  it('is configured only when the enabled shunt model is on a valid provider', () => {
    expect(shuntConfigured({ enabled: true, model: p('reader') }, [provider('gateway', { configured: true })])).toBe(true);
    expect(shuntConfigured({ enabled: true, model: { providerId: 'c', model: 'reader' } }, [provider('c', { kind: 'codex', configured: true })])).toBe(false);
    expect(shuntConfigured({ enabled: true, model: { providerId: 'gateway', model: '' } }, [provider('gateway', { configured: true })])).toBe(false);
    expect(shuntConfigured({ enabled: false, model: p('reader') }, [])).toBe(true);
  });
  it('turning off keeps the chosen model; turning on drafts an empty route when none kept — and never navigates (pure)', () => {
    const current = { enabled: false as const, model: p('reader') };
    expect(shuntToggle(current, true)).toEqual({ enabled: true, model: p('reader') });
    const off = shuntToggle({ enabled: true as const, model: p('reader') }, false);
    expect(off).toEqual({ enabled: false, model: p('reader') });
    expect(shuntToggle(off, true)).toEqual({ enabled: true, model: p('reader') });
    const fresh = shuntToggle({ enabled: false }, true);
    expect(fresh.enabled).toBe(true);
    expect(fresh.model?.model).toBe('');
    expect(shuntConfigured(fresh, [provider('gateway', { configured: true })])).toBe(false);
  });
});

