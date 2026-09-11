/** @jsxImportSource @opentui/react */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { EditableProfile, ProfileCatalog, ProfileChoice, ProfileDetail, ProfileTool } from '../shared/profiles.js';
import type { Session, Settings } from '../shared/types.js';
import { TerminalController } from './controller.js';
import { Menu, TextPrompt, TextViewer, type MenuItem } from './ui.js';
import { ModelChooser } from './models.js';
import { SkillImporter } from './skillImport.js';

const toolNames: [ProfileTool, string][] = [['read_file', 'Read files'], ['glob', 'Find files'], ['grep', 'Search contents'], ['web_fetch', 'Read web pages'], ['write_file', 'Write files'], ['edit_file', 'Edit files'], ['bash', 'Run commands'], ['todo_read', 'Read task list'], ['todo_write', 'Update task list']];
function ProfileEditor({ controller, catalog, initial, settings, onClose, onSaved }: { controller: TerminalController; catalog: ProfileCatalog; initial: EditableProfile | null; settings: Settings; onClose: () => void; onSaved: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [draft, setDraft] = useState<EditableProfile>(initial ?? { id: '', name: '', tools: toolNames.map(([id]) => id) });
  const [view, setView] = useState('main'), [error, setError] = useState('');
  const back = () => setView('main');
  if (['name', 'id', 'description', 'instructions'].includes(view)) return <TextPrompt key={view} title={view === 'instructions' ? 'Profile instructions' : `Profile ${view}`} value={draft[view as 'name'] ?? ''} multiline={view === 'instructions'} onClose={back} onSave={value => { setDraft({ ...draft, [view]: value, ...(!initial && view === 'name' && (!draft.id || draft.id === draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) ? { id: value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) } : {}) }); back(); }} />;
  if (view === 'tools') return <Menu title="Available tools" search={false} onClose={back} footer="Profiles restrict tools; approvals and Plan mode still apply." items={toolNames.map(([id, name]) => ({ id, label: `${draft.tools.includes(id) ? '☑' : '☐'} ${name}`, action: () => setDraft({ ...draft, tools: draft.tools.includes(id) ? draft.tools.filter(tool => tool !== id) : [...draft.tools, id] }) }))} />;
  if (view === 'skills') return <Menu title="Recommended skills" onClose={back} items={catalog.skills.map(skill => ({ id: skill.id, label: `${draft.skills?.includes(skill.id) ? '☑' : '☐'} ${skill.name}`, description: skill.description, action: () => setDraft({ ...draft, skills: draft.skills?.includes(skill.id) ? draft.skills.filter(id => id !== skill.id) : [...(draft.skills ?? []), skill.id] }) }))} />;
  if (view === 'mode') return <Menu title="Default mode" search={false} onClose={back} items={['', 'plan', 'build'].map(mode => ({ id: mode || 'keep', label: mode || 'Keep current mode', action: () => { setDraft({ ...draft, defaultMode: mode as 'plan' | 'build' || undefined }); back(); } }))} />;
  if (view === 'model') return <ModelChooser controller={controller} settings={settings} title="Default model" value={draft.defaultModel ?? { providerId: settings.defaultProvider, model: settings.defaultModel }} onClose={back} onChange={route => { setDraft({ ...draft, defaultModel: route }); back(); }} />;
  const save = async () => {
    try {
      const ok = await controller.action('Saving profile', () => controller.client.api('/profiles/save', { workspace: catalog.workspace ?? controller.detail?.session.workspace, catalogRevision: catalog.revision, create: !initial, profile: { ...draft, name: draft.name.trim() } }));
      if (ok) onSaved(); else setError(controller.getState().notice);
    } catch (error) { setError((error as Error).message); }
  };
  return <Menu title={initial ? 'Edit profile' : 'New profile'} search={false} onClose={onClose} footer={error || 'Reusable project instructions · Save, then apply to a session'} items={[
    { id: 'name', label: `Name: ${draft.name || 'Choose a name'}`, action: () => setView('name') },
    { id: 'description', label: 'Description', description: draft.description || 'When should this profile be used?', action: () => setView('description') },
    { id: 'instructions', label: 'Instructions', description: draft.instructions?.slice(0, 100) || 'How should the agent approach work?', action: () => setView('instructions') },
    { id: 'id', label: `Profile ID: ${draft.id || 'Generated from name'}`, disabled: Boolean(initial), action: () => setView('id') },
    { id: 'tools', separatorBefore: true, label: `Available tools: ${draft.tools.length}`, description: 'Named profiles disable delegation and connected tools.', action: () => setView('tools') },
    { id: 'mode', label: `Default mode: ${draft.defaultMode || 'Keep current mode'}`, action: () => setView('mode') },
    { id: 'model', label: `Default model: ${draft.defaultModel?.model || 'Keep current model'}`, action: () => setView('model') },
    ...(draft.defaultModel ? [{ id: 'clear-model', label: 'Remove default model', action: () => setDraft({ ...draft, defaultModel: undefined }) }] : []),
    { id: 'skills', label: `Recommended skills: ${draft.skills?.length ?? 0}`, action: () => setView('skills') },
    { id: 'save', separatorBefore: true, label: 'Save profile', disabled: Boolean(state.pending) || !draft.name.trim() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(draft.id), action: () => { void save(); } },
  ]} />;
}

export function Profiles({ controller, initial, onClose, skillsOnly = false, onCatalog }: { controller: TerminalController; initial: Session; skillsOnly?: boolean; onCatalog?: (catalog: ProfileCatalog) => void; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState), [catalog, setCatalog] = useState<ProfileCatalog | null>(null);
  const [choice, setChoice] = useState<ProfileChoice>({ profileId: initial.profile?.profileId ?? null, skillIds: initial.profile?.skillIds ?? [] });
  const [editing, setEditing] = useState<{ profile: EditableProfile | null } | null>(null), [revision, setRevision] = useState(0);
  const [view, setView] = useState('main'), [preview, setPreview] = useState<ProfileDetail | null>(null), [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [active, setActive] = useState<ProfileDetail | null>(null);
  const back = () => setView('main');
  useEffect(() => { let live = true; Promise.all([controller.client.api<ProfileCatalog>(`/profiles?workspace=${encodeURIComponent(initial.workspace)}`), controller.client.api<ProfileDetail>(`/sessions/${encodeURIComponent(initial.id)}/profile`)]).then(([catalog, active]) => { if (live) { setCatalog(catalog); setActive(active); onCatalog?.(catalog); } }).catch(error => { if (live) setError(error.message); }); return () => { live = false; }; }, [revision]);
  const run = async (operation: () => Promise<unknown>) => { setError(''); try { await operation(); } catch (error) { setError((error as Error).message); } };
  if (!catalog) return <TextViewer title="Project profiles" text={error || 'Loading project profiles…'} onClose={onClose} />;
  if (editing && state.settings) return <ProfileEditor controller={controller} catalog={catalog} settings={state.settings} initial={editing.profile} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setRevision(value => value + 1); }} />;
  const profile = catalog.profiles.find(item => item.id === choice.profileId);
  if (view === 'skills') return <Menu title="Skills for this session" onClose={back} items={catalog.skills.map(skill => ({ id: skill.id, label: `${choice.skillIds.includes(skill.id) ? '☑' : '☐'} ${skill.name}`, description: skill.description, action: () => setChoice({ ...choice, skillIds: choice.skillIds.includes(skill.id) ? choice.skillIds.filter(id => id !== skill.id) : [...choice.skillIds, skill.id] }) }))} />;
  if (view === 'preview') return <TextViewer title="Profile preview" text={preview ? [preview.pinned?.instructions || 'No profile instructions.', ...(preview.pinned?.skills ?? []).map(skill => `${skill.name}\n${skill.body}`), ...preview.diagnostics.map(item => `${item.path}: ${item.message}`)].join('\n\n') : error || 'Loading preview…'} onClose={back} />;
  const apply = async (defaults: boolean) => {
    controller.configurationReady();
    if (controller.sessionId !== initial.id) throw new Error('Session changed. Reopen /skills.');
    if (await controller.action('Applying profile', () => controller.client.api(`/sessions/${encodeURIComponent(initial.id)}/profile`, { expectedConfigRevision: initial.configRevision ?? 0, choice: { ...choice, catalogRevision: catalog.revision }, ...(defaults && profile ? { selection: { ...profile.defaultModel, ...(profile.defaultMode ? { mode: profile.defaultMode } : {}) } } : {}) }))) onClose();
    else setError(controller.getState().notice);
  };
  if (skillsOnly && importing) return <SkillImporter controller={controller} workspace={initial.workspace} onClose={() => setImporting(false)} onImported={() => setRevision(value => value + 1)} />;
  if (skillsOnly) return <Menu title="Skills for this session" onClose={onClose} footer={error || (active?.source.status !== 'current' && active?.source.status !== 'inactive' ? `Pinned source is ${active?.source.status}. Preview before applying. ` : '') + (catalog.diagnostics.map(item => item.message).join(' · ') || 'Select up to 8. Apply reloads selected instructions; model, mode, and profile selection stay unchanged.')} items={[
    ...catalog.skills.map(skill => ({ id: `skill:${skill.id}`, label: `${choice.skillIds.includes(skill.id) ? '☑' : '☐'} ${skill.name}`, description: `/${skill.id} · ${skill.description}`, disabled: !choice.skillIds.includes(skill.id) && choice.skillIds.length >= 8, action: () => setChoice({ ...choice, skillIds: choice.skillIds.includes(skill.id) ? choice.skillIds.filter(id => id !== skill.id) : [...choice.skillIds, skill.id] }) })),
    ...choice.skillIds.filter(id => !catalog.skills.some(skill => skill.id === id)).map(id => ({ id: `missing:${id}`, label: `☑ ${id} (source unavailable; remove)`, action: () => setChoice({ ...choice, skillIds: choice.skillIds.filter(value => value !== id) }) })),
    ...(!catalog.skills.length ? [{ id: 'empty', label: 'No project skills found', description: 'Add skills to .litespeed/profiles.json and .litespeed/skills/<id>/SKILL.md', disabled: true, action: () => {} }] : []),
    { id: 'preview', label: 'Preview instructions', action: () => { setView('preview'); setPreview(null); void run(async () => setPreview(await controller.client.api<ProfileDetail>('/profiles/preview', { workspace: initial.workspace, choice: { ...choice, catalogRevision: catalog.revision } }))); } },
    { id: 'apply', label: 'Use skills', disabled: Boolean(state.pending), action: () => { void run(() => apply(false)); } },
    { id: 'import-skill', separatorBefore: true, label: 'Import a Claude/Codex skill…', action: () => setImporting(true) },
    { id: 'refresh', label: 'Refresh catalog', action: () => setRevision(value => value + 1) },
  ]} />;
  const items: MenuItem[] = [
    { id: 'off', label: `${!choice.profileId ? '●' : '○'} No profile`, description: 'Use the standard tool set and project guidance', action: () => setChoice({ ...choice, profileId: null }) },
    ...catalog.profiles.map(item => ({ id: item.id, label: `${choice.profileId === item.id ? '●' : '○'} ${item.name}`, description: item.description, action: () => setChoice({ ...choice, profileId: item.id }) })),
    { id: 'skills', separatorBefore: true, label: `Selected skills: ${choice.skillIds.length}`, description: 'Skills are chosen explicitly for this session.', action: () => setView('skills') },
    { id: 'preview', label: 'Preview instructions', action: () => { setView('preview'); setPreview(null); void run(async () => setPreview(await controller.client.api<ProfileDetail>('/profiles/preview', { workspace: initial.workspace, choice: { ...choice, catalogRevision: catalog.revision } }))); } },
    { id: 'apply', label: 'Apply to this session', disabled: Boolean(state.pending), action: () => { void run(() => apply(false)); } },
    ...(profile?.defaultModel || profile?.defaultMode ? [{ id: 'defaults', label: 'Apply with recommended model and mode', action: () => { void run(() => apply(true)); } }] : []),
    { id: 'create', separatorBefore: true, label: '+ Create profile', action: () => setEditing({ profile: null }) },
    ...(profile ? [{ id: 'edit', label: `Edit ${profile.name}`, action: () => { void run(async () => { const result = await controller.client.api<{ profile: EditableProfile; catalogRevision: string }>(`/profiles/edit?workspace=${encodeURIComponent(initial.workspace)}&id=${encodeURIComponent(profile.id)}`); setCatalog({ ...catalog, revision: result.catalogRevision }); setEditing({ profile: result.profile }); }); } }] : []),
    { id: 'refresh', label: 'Reload project profiles', description: active?.source.status && active.source.status !== 'current' && active.source.status !== 'inactive' ? `Active profile source is ${active.source.status}. Reapply to use changes.` : undefined, action: () => setRevision(value => value + 1) },
  ];
  return <Menu title="Project profiles" onClose={onClose} items={items} footer={error || catalog.diagnostics.map(item => `${item.path}: ${item.message}`).join(' · ') || 'Select a profile, review its instructions, then apply.'} />;
}
