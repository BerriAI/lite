/** @jsxImportSource @opentui/react */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useRenderer } from '@opentui/react';
import type { Provider, Settings } from '../shared/types.js';
import { TerminalController } from './controller.js';
import { Menu, TextPrompt, TextViewer, type MenuItem } from './ui.js';
import { SecretPrompt } from './secrets.js';

type Login = { loginId: string; url: string; userCode?: string; expiresAt: number };
function LoginScreen({ controller, login, onClose }: { controller: TerminalController; login: Login; onClose: () => void }) {
  const [status, setStatus] = useState('Waiting for sign-in…'), renderer = useRenderer();
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await controller.client.api<{ status: string; error?: string }>(`/auth/codex/${encodeURIComponent(login.loginId)}`);
        if (!live) return;
        if (next.status === 'complete') { await controller.settings(); setStatus('Connected. You can close this screen and choose a model.'); return; }
        if (next.status === 'error') { setStatus(next.error || 'Login failed. Start a new sign-in.'); return; }
        if (Date.now() >= login.expiresAt) { setStatus('Login expired. Start a new sign-in.'); return; }
      } catch (error) { if (live) setStatus(String((error as Error).message)); }
      if (live) timer = setTimeout(poll, 2000);
    };
    void poll(); return () => { live = false; clearTimeout(timer); };
  }, [controller, login]);
  return <Menu title="Sign in to ChatGPT" search={false} onClose={onClose} items={[
    { id: 'url', label: 'Copy sign-in link', description: login.url, action: () => { renderer.copyToClipboardOSC52(login.url); } },
    ...(login.userCode ? [{ id: 'code', label: `Code: ${login.userCode}`, description: 'Select to copy the code', action: () => { renderer.copyToClipboardOSC52(login.userCode!); } }] : []),
    { id: 'status', label: status, disabled: true, action() {} },
  ]} footer="Open the link in your browser · Esc back" />;
}

export function Providers({ controller, onClose }: { controller: TerminalController; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState), settings = state.settings;
  const [editing, setEditing] = useState<Provider | null>(null), [isNew, setNew] = useState(false);
  const [view, setView] = useState('main'), [login, setLogin] = useState<Login | null>(null), [feedback, setFeedback] = useState('');
  const back = () => { setView('main'); setFeedback(''); };
  const run = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { setFeedback((error as Error).message); } };
  if (!settings) return <TextViewer title="Providers" text={state.notice || 'Loading providers…'} onClose={onClose} />;
  if (login) return <LoginScreen controller={controller} login={login} onClose={() => setLogin(null)} />;
  const save = async (value: Provider) => {
    const latest = await controller.settings();
    if (isNew && latest.providers.some(item => item.id === value.id)) throw new Error('This provider ID is already in use.');
    const provider = { ...value }; delete provider.configured;
    const providers = isNew ? [...latest.providers, provider] : latest.providers.map(item => item.id === value.id ? provider : item);
    if (await controller.action('Saving provider', async () => { await controller.client.api('/settings', { providers, ...(!latest.providers.length ? {defaultProvider: provider.id} : {}) }, 'PATCH'); await controller.settings(); })) { setEditing(null); back(); }
  };
  if (editing && view === 'key') return <SecretPrompt title="Provider API key" onClose={back} onSave={apiKey => { setEditing({ ...editing, apiKey }); back(); }} />;
  if (editing && view.startsWith('field:')) {
    const field = view.slice(6) as 'name' | 'baseUrl' | 'id' | 'models' | 'anthropicCacheModels';
    const list = field === 'models' || field === 'anthropicCacheModels';
    return <TextPrompt title={field === 'baseUrl' ? 'API base URL' : field === 'anthropicCacheModels' ? 'Claude model aliases (one per line)' : field === 'models' ? 'Model IDs (one per line)' : field === 'id' ? 'Provider ID' : 'Provider name'} value={list ? editing[field]?.join('\n') : editing[field]} multiline={list} onClose={back} onSave={value => { setEditing({ ...editing, [field]: list ? value.split(/\n/).map(item => item.trim()).filter(Boolean) : value.trim() }); back(); }} />;
  }
  if (editing && view === 'kind') return <Menu title="Provider type" onClose={back} search={false} items={[
    { id: 'openai', label: 'OpenAI compatible', description: 'LiteLLM, OpenAI, or another compatible API', action: () => { setEditing({ ...editing, kind: 'openai' }); back(); } },
    { id: 'anthropic', label: 'Anthropic', action: () => { setEditing({ ...editing, kind: 'anthropic', baseUrl: 'https://api.anthropic.com' }); back(); } },
    { id: 'codex', label: 'ChatGPT subscription', description: 'Sign in after saving this provider', action: () => { setEditing({ ...editing, kind: 'codex', baseUrl: 'https://chatgpt.com/backend-api/codex' }); back(); } },
  ]} />;
  if (editing) {
    const fields: MenuItem[] = ['name', ...(isNew ? ['id'] : []), 'baseUrl', 'models'].map(field => ({ id: field, label: `${field === 'baseUrl' ? 'Base URL' : field === 'models' ? 'Models' : field === 'id' ? 'Provider ID' : 'Name'}: ${field === 'models' ? editing.models?.join(', ') || 'Discover automatically' : editing[field as 'name']}`, action: () => setView(`field:${field}`) }));
    return <Menu title={isNew ? 'Add provider' : editing.name} search={false} onClose={() => { setEditing(null); back(); }} footer={feedback || state.notice || '↑↓ choose · Enter edit · Esc back'} items={[
      { id: 'kind', label: `Type: ${editing.kind}`, action: () => setView('kind') }, ...fields,
      ...(editing.kind !== 'codex' ? [{ id: 'key', label: `API key: ${editing.apiKey && editing.apiKey !== '••••••••' ? 'Updated' : editing.configured ? 'Configured' : 'Not set'}`, action: () => setView('key') }] : []),
      ...(editing.kind === 'openai' ? [{ id: 'cache-aliases', label: `Claude caching aliases: ${editing.anthropicCacheModels?.join(', ') || 'Automatic by model name'}`, description: 'Exact Claude gateway IDs. Claude/Anthropic names are automatic.', action: () => setView('field:anthropicCacheModels') }] : []),
      { id: 'save', label: 'Save provider', separatorBefore: true, disabled: Boolean(state.pending), action: () => { void run(() => save(editing)); } },
    ]} />;
  }
  const select = (provider: Provider) => {
    setFeedback(''); setNew(false); setEditing(provider);
  };
  return <Menu title="Providers" onClose={onClose} footer={feedback || state.notice || 'Select a provider to edit · Esc back'} items={[
    { id: 'add', label: '+ Add provider', action: () => { setNew(true); setEditing({ id: '', name: '', kind: 'openai', baseUrl: 'https://api.openai.com/v1' }); } },
    ...settings.providers.flatMap(provider => [
      { id: provider.id, label: provider.name, description: `${provider.kind} · ${provider.configured ? 'Configured' : 'Needs setup'}`, action: () => select(provider) },
      ...(provider.kind === 'codex' ? [{ id: `${provider.id}:login`, label: `Sign in · ${provider.name}`, action: () => { void run(async () => setLogin(await controller.client.api<Login>('/auth/codex/start', { providerId: provider.id, method: 'device' }))); } }, { id: `${provider.id}:logout`, label: `Disconnect · ${provider.name}`, action: () => { void run(async () => { if (await controller.action('Disconnecting', () => controller.client.api(`/auth/codex/${encodeURIComponent(provider.id)}`, undefined, 'DELETE'))) await controller.settings(); }); } }] : []),
      { id: `${provider.id}:test`, label: `Test connection · ${provider.name}`, action: () => { void run(async () => { const result = await controller.client.api<{ ok: boolean; models: number }>('/providers/test', { providerId: provider.id }); setFeedback(result.ok ? `Connected · ${result.models} models` : 'Connection failed'); }); } },
    ]),
  ]} />;
}
