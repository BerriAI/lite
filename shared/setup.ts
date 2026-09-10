import type { Model, Settings } from './types.js';
import { ARCHITECTURES } from './architectures.js';

/** Keep the first-run explanations identical in both clients. */
export const SETUP_ARCHITECTURES = [
  { kind: 'single' as const, name: 'Single model', description: 'One model does everything. The simplest way to start.' },
  { ...ARCHITECTURES[0], description: 'A driver plans and reviews. One sidekick does the work and remembers context.' },
  { ...ARCHITECTURES[1], description: 'A driver splits work among parallel workers. Use a faster, cheaper worker model.' },
  { ...ARCHITECTURES[2], description: 'A lighter driver calls stronger experts for hard tasks, then checks their work.' },
];
export const SETUP_PERMISSIONS = 'Ask first lets you review actions. Allow all tools runs without routine approval prompts. Explicit project rules still apply.';

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
  return !route.model.trim() || !settings.providers.some(provider => provider.id === route.providerId && provider.baseUrl);
}
