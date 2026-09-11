import type { Model, Settings } from './types.js';
import { ARCHITECTURES, type ArchitectureKind } from './architectures.js';

/** Keep the first-run explanations identical in both clients. */
export const SETUP_ARCHITECTURES = [
  { kind: 'single' as const, name: 'Single model', recommended: false, description: 'One model does everything. The simplest way to start.' },
  { ...ARCHITECTURES[0], recommended: true, description: 'A driver plans and reviews. One sidekick does the work and remembers context.' },
  { ...ARCHITECTURES[1], recommended: false, description: 'A driver splits work among parallel workers. Use a faster, cheaper worker model.' },
  { ...ARCHITECTURES[2], recommended: false, description: 'A lighter driver calls stronger experts for hard tasks, then checks their work.' },
];
export function modelGuidance(kind: 'single' | ArchitectureKind, role: 'driver' | 'worker' | 'planner') {
  if (role === 'planner') return 'A strong reasoning model for planning before implementation.';
  if (kind === 'single') return 'A capable coding model that can plan, implement, and test.';
  if (role === 'driver') return kind === 'expert-fusion'
    ? 'An efficient coding model to coordinate experts and check results.'
    : 'A powerful reasoning model to plan, delegate, and review.';
  return kind === 'expert-fusion'
    ? 'A powerful model for difficult reasoning and implementation.'
    : 'An efficient coding workhorse for implementation and testing.';
}
export const SETUP_PERMISSIONS = 'Ask first lets you review actions. Allow all tools runs without routine approval prompts. Explicit project rules still apply.';

/** Example model names to mention as the KIND of model to look for in each role.
 * These are recommendations/examples for the guided walk-through, never an
 * availability claim and never selectable on their own: the pickers only offer
 * models reachable through a connected provider. */
export const POWERFUL_MODEL_EXAMPLES = 'Astra, Fable, Sol, Opus';
export const EFFICIENT_MODEL_EXAMPLES = 'DeepSeek Flash, Muse Spark, Gemini Flash';
/** Short note appended to a role picker's guidance header. */
export const MODELS_AVAILABILITY_NOTE = 'Choose an available model from your provider.';

/** The example model names to look for in a role, by capability family. */
export function roleModelExamples(kind: 'single' | ArchitectureKind, role: 'driver' | 'worker'): string {
  if (kind === 'single') return POWERFUL_MODEL_EXAMPLES;
  const expert = kind === 'expert-fusion';
  if (role === 'driver') return expert ? EFFICIENT_MODEL_EXAMPLES : POWERFUL_MODEL_EXAMPLES;
  return expert ? POWERFUL_MODEL_EXAMPLES : EFFICIENT_MODEL_EXAMPLES;
}
/** The step title for a model-role picker: base, driver, or the supporting role. */
export function roleStepTitle(kind: 'single' | ArchitectureKind, role: 'driver' | 'worker'): string {
  if (kind === 'single') return 'Choose your base model';
  if (role === 'driver') return 'Choose your driver model';
  const label = kind === 'expert-fusion' ? 'expert' : kind === 'team-fusion' ? 'worker' : 'sidekick';
  return `Choose your ${label} model`;
}
/** Concise guidance header for a model-role picker: job + recommendation + note. */
export function roleGuidance(kind: 'single' | ArchitectureKind, role: 'driver' | 'worker'): string {
  return `${modelGuidance(kind, role)}\nRecommended: ${roleModelExamples(kind, role)}\n${MODELS_AVAILABILITY_NOTE}`;
}

export const GATEWAY_URL_HINT = 'The base URL of your LiteLLM gateway, with or without /v1.';
export const GATEWAY_KEY_HINT = 'Use a LiteLLM virtual key or gateway API key. Leave blank only if your gateway needs no key.';
export interface GatewayConnection { settings: Settings; models: Model[]; providerId: string }
export function setupGateway(settings: Settings, providerId: string) {
  const provider = settings.providers.find(p => p.id === providerId && p.kind === 'openai') ?? settings.providers.find(p => p.id === 'litellm' && p.kind === 'openai') ?? settings.providers.find(p => p.id === settings.defaultProvider && p.kind === 'openai');
  let id = 'litellm';
  for (let n = 2; settings.providers.some(p => p.id === id); n++) id = `litellm-${n}`;
  return { providerId: provider?.id ?? id, baseUrl: provider?.baseUrl ?? '', existing: Boolean(provider) };
}
export function gatewayBaseUrl(value: string): string {
  const base = value.trim();
  let url: URL;
  try { url = new URL(base); } catch { throw new Error('Enter your gateway base URL, starting with https:// or http://.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP or HTTPS base URL without credentials, query parameters, or fragments.');
  return base;
}

export function needsSetup(settings: Settings, route: {providerId: string; model: string}) {
  return !route.model.trim() || !settings.providers.some(provider => provider.id === route.providerId && providerIsConfigured(provider));
}
/** API gateways may intentionally have no key. The public configured flag
 * describes credentials, not connectivity; only OAuth requires that flag. */
export function providerIsConfigured(provider: { kind: string; configured?: boolean; baseUrl: string }): boolean {
  return provider.kind === 'codex' ? provider.configured === true : Boolean(provider.baseUrl);
}
