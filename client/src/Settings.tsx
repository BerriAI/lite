import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, Eye, EyeOff, KeyRound, Plus, Server, Settings2, ShieldCheck, Trash2, Unplug, X } from 'lucide-react';
import type { McpServerConfig, Provider, Settings as SettingsType } from '../../shared/types';
import { api, errorMessage, patch, post } from './api';
import { CopyButton, Modal, SpeedRail } from './ui';

type McpStatus = { name: string; status: string; tools: string[]; error?: string };
type Login = { loginId: string; method: 'device' | 'browser'; url: string; userCode?: string; expiresAt: number; providerId: string };
type ContextLimitRow = { id: string; model: string; tokens: string };
const contextRowsFor = (providers: Provider[]): Record<string, ContextLimitRow[]> => Object.fromEntries(providers.map(provider => [provider.id, Object.entries(provider.contextWindows ?? {}).map(([model, tokens]) => ({ id: crypto.randomUUID(), model, tokens: String(tokens) }))]));
function parseContextRows(rows: ContextLimitRow[]): Record<string, number> {
  if (rows.length > 100) throw new Error('Use at most 100 context window overrides per provider.');
  const entries: [string, number][] = [], seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const model = row.model.trim(), tokens = Number(row.tokens);
    if (!model || model.length > 250) throw new Error(`Context limit row ${index + 1}: enter an exact model ID between 1 and 250 characters, or remove the row.`);
    if (seen.has(model)) throw new Error(`Context limit row ${index + 1}: this model ID already has an override.`);
    if (!/^\d+$/.test(row.tokens) || !Number.isSafeInteger(tokens) || tokens < 1024 || tokens > 10_000_000) throw new Error(`Context limit row ${index + 1}: enter a whole token count from 1,024 to 10,000,000.`);
    seen.add(model); entries.push([model, tokens]);
  }
  return Object.fromEntries(entries);
}
export function Settings({ settings, onClose, onSave }: { settings: SettingsType; onClose: () => void; onSave: (settings: SettingsType) => void }) {
  const [draft, setDraft] = useState<SettingsType>(() => ({ ...settings, providers: settings.providers.map(({ apiKey: _key, ...p }) => p) }));
  const [contextRows, setContextRows] = useState(() => contextRowsFor(settings.providers));
  const saving = useRef(false);
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
  const rows = contextRows[selected] ?? [];
  function updateContextRows(next: ContextLimitRow[]) {
    if (saving.current) return;
    setNotice(''); setError(''); setContextRows(current => ({ ...current, [selected]: next }));
  }
  function updateProvider(update: Partial<Provider>) { setNotice(''); setDraft(s => ({ ...s, providers: s.providers.map(p => p.id === selected ? { ...p, ...update } : p) })); }
  async function save(close: boolean) {
    if (saving.current) return null;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    try {
      let mcpServers: Record<string, McpServerConfig>;
      try { mcpServers = JSON.parse(mcp); if (!mcpServers || Array.isArray(mcpServers) || typeof mcpServers !== 'object') throw new Error(); } catch { throw new Error('MCP servers must be a JSON object.'); }
      if (!draft.workspace.trim()) throw new Error('Enter an absolute workspace path.');
      if (!draft.providers.some(p => p.id === draft.defaultProvider)) throw new Error('Choose a default provider.');
      const { mcpServers: _mcp, ...values } = draft;
      const providers = values.providers.map(p => {
        let contextWindows: Record<string, number>;
        try { contextWindows = parseContextRows(contextRows[p.id] ?? []); }
        catch (error) { setSelected(p.id); setTab('providers'); throw error; }
        return { ...p, models: p.models?.filter(Boolean), ...(contextRows[p.id] !== undefined || p.contextWindows !== undefined ? { contextWindows } : {}) };
      });
      const saved = await patch<SettingsType>('/settings', { ...values, providers, ...(mcp !== initialMcp.current ? { mcpServers } : {}) });
      onSave(saved); setDraft({ ...saved, providers: saved.providers.map(({ apiKey: _key, ...p }) => p) });
      setContextRows(contextRowsFor(saved.providers));
      initialMcp.current = JSON.stringify(saved.mcpServers, null, 2); setMcp(initialMcp.current);
      if (close) onClose(); else setNotice('Settings saved.');
      return saved;
    } catch (e) { setError(errorMessage(e)); return null; }
    finally { saving.current = false; setBusy(false); }
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
          <details className="context-overrides" aria-label="Context window overrides" key={`context-${selected}`}><summary>Context window overrides<span>{rows.length || 'Optional'}</span><ChevronRight size={13} /></summary><div className="context-overrides-body">
            <p className="field-hint">Set a verified context window in tokens for an exact model ID on this provider. Overrides take priority over model discovery; they do not add models to the list above. Removing an override restores discovery, or an unknown limit when none is available.</p>
            {rows.length === 0 && <p className="context-overrides-empty">No overrides. Limits come from model discovery when available.</p>}
            {rows.map((row, index) => <div className="context-override-row" key={row.id}>
              <label>Model ID<input aria-label={`Model ID ${index + 1}`} value={row.model} maxLength={250} disabled={busy} placeholder="Exact model ID" spellCheck={false} autoComplete="off" onChange={e => updateContextRows(rows.map(item => item.id === row.id ? { ...item, model: e.target.value } : item))} /></label>
              <label>Context window tokens<input aria-label={`Context window tokens ${index + 1}`} type="number" inputMode="numeric" min={1024} max={10_000_000} step={1} value={row.tokens} disabled={busy} placeholder="e.g. 128000" onChange={e => updateContextRows(rows.map(item => item.id === row.id ? { ...item, tokens: e.target.value } : item))} /></label>
              <button className="icon-button danger" type="button" disabled={busy} aria-label={`Remove context limit ${row.model || index + 1}`} title="Remove context limit" onClick={() => updateContextRows(rows.filter(item => item.id !== row.id))}><Trash2 size={15} /></button>
            </div>)}
            <div className="context-overrides-footer"><button className="text-button" type="button" disabled={busy || rows.length >= 100} onClick={() => updateContextRows([...rows, { id: crypto.randomUUID(), model: '', tokens: '' }])}><Plus size={14} />Add context limit</button><span className="field-hint">{rows.length} / 100 · 1,024–10,000,000 tokens</span></div>
            <p className="field-hint">These values guide approximate budgeting; they cannot increase the provider’s actual limit.</p>
          </div></details>
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
