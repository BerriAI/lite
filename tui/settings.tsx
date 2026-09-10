/** @jsxImportSource @opentui/react */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PermissionRule, PermissionRuleSet } from '../shared/permissions.js';
import type { McpServerStatus } from '../shared/mcp.js';
import type { MemoryFactSummary } from '../shared/memory.js';
import type { Settings, UsageReport } from '../shared/types.js';
import { TerminalController } from './controller.js';
import { Menu, TextPrompt, TextViewer } from './ui.js';
import { Providers } from './providers.js';
import { Profiles } from './profiles.js';

function Rules({ initial, onSave, onClose, feedback }: { initial: PermissionRuleSet | undefined; onSave: (rules: PermissionRuleSet) => void; onClose: () => void; feedback: string }) {
  const [rules, setRules] = useState(initial?.rules ?? []), [index, setIndex] = useState<number | null>(null), [view, setView] = useState('main');
  const tools = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash', 'web_fetch', 'todo_read', 'todo_write', 'task'];
  const rule = index === null ? null : rules[index];
  const update = (patch: Partial<PermissionRule>) => setRules(rules.map((rule, offset) => offset === index ? { ...rule, ...patch } : rule));
  if (view === 'tool') return <Menu title="Tool" onClose={() => setView('main')} items={tools.map(tool => ({ id: tool, label: tool, action: () => { if (index === null) { setRules([...rules, { tool, decision: 'ask' }]); setIndex(rules.length); } else update({ tool }); setView('main'); } }))} />;
  if (view === 'patterns' && rule) return <TextPrompt title="Patterns (one per line)" multiline value={rule.patterns?.join('\n') ?? ''} placeholder="Leave empty to match every call of this tool" onClose={() => setView('main')} onSave={value => { update({ patterns: value.split('\n').map(item => item.trim()).filter(Boolean) }); setView('main'); }} />;
  if (view === 'decision') return <Menu title="Decision" search={false} onClose={() => setView('main')} items={(['ask', 'allow', 'deny'] as const).map(decision => ({ id: decision, label: decision, action: () => { update({ decision }); setView('main'); } }))} />;
  if (rule) return <Menu title="Edit permission rule" search={false} onClose={() => setIndex(null)} items={[
    { id: 'tool', label: `Tool: ${rule.tool}`, action: () => setView('tool') },
    { id: 'decision', label: `Decision: ${rule.decision}`, action: () => setView('decision') },
    { id: 'patterns', label: 'Patterns', description: rule.patterns?.join(', ') || 'Every call of this tool', action: () => setView('patterns') },
    { id: 'remove', label: 'Remove rule', action: () => { setRules(rules.filter((_, offset) => offset !== index)); setIndex(null); } },
    { id: 'done', label: 'Done', action: () => setIndex(null) },
  ]} />;
  return <Menu title="Permission rules" onClose={onClose} footer={feedback || 'Deny wins. Rules cannot enable tools excluded by Plan or profiles.'} items={[
    { id: 'new', label: '+ Add rule', action: () => setView('tool') },
    ...rules.map((rule, index) => ({ id: String(index), label: `${rule.decision} · ${rule.tool}`, description: rule.patterns?.join(', ') || 'Every call', action: () => setIndex(index) })),
    { id: 'save', label: 'Save rules', separatorBefore: true, action: () => onSave({ version: 1, rules }) },
  ]} />;
}

type McpSnapshot = { servers: McpServerStatus[]; configRevision: string };
export function SettingsPanel({ controller, onClose }: { controller: TerminalController; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState), settings = state.settings;
  const [view, setView] = useState('main'), [feedback, setFeedback] = useState('');
  const [memory, setMemory] = useState<MemoryFactSummary[]>([]), [mcp, setMcp] = useState<McpSnapshot | null>(null), [review, setReview] = useState<McpServerStatus | null>(null);
  const [usage, setUsage] = useState<UsageReport | null>(null), [days, setDays] = useState(30), [grants, setGrants] = useState<string[]>([]);
  const back = () => { setView('main'); setFeedback(''); };
  const run = async (operation: () => Promise<unknown>) => { setFeedback(''); try { await operation(); } catch (error) { setFeedback((error as Error).message); } };
  const save = async (patch: Record<string, unknown>, next = 'main') => {
    if (await controller.action('Saving settings', async () => { await controller.client.api('/settings', patch, 'PATCH'); await controller.settings(); })) { setFeedback('Saved.'); setView(next); }
    else setFeedback(controller.getState().notice);
  };
  const workspace = controller.detail?.session.workspace ?? settings?.workspace ?? '';
  const refreshMemory = async () => setMemory((await controller.client.api<{ facts: MemoryFactSummary[] }>(`/memory?workspace=${encodeURIComponent(workspace)}`)).facts);
  useEffect(() => {
    let live = true;
    if (view === 'integrations') controller.client.api<McpSnapshot>('/mcp').then(value => { if (live) setMcp(value); }).catch(error => { if (live) setFeedback(error.message); });
    if (view === 'memory') void run(refreshMemory);
    if (view === 'usage') { setUsage(null); controller.client.api<UsageReport>(`/usage?days=${days}`).then(value => { if (live) setUsage(value); }).catch(error => { if (live) setFeedback(error.message); }); }
    if (view === 'permissions') controller.client.api<{ tools: string[] }>(controller.path('/tool-grants')).then(value => { if (live) setGrants(value.tools); }).catch(error => { if (live) setFeedback(error.message); });
    return () => { live = false; };
  }, [view, days]);
  if (!settings) return <TextViewer title="Settings" text={state.notice || 'Loading settings…'} onClose={onClose} />;
  if (view === 'providers') return <Providers controller={controller} onClose={back} />;
  if (view === 'profiles' && controller.detail) return <Profiles controller={controller} initial={controller.detail.session} onClose={back} />;
  if (view === 'rules') return <Rules initial={settings.permissionRules} onClose={() => setView('permissions')} feedback={feedback} onSave={rules => { void run(() => save({ permissionRules: rules }, 'permissions')); }} />;
  if (view === 'workspace' || view === 'steps') return <TextPrompt title={view === 'workspace' ? 'Default workspace for new sessions' : 'Maximum steps per turn'} value={view === 'workspace' ? settings.workspace : String(settings.maxSteps)} error={feedback} onClose={() => setView('general')} onSave={value => { void run(() => save(view === 'workspace' ? { workspace: value } : { maxSteps: Number(value) }, 'general')); }} />;
  if (view === 'mcp-config') return <TextPrompt title="MCP configuration" multiline value={JSON.stringify(settings.mcpServers, null, 2)} error={feedback} onClose={() => setView('integrations')} onSave={value => { void run(() => save({ mcpServers: JSON.parse(value), expectedMcpConfigRevision: settings.mcpConfigRevision }, 'integrations')); }} />;
  if (view === 'integrations' && review) {
    const config = settings.mcpServers[review.name];
    const connect = async (action: 'reconnect' | 'refresh') => {
      if (await controller.action('Connecting tools', () => controller.client.api(`/mcp/${encodeURIComponent(review.name)}/${action}`, { expectedRevision: review.revision, expectedConfigRevision: mcp!.configRevision }))) { setReview(null); setMcp(await controller.client.api<McpSnapshot>('/mcp')); }
      else setFeedback(controller.getState().notice);
    };
    return <Menu title={`Review integration · ${review.name}`} search={false} onClose={() => setReview(null)} footer={feedback || (config?.url ? 'Connecting contacts this configured endpoint.' : 'Connecting runs this server with the listed environment.')} items={[
      { id: 'config', label: config?.url || `${config?.command ?? ''} ${(config?.args ?? []).join(' ')}`, description: `Environment: ${Object.keys(config?.env ?? {}).join(', ') || 'none configured'}`, disabled: true, action() {} },
      { id: 'tools', label: `${review.tools.length} cached tools`, description: review.tools.map(tool => tool.remoteName).join(', '), disabled: true, action() {} },
      { id: 'connect', label: 'Connect / reconnect', disabled: Boolean(state.pending) || config?.enabled === false, action: () => { void run(() => connect('reconnect')); } },
      { id: 'refresh', label: 'Refresh tool definitions', disabled: Boolean(state.pending) || config?.enabled === false, action: () => { void run(() => connect('refresh')); } },
      { id: 'toggle', label: config?.enabled === false ? 'Enable configuration' : 'Disable integration', action: () => { void run(async () => { await save({ mcpServers: { ...settings.mcpServers, [review.name]: { ...config, enabled: config?.enabled === false } }, expectedMcpConfigRevision: settings.mcpConfigRevision }, 'integrations'); setReview(null); setMcp(await controller.client.api<McpSnapshot>('/mcp')); }); } },
    ]} />;
  }
  if (view === 'integrations') return <Menu title="Integrations" onClose={back} footer={feedback || 'Review configuration before connecting a tool server.'} items={[
    { id: 'edit', label: 'Edit MCP configuration', description: 'JSON server definitions, as in web Settings', action: () => setView('mcp-config') },
    ...(mcp?.servers ?? []).map(server => ({ id: server.name, label: `${server.name} · ${server.status}`, description: server.error || `${server.tools.length} tools`, action: () => setReview(server) })),
    { id: 'refresh', label: 'Reload status', action: () => { void run(async () => { await controller.settings(); setMcp(await controller.client.api<McpSnapshot>('/mcp')); }); } },
  ]} />;
  if (view === 'permissions') return <Menu title="Permissions" search={false} onClose={back} footer={feedback || 'Project rules, Plan mode, and profile limits still apply.'} items={[
    { id: 'ask', label: `${controller.detail?.session.permissionMode === 'ask' ? '●' : '○'} Ask before actions`, action: () => { void run(async () => { await controller.permissionMode('ask'); }); } },
    { id: 'auto', label: `${controller.detail?.session.permissionMode === 'auto' ? '●' : '○'} Allow all tools`, description: 'This session and its workers; explicit ask/deny rules still apply', action: () => { void run(async () => { await controller.permissionMode('auto'); }); } },
    { id: 'default', label: `New session default: ${settings.permissionMode === 'auto' ? 'Allow all tools' : 'Ask first'}`, action: () => { void run(() => save({ permissionMode: settings.permissionMode === 'ask' ? 'auto' : 'ask' }, 'permissions')); } },
    { id: 'rules', separatorBefore: true, label: 'App permission rules', description: `${settings.permissionRules?.rules.length ?? 0} explicit rules`, action: () => setView('rules') },
    { id: 'grants', label: 'Clear “Always” approvals for this session', description: grants.join(', ') || 'No saved tool approvals', action: () => { void run(async () => { if (await controller.action('Clearing approvals', () => controller.client.api(controller.path('/tool-grants'), undefined, 'DELETE'))) setGrants([]); }); } },
  ]} />;
  if (view === 'memory') return <Menu title="Project memory" onClose={() => setView('general')} footer={feedback || 'Select a fact to pin/unpin. Use Forget to remove it.'} items={[
    ...memory.flatMap(fact => [
      { id: fact.id, label: `${fact.pinned ? '◆ ' : ''}${fact.name}`, description: fact.description, action: () => { void run(async () => { await controller.client.api(`/memory/${encodeURIComponent(fact.name)}?workspace=${encodeURIComponent(workspace)}`, { pinned: !fact.pinned }, 'PATCH'); await refreshMemory(); }); } },
      { id: `${fact.id}:forget`, label: `Forget ${fact.name}`, action: () => { void run(async () => { await controller.client.api(`/memory/${encodeURIComponent(fact.name)}?workspace=${encodeURIComponent(workspace)}`, undefined, 'DELETE'); await refreshMemory(); }); } },
    ]),
    { id: 'refresh', label: memory.length ? 'Reload facts' : 'No recorded facts · Reload', action: () => { void run(refreshMemory); } },
  ]} />;
  if (view === 'usage') return <Menu title="Recorded usage" onClose={back} search={false} footer={feedback || 'Only usage reported by providers is counted.'} items={[
    { id: 'days', label: `Period: ${days} days`, action: () => setDays(days === 30 ? 7 : days === 7 ? 90 : 30) },
    { id: 'totals', label: usage ? `${usage.totals.requests} requests` : 'Loading usage…', description: usage ? `${usage.totals.inputTokens} input tokens · ${usage.totals.outputTokens} output tokens` : '', disabled: true, action() {} },
    ...(usage?.days ?? []).map(day => ({ id: day.day, label: day.day, description: `${day.totals.requests} requests · ${day.totals.inputTokens} in · ${day.totals.outputTokens} out`, disabled: true, action() {} })),
  ]} />;
  if (view === 'general') return <Menu title="General" search={false} onClose={back} footer={feedback || 'Workspace and defaults apply to new sessions.'} items={[
    { id: 'workspace', label: 'Default workspace', description: settings.workspace, action: () => setView('workspace') },
    { id: 'steps', label: `Maximum steps: ${settings.maxSteps}`, action: () => setView('steps') },
    { id: 'memory', label: `Memory: ${settings.memoryEnabled ? 'On' : 'Off'}`, action: () => { void run(() => save({ memoryEnabled: !settings.memoryEnabled }, 'general')); } },
    { id: 'facts', label: 'Manage project memory', action: () => setView('memory') },
    { id: 'notifications', label: `Notifications: ${settings.notifications ? 'On' : 'Off'}`, action: () => { void run(() => save({ notifications: !settings.notifications }, 'general')); } },
  ]} />;
  return <Menu title="Settings" onClose={onClose} search={false} items={[
    { id: 'providers', label: 'Providers', description: 'API connections and ChatGPT sign-in', action: () => setView('providers') },
    { id: 'general', label: 'General', description: 'Workspace, defaults, memory, and notifications', action: () => setView('general') },
    { id: 'permissions', label: 'Permissions', description: 'Approval mode, rules, and saved tool approvals', action: () => setView('permissions') },
    { id: 'profiles', label: 'Project profiles', description: 'Create, edit, preview, and apply project instructions', action: () => setView('profiles') },
    { id: 'integrations', label: 'Integrations', description: 'Configure and connect MCP tools', action: () => setView('integrations') },
    { id: 'usage', label: 'Usage', description: 'Recorded requests and tokens', action: () => setView('usage') },
  ]} />;
}
