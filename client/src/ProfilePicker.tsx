import { useEffect, useRef, useState } from 'react';
import type { ApplyProfileRequest, ProfileCatalog, ProfileChoice, ProfileDetail, ProfileDiagnostic, ProfileTool } from '../../shared/profiles';
import type { Selection } from './Composer';
import { api, errorMessage, post, query } from './api';
import { Modal, LiteSpeed } from './ui';
import { ProfileEditor } from './ProfileEditor';

const tools: ProfileTool[] = ['read_file', 'glob', 'grep', 'web_fetch', 'write_file', 'edit_file', 'bash', 'todo_read', 'todo_write'];
const emptyChoice = (): ProfileChoice => ({ profileId: null, skillIds: [] });
const sameChoice = (a: ProfileChoice, b: ProfileChoice) => a.profileId === b.profileId && [...a.skillIds].sort().join(',') === [...b.skillIds].sort().join(',');
type Defaults = ApplyProfileRequest['selection'];
export interface ProfilePickerProps {
  workspace: string; sessionId: string | null; initialChoice?: ProfileChoice; selection: Selection;
  disabled?: boolean; embedded?: boolean; onClose: () => void;
  onApply: (choice: ProfileChoice, defaults?: Defaults) => Promise<void>;
}
function Diagnostics({ items }: { items: ProfileDiagnostic[] }) {
  return items.length ? <div className="profile-diagnostics" role="status"><strong>Project configuration needs attention</strong><ul>{items.map((item, index) => <li key={`${item.path}-${item.code}-${index}`}><code>{item.path}</code> · {item.message}</li>)}</ul></div> : null;
}
function Instructions({ detail, label }: { detail: ProfileDetail; label: string }) {
  if (!detail.pinned) return null;
  return <section className="profile-instructions" aria-label={label}><h3>{label}</h3><pre>{detail.pinned.instructions || 'No additional profile instructions.'}</pre>{detail.pinned.skills.map(skill => <details key={skill.id}><summary>{skill.name} · skill instructions</summary><pre>{skill.body}</pre></details>)}</section>;
}
export function ProfilePicker({ workspace, sessionId, initialChoice, selection, disabled, embedded, onClose, onApply }: ProfilePickerProps) {
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [savedNotice, setSavedNotice] = useState('');
  const [choice, setChoice] = useState<ProfileChoice>(() => initialChoice ?? emptyChoice());
  const original = useRef(initialChoice ?? emptyChoice());
  const [catalog, setCatalog] = useState<ProfileCatalog | null>(null);
  const [active, setActive] = useState<ProfileDetail | null>(null);
  const [preview, setPreview] = useState<ProfileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [reload, setReload] = useState(0);
  const applying = useRef(false), alive = useRef(true), generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setCatalog(null); setPreview(null);
    void Promise.all([
      api<ProfileCatalog>(`/profiles?${query({ workspace })}`),
      sessionId ? api<ProfileDetail>(`/sessions/${sessionId}/profile`) : Promise.resolve(null),
    ]).then(([nextCatalog, nextActive]) => {
      if (live) { setCatalog(nextCatalog); setActive(nextActive); }
    }).catch(e => { if (live) setError(errorMessage(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [workspace, sessionId, reload]);
  const choiceKey = JSON.stringify([choice.profileId, choice.skillIds]);
  useEffect(() => {
    const request = ++generation.current;
    setPreview(null); setPreviewError('');
    if (!catalog || loading) { setPreviewing(false); return; }
    if (!choice.profileId && !choice.skillIds.length) { setPreviewing(false); return; }
    setPreviewing(true);
    void post<ProfileDetail>('/profiles/preview', { workspace, choice: { ...choice, catalogRevision: catalog.revision } })
      .then(value => { if (alive.current && generation.current === request) setPreview(value); })
      .catch(e => { if (alive.current && generation.current === request) setPreviewError(errorMessage(e)); })
      .finally(() => { if (alive.current && generation.current === request) setPreviewing(false); });
    return () => { generation.current++; };
  }, [workspace, catalog, loading, choiceKey]);
  const profile = catalog?.profiles.find(value => value.id === choice.profileId);
  const selected = Boolean(choice.profileId || choice.skillIds.length);
  const unavailable = Boolean(choice.profileId && !profile) || choice.skillIds.some(id => !catalog?.skills.some(skill => skill.id === id));
  const blocked = Boolean(disabled || saving);
  const ready = !blocked && !loading && !previewing && !unavailable && (!selected || Boolean(preview));
  const defaults: Defaults = profile ? { ...(profile.defaultModel ?? {}), ...(profile.defaultMode ? { mode: profile.defaultMode } : {}) } : undefined;
  const hasDefaults = Boolean(profile?.defaultModel || profile?.defaultMode);
  const excluded = profile ? tools.filter(tool => !profile.tools.includes(tool)) : [];
  const knownSkills = catalog?.skills ?? [];
  const missingSkills = choice.skillIds.filter(id => !knownSkills.some(skill => skill.id === id));
  function change(next: ProfileChoice) {
    if (blocked || applying.current) return;
    generation.current++; setPreview(null); setPreviewError(''); setChoice(next);
  }
  async function apply(next: ProfileChoice, applyDefaults?: Defaults) {
    if (blocked || applying.current) return;
    applying.current = true; setSaving(true); setError('');
    try { await onApply(next, applyDefaults); }
    catch (e) { if (alive.current) setError(`${errorMessage(e)} Close and reopen Project profiles to review the latest session configuration before trying again.`); }
    finally { applying.current = false; if (alive.current) setSaving(false); }
  }
  const content = editing && catalog ? <ProfileEditor workspace={workspace} id={editing.id} catalog={catalog} onCancel={() => setEditing(null)} onSaved={id => { setEditing(null); change({ profileId: id, skillIds: [] }); setSavedNotice('Profile saved. Choose Use profile to apply it to this session.'); setReload(value => value + 1); }} /> : <div className="profile-picker">
      <div className="section-heading"><div><h3>Project profiles</h3><p>Reusable instructions and tool limits for this project. Choose a profile for this session, or create your own.</p></div></div>
      {savedNotice && <p className="success-note" role="status">{savedNotice}</p>}
      {loading && <LiteSpeed active compact />}
      {error && <div className="inline-alert" role="alert">{error}</div>}
      {active?.active && <section className="profile-active" aria-label="Active profile"><strong>Active · {active.active.name || (active.active.profileId ?? 'Skills only')}</strong>{active.source.status !== 'current' && <p className="profile-warning" role="status">Project source is {active.source.status}. The pinned snapshot remains active; source changes are not applied automatically.</p>}<details><summary>Active pinned instructions</summary><Instructions detail={active} label="Pinned snapshot" /></details></section>}
      <Diagnostics items={(catalog?.diagnostics ?? []).filter(item => selected || active?.active || item.code !== 'missing')} />
      <Diagnostics items={active?.diagnostics ?? []} />
      <label className="profile-select">Profile<select aria-label="Profile" value={choice.profileId ?? ''} disabled={blocked || loading} onChange={event => change({ profileId: event.target.value || null, skillIds: [] })}><option value="">Default</option>{catalog?.profiles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}{choice.profileId && !profile && <option value={choice.profileId}>{initialChoice?.profileId === choice.profileId && active?.active?.name || choice.profileId} · source unavailable</option>}</select></label>
      <div className="profile-manage-actions"><button className="text-button" disabled={blocked || loading} onClick={() => setEditing({ id: null })}>New profile</button>{profile && <button className="text-button" disabled={blocked || loading} onClick={() => setEditing({ id: profile.id })}>Edit profile</button>}</div>
      {profile?.description && <p className="field-hint">{profile.description}</p>}
      <fieldset className="profile-skills" disabled={blocked || loading}><legend>Skills <span>Choose up to 8</span></legend>{knownSkills.length || missingSkills.length ? <div>{knownSkills.map(skill => <label key={skill.id}><input type="checkbox" aria-label={skill.name} checked={choice.skillIds.includes(skill.id)} disabled={!choice.skillIds.includes(skill.id) && choice.skillIds.length >= 8} onChange={event => change({ ...choice, skillIds: event.target.checked ? [...choice.skillIds, skill.id] : choice.skillIds.filter(id => id !== skill.id) })} /><span><strong>{skill.name}</strong>{profile?.skills?.includes(skill.id) && <small className="profile-recommendation">Recommended · optional</small>}<small>{skill.description}</small></span></label>)}{missingSkills.map(id => <label key={id}><input type="checkbox" aria-label={id} checked onChange={() => change({ ...choice, skillIds: choice.skillIds.filter(value => value !== id) })} /><span>{id}<small>Source unavailable · uncheck to remove</small></span></label>)}</div> : <p className="field-hint">No project skills found.</p>}</fieldset>
      <details className="profile-details"><summary>Tools and permissions</summary><section className="profile-policy" aria-label="Profile tool policy"><h3>Tool availability</h3>{profile ? <><p><strong>Included:</strong> {profile.tools.join(', ') || 'No operational tools'}</p><p><strong>Excluded:</strong> {excluded.join(', ') || 'None of the built-in tools'}. Delegation and MCP tools are unavailable with a named profile.</p></> : <p>Default tool policy. Selecting skills alone does not restrict tools.</p>}<p>Plan mode and permission checks still apply. Asking you a question remains available.</p></section></details>
      {hasDefaults && <section className="profile-defaults" aria-label="Profile defaults"><h3>Model and mode</h3><p><strong>Current:</strong> {selection.providerId} / {selection.model} · {selection.mode === 'plan' ? 'Plan' : 'Build'}</p>{hasDefaults && <p><strong>Profile defaults:</strong> {profile?.defaultModel ? `${profile.defaultModel.providerId} / ${profile.defaultModel.model}` : 'Keep current model'} · {profile?.defaultMode ? profile.defaultMode === 'build' ? 'Build' : 'Plan' : 'Keep current mode'}</p>}<p>Use profile keeps the displayed model and mode. Apply defaults explicitly adopts the profile defaults. </p>{selection.mode === 'plan' && profile?.defaultMode === 'build' && <p className="profile-warning" role="status">Apply defaults changes Plan → Build. Editing and command tools may then be available, subject to your existing permissions.</p>}</section>}
      {previewing && <p className="field-hint" role="status">Loading instruction preview…</p>}
      {previewError && <div className="inline-alert" role="alert">{previewError}</div>}
      {preview && <><details><summary>Preview instructions</summary><Instructions detail={preview} label="Selected instruction preview" /></details><Diagnostics items={preview.diagnostics} /></>}
      {!loading && !catalog?.profiles.length && <p className="field-hint">No project profiles found.</p>}
      <div className="profile-actions">{selected || active?.active ? <button className="button secondary" disabled={blocked} onClick={() => void apply(emptyChoice())}>Use default</button> : !embedded && <button className="button primary" onClick={onClose}>Done</button>}{selected && <button className="button secondary" disabled={!ready || !sameChoice(choice, original.current)} onClick={() => void apply({ ...choice, catalogRevision: catalog!.revision })}>Reload profile</button>}{hasDefaults && <button className="button secondary" disabled={!ready} onClick={() => void apply({ ...choice, catalogRevision: catalog!.revision }, defaults)}>Apply defaults</button>}{selected && <button className="button primary" disabled={!ready} onClick={() => void apply({ ...choice, catalogRevision: catalog!.revision })}>{saving ? 'Applying…' : 'Use profile'}</button>}</div>
      <div className="profile-footer"><button className="text-button" disabled={blocked || loading} onClick={() => { generation.current++; setPreview(null); setReload(value => value + 1); }}>Refresh catalog</button><span>{sessionId ? 'Changes pause queued messages until you explicitly resume.' : 'Your selection is applied when you send the first message.'}</span></div>
    </div>;
  return embedded ? <section aria-label="Project profiles">{content}</section> : <Modal title="Project profiles" onClose={onClose} wide>{content}</Modal>;
}
