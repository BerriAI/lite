import { useEffect, useState } from 'react';
import type { EditableProfile, ProfileCatalog, ProfileTool } from '../../shared/profiles';
import { api, errorMessage, post, query } from './api';
import { SpeedRail } from './ui';

const toolNames: [ProfileTool, string][] = [['read_file', 'Read files'], ['glob', 'Find files'], ['grep', 'Search contents'], ['web_fetch', 'Read web pages'], ['write_file', 'Write files'], ['edit_file', 'Edit files'], ['bash', 'Run commands'], ['todo_read', 'Read task list'], ['todo_write', 'Update task list']];

export function ProfileEditor({ workspace, id, catalog, onCancel, onSaved }: { workspace: string; id: string | null; catalog: ProfileCatalog; onCancel: () => void; onSaved: (id: string) => void }) {
  const [draft, setDraft] = useState<EditableProfile>({ id: '', name: '', description: '', instructions: '', tools: toolNames.map(([tool]) => tool) });
  const [revision, setRevision] = useState(catalog.revision);
  const [loading, setLoading] = useState(Boolean(id)), [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    if (id) api<{ profile: EditableProfile; catalogRevision: string }>(`/profiles/edit?${query({ workspace, id })}`)
      .then(result => { if (live) { setDraft(result.profile); setRevision(result.catalogRevision); } })
      .catch(error => { if (live) setError(errorMessage(error)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [workspace, id]);
  async function save() {
    if (loading || saving) return;
    setSaving(true); setError('');
    try { await post('/profiles/save', { workspace, catalogRevision: revision, create: !id, profile: { ...draft, name: draft.name.trim() } }); onSaved(draft.id); }
    catch (error) { setError(errorMessage(error)); }
    finally { setSaving(false); }
  }
  return <section className="profile-editor" aria-label={id ? 'Edit project profile' : 'New project profile'}>
    <div className="section-heading"><div><h3>{id ? 'Edit profile' : 'New profile'}</h3><p>Save reusable instructions for this project, then choose when to apply them.</p></div></div>
    {loading && <SpeedRail compact active />}
    {error && <div className="inline-alert" role="alert">{error}</div>}
    <fieldset className="form-stack" disabled={loading || saving}>
      <label>Name<input aria-label="Profile name" value={draft.name} maxLength={200} onChange={event => setDraft({ ...draft, name: event.target.value, ...(!id && (!draft.id || draft.id === draft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)) ? { id: event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) } : {}) })} placeholder="e.g. Code reviewer" /></label>
      <label>Description<input aria-label="Profile description" value={draft.description ?? ''} maxLength={2000} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder="A short reminder of when to use this profile" /></label>
      <label>Instructions<textarea aria-label="Profile instructions" rows={7} value={draft.instructions ?? ''} onChange={event => setDraft({ ...draft, instructions: event.target.value })} placeholder="How should the agent approach work in this project?" /></label>
      <details className="profile-editor-options"><summary>Tools and defaults</summary>
        <div className="form-stack">
          <label>Profile ID<input aria-label="Profile ID" disabled={Boolean(id)} value={draft.id} pattern="[a-z0-9][a-z0-9-]{0,63}" onChange={event => setDraft({ ...draft, id: event.target.value })} /></label>
          <fieldset className="profile-tool-options"><legend>Available tools</legend>{toolNames.map(([tool, name]) => <label key={tool}><input type="checkbox" checked={draft.tools.includes(tool)} onChange={event => setDraft({ ...draft, tools: event.target.checked ? [...draft.tools, tool] : draft.tools.filter(value => value !== tool) })} />{name}</label>)}</fieldset>
          <p className="field-hint">Profiles restrict built-in tools. Named profiles also disable delegation and connected tools; Plan mode and approvals still apply.</p>
          <label>Default mode<select aria-label="Profile default mode" value={draft.defaultMode ?? ''} onChange={event => setDraft({ ...draft, defaultMode: event.target.value as 'plan' | 'build' || undefined })}><option value="">Keep current mode</option><option value="plan">Plan</option><option value="build">Build</option></select></label>
          <label className="profile-default-toggle"><input type="checkbox" checked={Boolean(draft.defaultModel)} onChange={event => setDraft({ ...draft, defaultModel: event.target.checked ? { providerId: '', model: '' } : undefined })} />Include a default model</label>
          {draft.defaultModel && <div className="form-columns"><label>Provider ID<input aria-label="Profile default provider" value={draft.defaultModel.providerId} onChange={event => setDraft({ ...draft, defaultModel: { ...draft.defaultModel!, providerId: event.target.value } })} /></label><label>Model ID<input aria-label="Profile default model" value={draft.defaultModel.model} onChange={event => setDraft({ ...draft, defaultModel: { ...draft.defaultModel!, model: event.target.value } })} /></label></div>}
          {Boolean(catalog.skills.length) && <fieldset className="profile-tool-options"><legend>Recommend skills</legend>{catalog.skills.map(skill => <label key={skill.id}><input type="checkbox" checked={draft.skills?.includes(skill.id) ?? false} onChange={event => setDraft({ ...draft, skills: event.target.checked ? [...(draft.skills ?? []), skill.id] : draft.skills?.filter(id => id !== skill.id) })} />{skill.name}</label>)}</fieldset>}
        </div>
      </details>
      <div className="profile-editor-actions"><button className="button secondary" onClick={onCancel}>Cancel edit</button><button className="button primary" disabled={!draft.name.trim() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(draft.id)} onClick={() => void save()}>{saving ? 'Saving…' : 'Save profile'}</button></div>
    </fieldset>
  </section>;
}
