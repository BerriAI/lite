import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, Eye, EyeOff, KeyRound, Plus, Server, Settings2, ShieldCheck, Trash2, Unplug, X } from 'lucide-react';
import type { McpServerConfig, Provider, Settings as SettingsType } from '../../shared/types';
import { api, errorMessage, patch, post } from './api';
import { CopyButton, Modal, SpeedRail } from './ui';

import type { McpServerStatus } from '../../shared/mcp';

type McpSnapshot = { servers: McpServerStatus[]; configRevision: string };
type McpReview = { servers: Record<string, McpServerConfig>; revision: string };
const mcpStatusLabels: Record<McpServerStatus['status'], string> = { disabled: 'Disabled', disconnected: 'Configured · disconnected', connecting: 'Connecting', connected: 'Connected', refreshing: 'Refreshing tools', stale: 'Stale', error: 'Error' };
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
  const [mcpSnapshot, setMcpSnapshot] = useState<McpSnapshot | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState('');
  const [mcpFeedback, setMcpFeedback] = useState<Record<string, string>>({});
  const [mcpActions, setMcpActions] = useState(new Set<string>());
  const [mcpReview, setMcpReview] = useState<McpReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const reviewedRevision = useRef(settings.mcpConfigRevision);
  const savedMcp = useRef(settings.mcpServers);
  const mcpOperations = useRef(new Set<string>());
  const reviewOperation = useRef(false);
  const mcpGeneration = useRef(0), mcpRead = useRef(0), mcpReadPending = useRef<number | null>(null);
  const alive = useRef(true), tabRef = useRef(tab); tabRef.current = tab;
  const currentMcp = useRef(mcp); currentMcp.current = mcp;
  const currentSnapshot = useRef(mcpSnapshot); currentSnapshot.current = mcpSnapshot;
  const baselineVersion = useRef(0);
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
  useEffect(() => { alive.current = true; return () => { alive.current = false; mcpGeneration.current++; mcpRead.current++; }; }, []);
  const refreshMcp = useCallback(async (force = false) => {
    if (!alive.current || tabRef.current !== 'integrations' || (!force && mcpReadPending.current !== null)) return;
    const request = ++mcpRead.current, generation = mcpGeneration.current;
    mcpReadPending.current = request; setMcpLoading(true);
    try {
      const value = await api<McpSnapshot>('/mcp');
      if (alive.current && tabRef.current === 'integrations' && mcpGeneration.current === generation && mcpRead.current === request) {
        currentSnapshot.current = value; setMcpSnapshot(value); setMcpError('');
      }
    } catch (e) {
      if (alive.current && tabRef.current === 'integrations' && mcpGeneration.current === generation && mcpRead.current === request) setMcpError(`Could not read cached MCP status: ${errorMessage(e)}`);
    } finally {
      if (mcpReadPending.current === request) mcpReadPending.current = null;
      if (alive.current && mcpGeneration.current === generation && mcpRead.current === request) setMcpLoading(false);
    }
  }, []);
  useEffect(() => {
    mcpGeneration.current++; mcpRead.current++; mcpReadPending.current = null;
    if (tab !== 'integrations') return;
    void refreshMcp(true);
    const timer = window.setInterval(() => { if (!saving.current && !mcpOperations.current.size) void refreshMcp(); }, 3000);
    return () => { clearInterval(timer); mcpGeneration.current++; mcpRead.current++; mcpReadPending.current = null; };
  }, [tab, refreshMcp]);
  const mcpDirty = mcp !== initialMcp.current;
  const mcpMismatch = !reviewedRevision.current || Boolean(mcpSnapshot && mcpSnapshot.configRevision !== reviewedRevision.current);
  const anyMcpAction = mcpActions.size > 0;
  async function runMcp(server: McpServerStatus, action: 'refresh' | 'reconnect') {
    const snapshot = currentSnapshot.current, expectedConfigRevision = reviewedRevision.current;
    if (saving.current || mcpOperations.current.has(server.name) || reviewOperation.current || currentMcp.current !== initialMcp.current || !expectedConfigRevision || !snapshot || snapshot.configRevision !== expectedConfigRevision || snapshot.servers.find(item => item.name === server.name)?.revision !== server.revision || ['disabled', 'connecting', 'refreshing'].includes(server.status)) return;
    if (action === 'refresh' && !['connected', 'stale'].includes(server.status)) return;
    mcpOperations.current.add(server.name); setMcpActions(new Set(mcpOperations.current));
    setMcpFeedback(current => ({ ...current, [server.name]: '' }));
    mcpRead.current++; mcpReadPending.current = null;
    const baseline = baselineVersion.current;
    try {
      // Actions use only saved server identity and reviewed revisions, never editor JSON or credentials.
      await post<McpSnapshot>(`/mcp/${encodeURIComponent(server.name)}/${action}`, { expectedRevision: server.revision, expectedConfigRevision });
      if (alive.current && baselineVersion.current === baseline) setMcpFeedback(current => ({ ...current, [server.name]: action === 'refresh' ? 'Tool refresh completed. Future turns use the refreshed catalog.' : 'Connection request completed. Future turns use the current catalog.' }));
    } catch (e) {
      if (alive.current && baselineVersion.current === baseline) setMcpFeedback(current => ({ ...current, [server.name]: `${errorMessage(e)} Review the cached status before an explicit retry. If saved configuration changed, review it below first.` }));
    } finally {
      if (alive.current) await refreshMcp(true);
      mcpOperations.current.delete(server.name);
      if (alive.current) setMcpActions(new Set(mcpOperations.current));
    }
  }
  async function reviewMcp() {
    if (saving.current || mcpOperations.current.size || reviewOperation.current) return;
    reviewOperation.current = true; setReviewLoading(true); setMcpError('');
    const baseline = baselineVersion.current, generation = mcpGeneration.current;
    try {
      const saved = await api<SettingsType>('/settings');
      if (alive.current && baselineVersion.current === baseline && mcpGeneration.current === generation && tabRef.current === 'integrations') {
        if (!saved.mcpConfigRevision) throw new Error('Saved configuration revision is unavailable. Update the local server before connecting.');
        setMcpReview({ servers: saved.mcpServers, revision: saved.mcpConfigRevision });
      }
    } catch (e) { if (alive.current && baselineVersion.current === baseline && mcpGeneration.current === generation) setMcpError(`Could not review saved MCP configuration: ${errorMessage(e)}`); }
    finally { reviewOperation.current = false; if (alive.current) setReviewLoading(false); }
  }
  function adoptMcpReview() {
    if (!mcpReview || saving.current || mcpOperations.current.size || reviewOperation.current || currentMcp.current !== initialMcp.current) return;
    baselineVersion.current++; reviewedRevision.current = mcpReview.revision; savedMcp.current = mcpReview.servers;
    initialMcp.current = JSON.stringify(mcpReview.servers, null, 2); currentMcp.current = initialMcp.current; setMcp(initialMcp.current);
    setDraft(current => ({ ...current, mcpServers: mcpReview.servers, mcpConfigRevision: mcpReview.revision }));
    setMcpReview(null); setMcpFeedback({}); setMcpError(''); void refreshMcp(true);
  }
  const provider = draft.providers.find(p => p.id === selected);
  const rows = contextRows[selected] ?? [];
  function updateContextRows(next: ContextLimitRow[]) {
    if (saving.current) return;
    setNotice(''); setError(''); setContextRows(current => ({ ...current, [selected]: next }));
  }
  function updateProvider(update: Partial<Provider>) { setNotice(''); setDraft(s => ({ ...s, providers: s.providers.map(p => p.id === selected ? { ...p, ...update } : p) })); }
  async function save(close: boolean) {
    if (saving.current || mcpOperations.current.size || reviewOperation.current) return null;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    try {
      let mcpServers: Record<string, McpServerConfig>;
      try { mcpServers = JSON.parse(mcp); if (!mcpServers || Array.isArray(mcpServers) || typeof mcpServers !== 'object') throw new Error(); } catch { throw new Error('MCP servers must be a JSON object.'); }
      if (!draft.workspace.trim()) throw new Error('Enter an absolute workspace path.');
      if (!draft.providers.some(p => p.id === draft.defaultProvider)) throw new Error('Choose a default provider.');
      const mcpChanged = mcp !== initialMcp.current;
      if (mcpChanged && !reviewedRevision.current) throw new Error('Review the saved MCP configuration before saving MCP changes.');
      const { mcpServers: _mcp, mcpConfigRevision: _revision, ...values } = draft;
      const providers = values.providers.map(p => {
        let contextWindows: Record<string, number>;
        try { contextWindows = parseContextRows(contextRows[p.id] ?? []); }
        catch (error) { setSelected(p.id); setTab('providers'); throw error; }
        return { ...p, models: p.models?.filter(Boolean), ...(contextRows[p.id] !== undefined || p.contextWindows !== undefined ? { contextWindows } : {}) };
      });
      const saved = await patch<SettingsType>('/settings', { ...values, providers, ...(mcpChanged ? { mcpServers, expectedMcpConfigRevision: reviewedRevision.current } : {}) });
      if (!alive.current) return saved;
      onSave(saved);
      if (mcpChanged) {
        baselineVersion.current++; savedMcp.current = saved.mcpServers; reviewedRevision.current = saved.mcpConfigRevision;
        initialMcp.current = JSON.stringify(saved.mcpServers, null, 2); currentMcp.current = initialMcp.current; setMcp(initialMcp.current); setMcpReview(null); setMcpFeedback({});
      }
      // An unrelated save is not consent to adopt unseen changes to saved executable configuration.
      setDraft({ ...saved, mcpServers: savedMcp.current, mcpConfigRevision: reviewedRevision.current, providers: saved.providers.map(({ apiKey: _key, ...p }) => p) });
      setContextRows(contextRowsFor(saved.providers));
      if (close) onClose(); else { setNotice('Settings saved.'); void refreshMcp(true); }
      return saved;
    } catch (e) { if (alive.current) { setError(errorMessage(e)); void refreshMcp(true); } return null; }
    finally { saving.current = false; if (alive.current) setBusy(false); }
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
        <label>MCP servers<textarea className="code-input" rows={12} value={mcp} disabled={busy} onChange={e => { currentMcp.current = e.target.value; setMcp(e.target.value); }} spellCheck={false} aria-label="MCP servers" aria-describedby="mcp-hint" /><span className="field-hint" id="mcp-hint">A JSON object keyed by server name. Each entry supports command, args, env, or url, and enabled. Masked environment values are kept when saved unchanged.</span></label>
        <div className="mcp-cache-heading"><div><strong>Saved server connections</strong><p>Cache-only status · checked every 3 seconds while this tab is open. Viewing status never starts a server.</p></div><button className="button secondary" disabled={mcpLoading || busy} onClick={() => void refreshMcp(true)}>Refresh status</button></div>
        {mcpLoading && <p className="field-hint" role="status">Loading cached MCP status…</p>}
        {mcpDirty && <p className="mcp-warning" role="status">Unsaved MCP changes. Save settings before connecting, refreshing tools, or reconnecting. Actions only use saved configuration.</p>}
        {mcpMismatch && <p className="mcp-warning" role="status">Saved MCP configuration changed or has not been reviewed. Review saved MCP configuration below before taking action. Your unsaved edits are untouched.</p>}
        {mcpError && <div className="inline-alert" role="alert">{mcpError}</div>}
        <div className="mcp-servers">{mcpSnapshot?.servers.map(server => {
          const pending = mcpActions.has(server.name), unavailable = busy || reviewLoading || mcpDirty || mcpMismatch || pending || ['disabled', 'connecting', 'refreshing'].includes(server.status);
          return <section className="mcp-server" key={server.name} role="region" aria-label={`MCP server ${server.name}`}>
            <div className="mcp-server-heading"><Unplug size={16} /><h4>{server.name}</h4><span className={`mcp-server-status ${server.status}`} role="status">{pending ? 'Loading · action in progress' : mcpStatusLabels[server.status]}</span></div>
            {server.reason && <p className="mcp-reason">{server.reason}</p>}{server.error && <p className="error-text" role="status">{server.error}</p>}
            {server.status === 'disconnected' && <p>Connection is closed or not yet opened. Choose Connect to start this saved server.</p>}
            {server.status === 'stale' && <p>Cached tools are stale and unavailable to new turns until you explicitly refresh or reconnect.</p>}
            {server.status === 'error' && <p>No automatic retry. Review the server and choose Reconnect when ready.</p>}
            {server.status === 'disabled' && <p>This saved server is disabled. Enable it in the JSON and save first.</p>}
            <details className="mcp-tool-catalog"><summary>{server.tools.length} cached tool{server.tools.length === 1 ? '' : 's'}{server.status !== 'connected' ? ' · not currently available' : ''}</summary>{server.tools.length ? <ul>{server.tools.map(tool => <li key={tool.name}><code>{tool.name}</code><span>{tool.description}</span>{tool.remoteName !== tool.name && <small>Server tool · {tool.remoteName}</small>}</li>)}</ul> : <p>No tools cached. A connection or refresh may discover tools.</p>}</details>
            <div className="mcp-server-actions">{server.status === 'disconnected' ? <button className="button secondary" disabled={unavailable} onClick={() => void runMcp(server, 'reconnect')}>Connect</button> : <><button className="button secondary" disabled={unavailable || !['connected', 'stale'].includes(server.status)} onClick={() => void runMcp(server, 'refresh')}>Refresh tools</button><button className="button secondary" disabled={unavailable} onClick={() => void runMcp(server, 'reconnect')}>Reconnect</button></>}</div>
            {mcpFeedback[server.name] && <p className="mcp-action-feedback" role="status">{mcpFeedback[server.name]}</p>}
          </section>;
        })}</div>
        {!mcpLoading && mcpSnapshot?.servers.length === 0 && <p className="field-hint">No saved MCP servers. Add configuration above and save, then connect explicitly.</p>}
        <section className="mcp-config-review" aria-label="Review saved MCP configuration"><button className="text-button" disabled={busy || anyMcpAction || reviewLoading} onClick={() => void reviewMcp()}>{reviewLoading ? 'Loading saved configuration…' : 'Review saved MCP configuration'}</button>{mcpReview && <><p>Review the saved commands and endpoints below. Environment values stay masked; using this configuration accepts its saved environment too. This does not connect or retry a server.</p><pre aria-label="Saved MCP configuration preview">{JSON.stringify(mcpReview.servers, null, 2)}</pre>{mcpDirty && <p className="mcp-warning">Your MCP editor has unsaved changes. Copy them somewhere safe, then return the editor to its original content before using the reviewed configuration. Nothing will be discarded automatically.</p>}<button className="button secondary" disabled={busy || anyMcpAction || reviewLoading || mcpDirty} onClick={adoptMcpReview}>Use reviewed configuration</button></>}</section>
        <div className="quiet-callout"><ShieldCheck size={18} /><p>MCP commands are trusted executable code, not sandboxed configuration. Only connect servers you trust: tools can access resources outside this workspace. Cancelling a request does not guarantee a remote mutation stopped. This integration supports tools only, not OAuth, resources, or prompts; it never automatically retries a connection.</p></div>
      </div>}
      {(busy || testing) && <SpeedRail compact active />}
      {error && <div className="inline-alert" role="alert">{error}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={14} /></button></div>}
      {notice && <p className="success-note" role="status"><Check size={15} />{notice}</p>}
    </div></div>
    <footer className="modal-footer"><span>Local by default. Open by design.</span><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || testing || anyMcpAction || reviewLoading} onClick={() => save(true)}>Save settings<ChevronRight size={15} /></button></footer>
  </Modal>;
}
