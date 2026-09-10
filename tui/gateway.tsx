/** @jsxImportSource @opentui/react */
import { useRef, useState } from 'react';
import { gatewayBaseUrl, setupGateway, type GatewayConnection } from '../shared/setup.js';
import type { Settings } from '../shared/types.js';
import type { TerminalController } from './controller.js';
import { Menu, TextPrompt } from './ui.js';
import { SecretPrompt } from './secrets.js';

export function GatewaySetup({ controller, settings, providerId, onConnected, onProviders, onContinue, onClose }: { controller: TerminalController; settings: Settings; providerId: string; onConnected: (result: GatewayConnection) => void; onProviders: () => void; onContinue: (providerId: string) => void; onClose: () => void }) {
  const [gateway] = useState(() => setupGateway(settings, providerId));
  const [baseUrl, setBaseUrl] = useState(gateway.baseUrl), [view, setView] = useState('main');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [keySet, setKeySet] = useState(false);
  const apiKey = useRef(''), pending = useRef(false);
  const back = () => { if (!pending.current) setView('main'); };
  async function connect() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setView('main');
    try {
      const result = await controller.client.api<GatewayConnection>('/providers/connect', { providerId: gateway.providerId, baseUrl: gatewayBaseUrl(baseUrl), ...(apiKey.current ? {apiKey: apiKey.current} : {}) });
      await controller.settings(); apiKey.current = ''; onConnected(result);
    } catch (error) { setError((error as Error).message); } finally { pending.current = false; setBusy(false); }
  }
  if (view === 'url') return <TextPrompt title="Gateway base URL" value={baseUrl} placeholder="https://your-gateway.example.com" error={error} onClose={back} onSave={value => {
    try { setBaseUrl(gatewayBaseUrl(value)); setError(''); setView('key'); } catch (error) { setError((error as Error).message); }
  }} />;
  if (view === 'key') return <SecretPrompt title="LiteLLM API key" description="Use a virtual key or gateway API key. Leave blank to keep the saved key for this URL, or connect without a key." submitLabel="Connect & continue" onClose={back} onSave={value => { apiKey.current = value.trim(); setKeySet(Boolean(apiKey.current)); void connect(); }} />;
  const alternatives = settings.providers.filter(provider => provider.kind !== 'openai');
  return <Menu title="Connect your LiteLLM gateway · 1 of 3" search={false} onClose={() => { if (!busy) onClose(); }} footer={error || 'Enter your gateway URL and key. Connect to load its available models.'} items={[
    { id: 'url', label: `Gateway base URL: ${baseUrl || 'Enter your URL'}`, description: 'Your LiteLLM gateway, with or without /v1', disabled: busy, action: () => setView('url') },
    { id: 'key', label: `API key: ${keySet ? 'Entered' : gateway.existing && baseUrl === gateway.baseUrl ? 'Use saved key' : 'Enter your key'}`, description: 'A LiteLLM virtual key or gateway API key', disabled: busy, action: () => setView('key') },
    { id: 'connect', label: busy ? 'Connecting…' : 'Connect & continue', disabled: busy || !baseUrl.trim(), separatorBefore: true, action: () => { void connect(); } },
    { id: 'providers', label: 'Use another provider', disabled: busy, action: onProviders },
    ...alternatives.map(provider => ({ id: provider.id, label: `Continue with ${provider.name}`, disabled: busy, action: () => onContinue(provider.id) })),
    { id: 'later', label: 'Set up later', disabled: busy, action: onClose },
  ]} />;
}
