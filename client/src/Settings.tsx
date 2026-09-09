import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Check, ChevronRight, Eye, EyeOff, KeyRound, Plus, Server, Settings2, Shield, ShieldCheck, Trash2, Unplug, X } from 'lucide-react';
import type { McpServerConfig, Provider, Settings as SettingsType, UsageReport } from '../../shared/types';
import type { PermissionDecision, PermissionRuleSet } from '../../shared/permissions';
import { PERMISSION_LIMITS } from '../../shared/permissions';
import { api, errorMessage, patch, post, query } from './api';
import { CopyButton, Modal, SpeedRail } from './ui';

import type { McpServerStatus } from '../../shared/mcp';
import type { MemoryFactSummary } from '../../shared/memory';

type McpSnapshot = { servers: McpServerStatus[]; configRevision: string };
type McpReview = { servers: Record<string, McpServerConfig>; revision: string };
const mcpStatusLabels: Record<McpServerStatus['status'], string> = { disabled: 'Disabled', disconnected: 'Configured · disconnected', connecting: 'Connecting', connected: 'Connected', refreshing: 'Refreshing tools', stale: 'Stale', error: 'Error' };
type Login = { loginId: string; method: 'device' | 'browser'; url: string; userCode?: string; expiresAt: number; providerId: string };
type ContextLimitRow = { id: string; model: string; tokens: string };
// Mirrors the server's RULE_TOOLS allowlist (server/permissions.ts stays the authority; rules never target mcp_* tools).
const RULE_TOOLS = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'web_fetch', 'todo_read', 'todo_write', 'task'] as const;
const decisionLabels: [PermissionDecision, string][] = [['allow', 'Allow without asking'], ['ask', 'Ask every time'], ['deny', 'Deny always']];
type RuleRow = { id: string; tool: string; decision: PermissionDecision; patterns: string };
const ruleRowsFor = (ruleSet?: PermissionRuleSet): RuleRow[] => (ruleSet?.rules ?? []).map(rule => ({ id: crypto.randomUUID(), tool: rule.tool, decision: rule.decision, patterns: (rule.patterns ?? []).join('\n') }));
const rowPatterns = (row: RuleRow) => row.patterns.split('\n').map(line => line.trim()).filter(Boolean);
function ruleRowError(row: RuleRow): string {
  if (!(RULE_TOOLS as readonly string[]).includes(row.tool)) return 'Choose a built-in tool.';
  const patterns = rowPatterns(row);
  if (patterns.length > PERMISSION_LIMITS.patternsPerRule) return `Use at most ${PERMISSION_LIMITS.patternsPerRule} patterns per rule.`;
  const over = patterns.find(value => value.length > PERMISSION_LIMITS.patternLength);
  if (over !== undefined) return `Patterns are limited to ${PERMISSION_LIMITS.patternLength} characters each.`;
  if (patterns.some(value => /[\p{Cc}\p{Cf}]/u.test(value))) return 'Patterns must be single-line printable text.';
  return '';
}
function parseRuleRows(rows: RuleRow[]): PermissionRuleSet {
  if (rows.length > PERMISSION_LIMITS.rules) throw new Error(`Use at most ${PERMISSION_LIMITS.rules} permission rules.`);
  return { version: 1, rules: rows.map((row, index) => {
    const problem = ruleRowError(row); if (problem) throw new Error(`Permission rule ${index + 1}: ${problem}`);
    const patterns = rowPatterns(row);
    return { tool: row.tool, decision: row.decision, ...(patterns.length ? { patterns } : {}) };
  }) };
}
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
  const [ruleRows, setRuleRows] = useState(() => ruleRowsFor(settings.permissionRules));
  const rulesTouched = useRef(false);
  const saving = useRef(false);
  const [tab, setTab] = useState<'providers' | 'general' | 'permissions' | 'integrations' | 'usage'>('providers');
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
  const [memoryFacts, setMemoryFacts] = useState<MemoryFactSummary[] | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  const [memoryBusy, setMemoryBusy] = useState('');
  const memoryTouched = useRef(false);
  const memoryRead = useRef(0);
  // Notifications mirror the memory-toggle contract: only sent on save when
  // the user actually touched the checkbox, so an unrelated save never
  // overwrites a concurrent change.
  const notificationsTouched = useRef(false);
  // Usage tab: read-only report fetched when the tab opens (5.1).
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [usageDays, setUsageDays] = useState(30);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState('');
  const usageRead = useRef(0);
  const memoryWorkspace = draft.workspace.trim();
  const memoryWorkspaceRef = useRef(memoryWorkspace); memoryWorkspaceRef.current = memoryWorkspace;
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
  const refreshMemory = useCallback(async (workspace: string) => {
    if (!alive.current || tabRef.current !== 'general' || !workspace) return;
    const request = ++memoryRead.current;
    setMemoryLoading(true);
    try {
      const value = await api<{ facts: MemoryFactSummary[] }>(`/memory?${query({ workspace })}`);
      if (alive.current && tabRef.current === 'general' && memoryRead.current === request && memoryWorkspaceRef.current === workspace) { setMemoryFacts(value.facts); setMemoryError(''); }
    } catch (e) {
      if (alive.current && tabRef.current === 'general' && memoryRead.current === request && memoryWorkspaceRef.current === workspace) { setMemoryFacts(null); setMemoryError(`Could not read recorded facts: ${errorMessage(e)}`); }
    } finally {
      if (alive.current && memoryRead.current === request) setMemoryLoading(false);
    }
  }, []);
  useEffect(() => {
    memoryRead.current++;
    if (tab !== 'general') return;
    setMemoryFacts(null); setMemoryError('');
    void refreshMemory(memoryWorkspace);
    return () => { memoryRead.current++; };
  }, [tab, memoryWorkspace, refreshMemory]);
  useEffect(() => {
    usageRead.current++;
    if (tab !== 'usage') return;
    const request = ++usageRead.current;
    setUsageLoading(true); setUsageError('');
    void (async () => {
      try {
        const value = await api<UsageReport>(`/usage?${query({ days: String(usageDays) })}`);
        if (alive.current && usageRead.current === request) setUsage(value);
      } catch (e) {
        if (alive.current && usageRead.current === request) { setUsage(null); setUsageError(`Could not read recorded usage: ${errorMessage(e)}`); }
      } finally {
        if (alive.current && usageRead.current === request) setUsageLoading(false);
      }
    })();
    return () => { usageRead.current++; };
  }, [tab, usageDays]);
  async function forgetFact(name: string) {
    if (memoryBusy) return;
    const workspace = memoryWorkspaceRef.current;
    setMemoryBusy(name); setMemoryError('');
    try {
      await api<{ removed: boolean }>(`/memory/${encodeURIComponent(name)}?${query({ workspace })}`, { method: 'DELETE' });
    } catch (e) {
      if (alive.current && memoryWorkspaceRef.current === workspace) setMemoryError(`Could not delete the fact: ${errorMessage(e)}`);
    } finally {
      if (alive.current) { setMemoryBusy(''); if (memoryWorkspaceRef.current === workspace) void refreshMemory(workspace); }
    }
  }
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
  function updateRuleRows(next: RuleRow[]) {
    if (saving.current) return;
    rulesTouched.current = true; setNotice(''); setError(''); setRuleRows(next);
  }
  const ruleErrors = ruleRows.map(ruleRowError);
  const rulesInvalid = ruleRows.length > PERMISSION_LIMITS.rules || ruleErrors.some(Boolean);
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
      const { mcpServers: _mcp, mcpConfigRevision: _revision, permissionRules: _rules, memoryEnabled: _memory, notifications: _notifications, ...values } = draft;
      let permissionRules: PermissionRuleSet | undefined;
      if (rulesTouched.current) {
        try { permissionRules = parseRuleRows(ruleRows); } catch (error) { setTab('permissions'); throw error; }
      }
      const providers = values.providers.map(p => {
        let contextWindows: Record<string, number>;
        try { contextWindows = parseContextRows(contextRows[p.id] ?? []); }
        catch (error) { setSelected(p.id); setTab('providers'); throw error; }
        return { ...p, models: p.models?.filter(Boolean), ...(contextRows[p.id] !== undefined || p.contextWindows !== undefined ? { contextWindows } : {}) };
      });
      const saved = await patch<SettingsType>('/settings', { ...values, providers, ...(memoryTouched.current ? { memoryEnabled: Boolean(draft.memoryEnabled) } : {}), ...(notificationsTouched.current ? { notifications: Boolean(draft.notifications) } : {}), ...(permissionRules !== undefined ? { permissionRules } : {}), ...(mcpChanged ? { mcpServers, expectedMcpConfigRevision: reviewedRevision.current } : {}) });
      if (!alive.current) return saved;
      onSave(saved);
      if (mcpChanged) {
        baselineVersion.current++; savedMcp.current = saved.mcpServers; reviewedRevision.current = saved.mcpConfigRevision;
        initialMcp.current = JSON.stringify(saved.mcpServers, null, 2); currentMcp.current = initialMcp.current; setMcp(initialMcp.current); setMcpReview(null); setMcpFeedback({});
      }
      // An unrelated save is not consent to adopt unseen changes to saved executable configuration.
      setDraft({ ...saved, mcpServers: savedMcp.current, mcpConfigRevision: reviewedRevision.current, providers: saved.providers.map(({ apiKey: _key, ...p }) => p) });
      setContextRows(contextRowsFor(saved.providers));
      setRuleRows(ruleRowsFor(saved.permissionRules)); rulesTouched.current = false; memoryTouched.current = false; notificationsTouched.current = false;
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
      <button className={tab === 'permissions' ? 'selected' : ''} onClick={() => setTab('permissions')}><Shield size={16} />Permissions</button>
      <button className={tab === 'integrations' ? 'selected' : ''} onClick={() => setTab('integrations')}><Unplug size={16} />Integrations</button>
      <button className={tab === 'usage' ? 'selected' : ''} onClick={() => setTab('usage')}><Activity size={16} />Usage</button>
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
        <label className="notifications-toggle"><input type="checkbox" checked={Boolean(draft.notifications)} disabled={busy} onChange={e => { notificationsTouched.current = true; setNotice(''); const notifications = e.target.checked; setDraft(s => ({ ...s, notifications })); }} />Notify when a response finishes or needs approval</label>
        <p className="field-hint">Off by default. Uses your operating system’s notifications (macOS and Linux); only responses longer than 10 seconds notify on finish. Changes apply immediately, even to a running response.</p>
        <section className="memory-section" aria-label="Agent memory">
          <div className="mcp-cache-heading"><div><strong>Memory</strong><p>Recorded facts for the workspace above.</p></div><button className="button secondary" disabled={memoryLoading || busy || !memoryWorkspace} onClick={() => void refreshMemory(memoryWorkspace)}>Refresh facts</button></div>
          <label className="memory-toggle"><input type="checkbox" checked={Boolean(draft.memoryEnabled)} disabled={busy} onChange={e => { memoryTouched.current = true; setNotice(''); const memoryEnabled = e.target.checked; setDraft(s => ({ ...s, memoryEnabled })); }} />Enable agent memory</label>
          <p className="field-hint">Memory is off by default. Facts are low-authority background data stored locally per workspace, and the agent’s remember and forget actions go through normal tool permissions.</p>
          {memoryLoading && <p className="field-hint" role="status">Loading recorded facts…</p>}
          {memoryError && <div className="inline-alert" role="alert">{memoryError}</div>}
          {(draft.memoryEnabled || Boolean(memoryFacts?.length)) && !memoryLoading && !memoryError && <>
            {memoryFacts?.length === 0 && <p className="field-hint">No recorded facts for this workspace.</p>}
            {Boolean(memoryFacts?.length) && <ul className="memory-facts">{memoryFacts!.map(fact => <li className="memory-fact" key={fact.id}>
              <div><strong>{fact.name}</strong><p>{fact.description}</p><small>Updated {new Date(fact.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</small></div>
              <button className="icon-button danger" type="button" disabled={busy || Boolean(memoryBusy)} aria-label={`Delete fact ${fact.name}`} title="Delete fact" onClick={() => void forgetFact(fact.name)}><Trash2 size={15} /></button>
            </li>)}</ul>}
          </>}
        </section>
        <div className="quiet-callout"><ShieldCheck size={18} /><p>Plan mode is read-only. Switch to Build when you are ready to make changes.</p></div>
      </div>}
      {tab === 'permissions' && <div className="form-stack"><div className="section-heading"><div><h3>Decide once, ahead of time.</h3><p>Explicit rules run before the session’s permission mode.</p></div></div>
        <p className="field-hint">An explicit Deny always wins. Ask beats Allow. Per-project rules in <code>.lite/permissions.json</code> in your workspace (same shape: <code>{'{"version":1,"rules":[…]}'}</code>) override these app rules at equal severity. When no rule matches, the session’s permission mode decides as usual. Rules never widen tool availability — Plan mode and profile limits still apply, and connected (mcp_*) tools cannot be targeted. Rules for a turn are captured when the message is accepted, so edits here apply to future turns.</p>
        <p className="field-hint">Patterns, one per line, match the tool’s sensitive argument: the command for bash, the workspace-relative path for file tools. A rule with no patterns matches every call of the tool. For bash, a pattern without wildcards matches as a command prefix at a word boundary (“git status” covers “git status --short”, not “git statusx”); <code>*</code> spans words and flags but never crosses shell operators like <code>;</code> <code>&&</code> <code>|</code>; <code>**</code> matches anything. For file tools, <code>*</code> stays within one path segment and <code>**</code> crosses segments.</p>
        {ruleRows.length === 0 ? <div className="empty-state"><Shield size={25} /><strong>No permission rules</strong><p>Every tool call falls back to the session’s permission mode. Add a rule to always allow, always ask, or always deny specific tools or patterns.</p><button className="button secondary" disabled={busy} onClick={() => updateRuleRows([{ id: crypto.randomUUID(), tool: 'bash', decision: 'ask', patterns: '' }])}><Plus size={15} />Add rule</button></div> : <>
          {ruleRows.map((row, index) => <div className="permission-rule" key={row.id}>
            <div className="permission-rule-row">
              <label>Tool<select aria-label={`Rule ${index + 1} tool`} value={row.tool} disabled={busy} onChange={e => updateRuleRows(ruleRows.map(item => item.id === row.id ? { ...item, tool: e.target.value } : item))}>{RULE_TOOLS.map(tool => <option key={tool} value={tool}>{tool}</option>)}</select></label>
              <label>Decision<select aria-label={`Rule ${index + 1} decision`} value={row.decision} disabled={busy} onChange={e => updateRuleRows(ruleRows.map(item => item.id === row.id ? { ...item, decision: e.target.value as PermissionDecision } : item))}>{decisionLabels.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <button className="icon-button danger" type="button" disabled={busy} aria-label={`Remove rule ${index + 1}`} title="Remove rule" onClick={() => updateRuleRows(ruleRows.filter(item => item.id !== row.id))}><Trash2 size={15} /></button>
            </div>
            <label>Patterns<textarea className="code-input" rows={2} aria-label={`Rule ${index + 1} patterns`} value={row.patterns} disabled={busy} spellCheck={false} placeholder={'Optional · one per line · blank matches every call'} onChange={e => updateRuleRows(ruleRows.map(item => item.id === row.id ? { ...item, patterns: e.target.value } : item))} /></label>
            {ruleErrors[index] && <p className="error-text" role="alert">{ruleErrors[index]}</p>}
          </div>)}
          <div className="permission-rules-footer"><button className="text-button" type="button" disabled={busy || ruleRows.length >= PERMISSION_LIMITS.rules} onClick={() => updateRuleRows([...ruleRows, { id: crypto.randomUUID(), tool: 'bash', decision: 'ask', patterns: '' }])}><Plus size={14} />Add rule</button><span className="field-hint">{ruleRows.length} / {PERMISSION_LIMITS.rules} rules · {PERMISSION_LIMITS.patternsPerRule} patterns per rule · {PERMISSION_LIMITS.patternLength} characters per pattern</span></div>
          {ruleRows.length > PERMISSION_LIMITS.rules && <p className="error-text" role="alert">Use at most {PERMISSION_LIMITS.rules} permission rules.</p>}
        </>}
        <div className="quiet-callout"><ShieldCheck size={18} /><p>Pattern matching is a documented convenience, not a sandbox. A bash command containing shell control operators never auto-allows through a pattern rule unless the full command text matches.</p></div>
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
      {tab === 'usage' && (() => {
        // cached column only when SOME entry reported one: absence is a
        // provider that did not say, never a fabricated zero.
        const anyCached = Boolean(usage?.days.some(day => day.entries.some(entry => entry.cachedTokens !== undefined)));
        const format = (value?: number) => value === undefined ? '—' : value.toLocaleString('en-US');
        return <div className="form-stack"><div className="section-heading"><div><h3>Where the tokens went.</h3><p>Provider-reported usage, grouped by day and model.</p></div></div>
          <label>Window<select value={usageDays} disabled={usageLoading} onChange={e => setUsageDays(Number(e.target.value))}>{[7, 30, 90].map(value => <option key={value} value={value}>Last {value} days</option>)}</select></label>
          {usageLoading && <p className="field-hint" role="status">Loading recorded usage…</p>}
          {usageError && <div className="inline-alert" role="alert">{usageError}</div>}
          {!usageLoading && !usageError && usage && usage.days.length === 0 && <div className="empty-state"><Activity size={25} /><strong>No recorded usage</strong><p>Usage is recorded from provider-reported token counts as responses stream. Send a message and check back.</p></div>}
          {!usageLoading && !usageError && usage && usage.days.length > 0 && <>
            {usage.days.map(day => <section key={day.day} aria-label={`Usage on ${day.day}`}>
              <div className="mcp-cache-heading"><div><strong>{day.day}</strong></div></div>
              <div className="markdown-table"><table>
                <thead><tr><th>Provider / model</th><th>Input</th><th>Output</th>{anyCached && <th>Cached</th>}<th>Requests</th></tr></thead>
                <tbody>
                  {day.entries.map(entry => <tr key={`${entry.providerId}/${entry.model}`}><td><code>{entry.providerId}/{entry.model}</code></td><td>{format(entry.inputTokens)}</td><td>{format(entry.outputTokens)}</td>{anyCached && <td>{format(entry.cachedTokens)}</td>}<td>{format(entry.requests)}</td></tr>)}
                  <tr><td><strong>Day total</strong></td><td><strong>{format(day.totals.inputTokens)}</strong></td><td><strong>{format(day.totals.outputTokens)}</strong></td>{anyCached && <td><strong>{format(day.totals.cachedTokens)}</strong></td>}<td><strong>{format(day.totals.requests)}</strong></td></tr>
                </tbody>
              </table></div>
            </section>)}
            <p className="field-hint"><strong>Total ({usageDays} days):</strong> {format(usage.totals.inputTokens)} in · {format(usage.totals.outputTokens)} out{usage.totals.cachedTokens !== undefined ? ` · ${format(usage.totals.cachedTokens)} cached` : ''} · {format(usage.totals.requests)} requests</p>
          </>}
          <div className="quiet-callout"><ShieldCheck size={18} /><p>Token counts are provider-reported, exactly as streamed back. Costs are not computed — there is no rate card in this version, and guessing prices would be dishonest. Researcher (child) usage is included; deleting a session keeps its usage record.</p></div>
        </div>;
      })()}
      {(busy || testing) && <SpeedRail compact active />}
      {error && <div className="inline-alert" role="alert">{error}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={14} /></button></div>}
      {notice && <p className="success-note" role="status"><Check size={15} />{notice}</p>}
    </div></div>
    <footer className="modal-footer"><span>Local by default. Open by design.</span><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || testing || anyMcpAction || reviewLoading || rulesInvalid} onClick={() => save(true)}>Save settings<ChevronRight size={15} /></button></footer>
  </Modal>;
}
