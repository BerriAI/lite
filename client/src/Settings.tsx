import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, Eye, EyeOff, KeyRound, Plus, Server, Settings2, ShieldCheck, Trash2, Unplug, X } from 'lucide-react';
import type { McpServerConfig, Provider, Settings as SettingsType } from '../../shared/types';
import { api, errorMessage, patch, post } from './api';
import { CopyButton, Modal, SpeedRail } from './ui';

type McpStatus = { name: string; status: string; tools: string[]; error?: string };
type Login = { loginId: string; method: 'device' | 'browser'; url: string; userCode?: string; expiresAt: number; providerId: string };
export function Settings({ settings, onClose, onSave }: { settings: SettingsType; onClose: () => void; onSave: (settings: SettingsType) => void }) {
  const [draft, setDraft] = useState<SettingsType>(() => ({ ...settings, providers: settings.providers.map(({ apiKey: _key, ...p }) => p) }));
  const [tab, setTab] = useState<'providers' | 'general' | 'integrations'>('providers');
  const [selected, setSelected] = useState(settings.defaultProvider || settings.providers[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [mcp, setMcp] = useState(JSON.stringify(settings.mcpServers, null, 2));
  const [servers, setServers] = useState<McpStatus[]>([]);
  const [login, setLogin] = useState<Login | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const initialMcp = useRef(JSON.stringify(settings.mcpServers, null, 2));
  useEffect(() => {
    if (!login) return;
    let live = true;
    const timer = window.setInterval(async () => {
      try {
        if (Date.now() > login.expiresAt) { if (live) { setLogin(null); setError('Sign-in expired. Start a new connection to try again.'); } return; }
        const result = await api<{ status: 'pending' | 'complete' | 'error'; error?: string }>(`/auth/codex/${login.loginId}`);
        if (!live) return;
        if (result.status === 'error') { setLogin(null); setError(result.error || 'Sign-in failed. Please try again.'); }
        if (result.status === 'complete') {
          const saved = await api<SettingsType>('/settings');
          if (!live) return;
          onSave(saved); setDraft(s => ({ ...s, providers: s.providers.map(p => p.id === login.providerId ? { ...p, configured: true } : p) })); setLogin(null); setNotice('ChatGPT connected. Choose a supported model to start.');
        }
      } catch (e) { if (live) { setError(errorMessage(e)); setLogin(null); } }
    }, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [login]);
  useEffect(() => { if (tab === 'integrations') api<{ servers: McpStatus[] }>('/mcp').then(r => setServers(r.servers)).catch(e => setError(errorMessage(e))); }, [tab]);
  const provider = draft.providers.find(p => p.id === selected);
  function updateProvider(update: Partial<Provider>) { setNotice(''); setDraft(s => ({ ...s, providers: s.providers.map(p => p.id === selected ? { ...p, ...update } : p) })); }
  async function save(close: boolean) {
    setBusy(true); setError(''); setNotice('');
    try {
      let mcpServers: Record<string, McpServerConfig>;
      try { mcpServers = JSON.parse(mcp); if (!mcpServers || Array.isArray(mcpServers) || typeof mcpServers !== 'object') throw new Error(); } catch { throw new Error('MCP servers must be a JSON object.'); }
      if (!draft.workspace.trim()) throw new Error('Enter an absolute workspace path.');
      if (!draft.providers.some(p => p.id === draft.defaultProvider)) throw new Error('Choose a default provider.');
      const { mcpServers: _mcp, ...values } = draft;
      const saved = await patch<SettingsType>('/settings', { ...values, providers: values.providers.map(p => ({ ...p, models: p.models?.filter(Boolean) })), ...(mcp !== initialMcp.current ? { mcpServers } : {}) });
      onSave(saved); setDraft({ ...saved, providers: saved.providers.map(({ apiKey: _key, ...p }) => p) });
      initialMcp.current = JSON.stringify(saved.mcpServers, null, 2); setMcp(initialMcp.current);
      if (close) onClose(); else setNotice('Settings saved.');
      return saved;
    } catch (e) { setError(errorMessage(e)); return null; }
    finally { setBusy(false); }
  }
  async function test() {
    setTesting(true);
    try {
      const saved = await save(false); if (!saved) return;
      const result = await post<{ ok: boolean; models?: number; error?: string }>('/providers/test', { providerId: selected });
      if (!result.ok) throw new Error(result.error || 'Connection failed. Check the URL and API key.');
      setNotice(`Connected${result.models !== undefined ? ` · ${result.models} models available` : ''}.`);
    } catch (e) { setError(errorMessage(e)); setNotice(''); } finally { setTesting(false); }
  }
  async function connect(method: 'device' | 'browser') {
    setAuthBusy(true); setError('');
    try {
      const saved = await save(false); if (!saved) return;
      const result = await post<Omit<Login, 'providerId'>>('/auth/codex/start', { providerId: selected, method });
      setLogin({ ...result, providerId: selected }); setNotice('');
    } catch (e) { setError(errorMessage(e)); } finally { setAuthBusy(false); }
  }
  async function disconnect() {
    setAuthBusy(true); setError('');
    try { await api(`/auth/codex/${selected}`, { method: 'DELETE' }); const saved = await api<SettingsType>('/settings'); onSave(saved); updateProvider({ configured: false }); setLogin(null); setNotice('ChatGPT disconnected.'); }
    catch (e) { setError(errorMessage(e)); } finally { setAuthBusy(false); }
  }
  function addProvider() {
    const p: Provider = { id: `provider-${crypto.randomUUID().slice(0, 8)}`, name: 'Custom provider', kind: 'openai', baseUrl: '', models: [] };
    setDraft(s => ({ ...s, providers: [...s.providers, p] })); setSelected(p.id); setShowKey(false);
  }
  return <Modal title="Settings" onClose={onClose} wide>
    <div className="settings-layout"><nav className="settings-nav" aria-label="Settings sections">
      <button className={tab === 'providers' ? 'selected' : ''} onClick={() => setTab('providers')}><Server size={16} />Providers</button>
      <button className={tab === 'general' ? 'selected' : ''} onClick={() => setTab('general')}><Settings2 size={16} />Workspace</button>
      <button className={tab === 'integrations' ? 'selected' : ''} onClick={() => setTab('integrations')}><Unplug size={16} />Integrations</button>
      <div className="settings-note"><ShieldCheck size={17} /><p>Your keys stay on this local server. They are never returned to the browser.</p></div>
    </nav><div className="settings-content">
      {tab === 'providers' && <>
        <div className="section-heading"><div><h3>Bring your own intelligence.</h3><p>One gateway, or connect directly. Your choice.</p></div></div>
        <div className="provider-tabs">{draft.providers.map(p => <button key={p.id} className={p.id === selected ? 'selected' : ''} onClick={() => { setSelected(p.id); setShowKey(false); setError(''); setNotice(''); }}><span className={`provider-dot ${p.configured ? 'configured' : ''}`} />{p.name}</button>)}<button onClick={addProvider} aria-label="Add provider"><Plus size={15} />Add</button></div>
        {provider ? <div className="form-stack">
          <div className="provider-intro"><span className="provider-symbol"><Server size={21} /></span><div><h4>{provider.name}</h4><p>{provider.configured ? 'Credentials configured' : 'Add your connection details to get started'}</p></div></div>
          <div className="form-columns"><label>Provider name<input value={provider.name} onChange={e => updateProvider({ name: e.target.value })} /></label><label>API format<select value={provider.kind} onChange={e => updateProvider({ kind: e.target.value as Provider['kind'], ...(e.target.value === 'codex' ? { baseUrl: 'https://chatgpt.com/backend-api/codex', name: provider.name === 'Custom provider' ? 'ChatGPT' : provider.name } : {}) })}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="codex">Codex</option></select></label></div>
          <label>Base URL<input type="url" placeholder="http://localhost:4000/v1" value={provider.baseUrl} onChange={e => updateProvider({ baseUrl: e.target.value })} spellCheck={false} /><span className="field-hint">For LiteLLM, use your proxy URL. Local servers may not need a key.</span></label>
          {provider.kind === 'codex' && <div className="auth-card"><strong>Connect your ChatGPT account</strong><p>Uses Codex sign-in. Availability depends on your plan, account eligibility, and provider rules. This is separate from an API key; it does not grant access to every model.</p>{login?.providerId === selected ? <><div className="auth-code">{login.userCode && <><code>{login.userCode}</code><CopyButton text={login.userCode} /></>}<a href={login.url} target="_blank" rel="noopener noreferrer">Continue sign-in ↗</a></div><div className="success-note"><SpeedRail active compact />Waiting for sign-in…</div><button className="text-button" onClick={() => setLogin(null)}>Stop waiting</button></> : <div className="auth-actions"><button className="button primary" disabled={busy || authBusy} onClick={() => void connect('device')}>{authBusy ? 'Connecting…' : provider.configured ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}<ArrowUpRight size={14} /></button><button className="text-button" disabled={busy || authBusy} onClick={() => void connect('browser')}>Use browser sign-in</button>{provider.configured && <button className="text-button danger" disabled={authBusy} onClick={() => void disconnect()}>Disconnect</button>}</div>}</div>}
          {provider.kind !== 'codex' && <label>API key<div className="secret-input"><KeyRound size={15} /><input type={showKey ? 'text' : 'password'} autoComplete="off" value={provider.apiKey ?? ''} placeholder={provider.configured ? 'Saved key · leave blank to keep' : 'Enter API key (optional for local servers)'} onChange={e => updateProvider({ apiKey: e.target.value || undefined })} /><button type="button" aria-label={showKey ? 'Hide API key' : 'Show API key'} onClick={() => setShowKey(v => !v)}>{showKey ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>{provider.configured && <button className="text-button danger" onClick={() => updateProvider({ apiKey: '', configured: false })}>Remove saved key on save</button>}</label>}
          <label>Model IDs<input placeholder="e.g. my-coding-model, local-model" value={(provider.models ?? []).join(', ')} onChange={e => updateProvider({ models: e.target.value.split(',').map(s => s.trim()) })} /><span className="field-hint">Comma-separated. Useful if your endpoint does not support model discovery.</span></label>
          <div className="provider-actions"><button className="button secondary" disabled={busy || testing || !provider.baseUrl} onClick={test}>{testing ? 'Connecting…' : 'Save & test connection'}<ArrowUpRight size={14} /></button><button className="icon-button danger" aria-label={`Remove ${provider.name}`} disabled={draft.providers.length < 2 || busy} onClick={() => { const next = draft.providers.filter(p => p.id !== selected); setDraft(s => ({ ...s, providers: next, defaultProvider: s.defaultProvider === selected ? next[0].id : s.defaultProvider })); setSelected(next[0].id); }}><Trash2 size={15} /></button></div>
        </div> : <div className="empty-state"><Server size={25} /><strong>No providers yet</strong><button className="button secondary" onClick={addProvider}><Plus size={15} />Add a provider</button></div>}
      </>}
      {tab === 'general' && <div className="form-stack"><div className="section-heading"><div><h3>A workspace that feels like yours.</h3><p>Defaults apply to new sessions.</p></div></div>
        <label>Workspace path<input value={draft.workspace} placeholder="/absolute/path/to/your/project" onChange={e => setDraft(s => ({ ...s, workspace: e.target.value }))} spellCheck={false} /><span className="field-hint">File tools are scoped here. Shell commands start here but are not sandboxed.</span></label>
        <div className="form-columns"><label>Default provider<select value={draft.defaultProvider} onChange={e => setDraft(s => ({ ...s, defaultProvider: e.target.value }))}>{draft.providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label>Default model<input value={draft.defaultModel} onChange={e => setDraft(s => ({ ...s, defaultModel: e.target.value }))} /></label></div>
        <label>Permissions<select value={draft.permissionMode} onChange={e => setDraft(s => ({ ...s, permissionMode: e.target.value as SettingsType['permissionMode'] }))}><option value="ask">Ask before changes and commands</option><option value="auto">Allow changes and commands automatically</option></select><span className="field-hint">Automatic mode lets the agent modify files and execute shell commands without asking.</span></label>
        <div className="form-columns"><label>Maximum steps<input type="number" min="1" max="100" value={draft.maxSteps} onChange={e => setDraft(s => ({ ...s, maxSteps: Number(e.target.value) }))} /></label><label>Appearance<select value={draft.theme} onChange={e => setDraft(s => ({ ...s, theme: e.target.value as SettingsType['theme'] }))}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></div>
        <div className="quiet-callout"><ShieldCheck size={18} /><p>Plan mode is read-only. Switch to Build when you are ready to make changes.</p></div>
      </div>}
      {tab === 'integrations' && <div className="form-stack"><div className="section-heading"><div><h3>Extend your workspace.</h3><p>Connect tools through Model Context Protocol.</p></div></div>
        <label>MCP servers<textarea className="code-input" rows={12} value={mcp} onChange={e => setMcp(e.target.value)} spellCheck={false} aria-describedby="mcp-hint" /><span className="field-hint" id="mcp-hint">A JSON object keyed by server name. Each entry supports command, args, env, or url, and enabled.</span></label>
        {servers.length > 0 && <div className="mcp-servers">{servers.map(s => <div key={s.name}><Unplug size={15} /><strong>{s.name}</strong><span>{s.status} · {s.tools.length} tools</span>{s.error && <p className="error-text">{s.error}</p>}</div>)}</div>}
        <div className="quiet-callout"><ShieldCheck size={18} /><p>Only connect servers you trust. MCP tools can access resources outside the workspace.</p></div>
      </div>}
      {(busy || testing) && <SpeedRail compact active />}
      {error && <div className="inline-alert" role="alert">{error}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={14} /></button></div>}
      {notice && <p className="success-note" role="status"><Check size={15} />{notice}</p>}
    </div></div>
    <footer className="modal-footer"><span>Local by default. Open by design.</span><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || testing} onClick={() => save(true)}>Save settings<ChevronRight size={15} /></button></footer>
  </Modal>;
}
