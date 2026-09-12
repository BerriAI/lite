import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import type { SkillCandidate, SkillImportPlan, SkillRootSummary } from '../../shared/skill-import';
import { api, errorMessage, post } from './api';
import { LiteSpeed } from './ui';

/** Skill importer (web): explicit discovery only, per-skill selection, a
 * confirmation step showing source/destination/files, and apply bound to the
 * source hash. Nothing is copied or activated without explicit Import.
 * "Choose again" clears BOTH the plan and selection (never a blank freeze), the
 * create-new import is disabled on conflicts (with the reason), and errors are
 * recoverable via refresh. */
export function SkillImporter({ workspace, onClose, onImported }: { workspace: string; onClose: () => void; onImported: () => void }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [roots, setRoots] = useState<SkillRootSummary[]>([]);
  const [candidates, setCandidates] = useState<SkillCandidate[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [selected, setSelected] = useState<SkillCandidate | null>(null);
  const [plan, setPlan] = useState<SkillImportPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true); setError(''); setLoadError('');
    void api<{ roots: SkillRootSummary[]; candidates: SkillCandidate[]; issues: string[] }>(`/skills/discover?${new URLSearchParams({ workspace })}`)
      .then(data => { if (live) { setRoots(data.roots); setCandidates(data.candidates); setIssues(data.issues); setSelected(null); setPlan(null); } })
      .catch(e => { if (live) setLoadError(errorMessage(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [workspace, refresh]);

  const retry = () => setRefresh(value => value + 1);
  const chooseAgain = () => { setSelected(null); setPlan(null); setError(''); };

  async function preview(candidate: SkillCandidate) {
    if (candidate.conflict) { setError(candidate.conflictReason); return; }
    setPlanning(true); setError('');
    try { const next = await post<SkillImportPlan>('/skills/plan', { workspace, rootId: candidate.rootId, id: candidate.id }); setSelected(candidate); setPlan(next); }
    catch (e) { setError(errorMessage(e)); }
    finally { setPlanning(false); }
  }

  async function confirm() {
    if (!plan || plan.candidate.conflict) return;
    setImporting(true); setError('');
    try {
      await post('/skills/import', { workspace, rootId: plan.candidate.rootId, id: plan.candidate.id, sourceHash: plan.sourceHash });
      onImported();
      onClose();
    } catch (e) { setError(errorMessage(e)); }
    finally { setImporting(false); }
  }

  return <div className="skill-importer">
    <div className="section-heading"><div><h3>Import a Claude/Codex skill</h3><p>Copies a SKILL.md skill (and its support files) into this project as <code>.litespeed/skills</code> and registers it. Your source files are never changed, nothing runs, and nothing is activated automatically.</p></div></div>
    {loading ? <LiteSpeed active compact /> : <div className="skill-importer-roots">{roots.length ? <ul>{roots.map(root => <li key={root.rootId}><strong>{root.rootName}</strong><span>{root.count} skill{root.count === 1 ? '' : 's'}</span>{root.count ? <button className="text-button" disabled={planning || importing} onClick={chooseAgain}>Browse</button> : <em>none</em>}</li>)}</ul> : <p className="field-hint">No Claude/Codex roots found.</p>}</div>}
    {error && <div className="inline-alert" role="alert">{error}</div>}
    {loadError && <div className="inline-alert" role="alert">{loadError} <button className="text-button" onClick={retry}>Retry</button></div>}
    {issues.length > 0 && <p className="field-hint">{issues.join(' · ')}</p>}

    {!selected && candidates.length > 0 && !loadError && <div className="skill-importer-list"><h4>Choose a skill to import</h4>{candidates.map(c => <label key={`${c.rootId}:${c.id}`} className="skill-importer-row skill-importer-conflict"><input type="radio" name="skill" disabled={c.conflict || planning} onChange={() => void preview(c)} /><span><strong>{c.name}</strong><small>{c.source === 'claude' ? 'Claude' : 'Codex'} · {c.rootName} · {c.fileCount} file{c.fileCount === 1 ? '' : 's'} · {formatBytes(c.totalBytes)}</small>{c.conflict ? <small className="skill-importer-conflict-reason">{c.conflictReason}</small> : <small>{c.description || 'No description'}</small>}</span></label>)}
      {candidates.every(c => c.conflict) && <p className="field-hint">All discovered skills are already imported into this project.</p>}</div>}

    {selected && plan && plan.candidate && !plan.candidate.conflict && <div className="skill-importer-plan"><h4>Review before importing</h4><p><strong>Source:</strong> {plan.candidate.rootName} / {plan.candidate.id}</p><p><strong>Destination:</strong> <code>.litespeed/skills/{plan.candidate.id}/</code></p><p><strong>{plan.files.length} file{plan.files.length === 1 ? '' : 's'}</strong> · {formatBytes(plan.candidate.totalBytes)} total{plan.files.some(f => f.executable) ? ' · executable mode preserved, nothing is run' : ''}</p>
      <ul className="skill-importer-files">{plan.files.slice(0, 30).map(f => <li key={f.path}><code>{f.executable ? 'x ' : '  '}{f.path}</code><span>{formatBytes(f.bytes)}</span></li>)}{plan.files.length > 30 && <li><em>… and {plan.files.length - 30} more</em></li>}</ul>
      <div className="skill-importer-confirm"><button className="button secondary" disabled={importing} onClick={chooseAgain}>Choose again</button><button className="button primary" disabled={importing} onClick={() => void confirm()}><Download size={15} />{importing ? 'Importing…' : 'Import into this project'}</button></div>
    </div>}

    {selected && plan?.candidate?.conflict && <div className="inline-alert" role="alert">{plan.candidate.conflictReason} <button className="text-button" onClick={chooseAgain}>Back</button></div>}

    <div className="profile-footer"><button className="text-button" disabled={loading || importing || planning || selected !== null} onClick={onClose}>Done</button><button className="text-button" disabled={loading || importing || planning} onClick={chooseAgain}>Back</button><button className="text-button" disabled={loading || importing || planning} onClick={retry}>Refresh</button><span>Discovery only runs when you open this panel.</span></div>
  </div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
