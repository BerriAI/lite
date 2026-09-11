/** @jsxImportSource @opentui/react */
import { useEffect, useState } from 'react';
import type { SkillCandidate, SkillImportPlan, SkillRootSummary } from '../shared/skill-import.js';
import { TerminalController } from './controller.js';
import { Menu, type MenuItem } from './ui.js';

/** Skill importer for /skills: explicit discovery only (no silent scans),
 * explicit selection and confirmation, source hash bound to apply so a plan
 * cannot silently land on changed content. Never auto-activates anything.
 * Discovery runs in a useEffect (never during render), `action`'s boolean return
 * is honored (no false success), menu items use unique rootId:name IDs, roots
 * are filtered to the chosen root (or shown honestly when none is chosen), and
 * back/close are guarded while a network action is busy. */
export function SkillImporter({ controller, workspace, onClose, onImported }: { controller: TerminalController; workspace: string; onClose: () => void; onImported: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [roots, setRoots] = useState<SkillRootSummary[]>([]);
  const [candidates, setCandidates] = useState<SkillCandidate[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [view, setView] = useState<'roots' | 'list' | 'plan'>('roots');
  const [plan, setPlan] = useState<SkillImportPlan | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Discovery only happens when the panel is opened or explicitly refreshed; no
  // background scans. A revision counter (not `loaded`) drives the effect so a
  // re-render can never orphan a `setBusy(false)` via cleanup while the request
  // is still in flight.
  useEffect(() => {
    let live = true;
    setLoadError(''); setBusy(true);
    controller.client.api<{ roots: SkillRootSummary[]; candidates: SkillCandidate[]; issues: string[] }>(`/skills/discover?workspace=${encodeURIComponent(workspace)}`)
      .then(data => { if (live) { setRoots(data.roots); setCandidates(data.candidates); setIssues(data.issues); setSelectedRoot(null); setLoaded(true); } })
      .catch(e => { if (live) setLoadError((e as Error).message); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [refresh, workspace]);

  const retry = () => setRefresh(value => value + 1);

  const rootCandidates = selectedRoot ? candidates.filter(c => c.rootId === selectedRoot) : candidates;
  const rootCommon = selectedRoot ? roots.find(r => r.rootId === selectedRoot)?.rootName : null;

  const openRoot = (rootId: string) => { setSelectedRoot(rootId); setView('list'); setError(''); };

  const openPlan = (candidate: SkillCandidate) => {
    if (busy) return;
    if (candidate.conflict) { setError(candidate.conflictReason); return; }
    setBusy(true); setError('');
    void controller.client.api<SkillImportPlan>('/skills/plan', { workspace, rootId: candidate.rootId, id: candidate.id })
      .then(next => { if (next.conflict) { setError(next.conflictReason); return; } setPlan(next); setView('plan'); })
      .catch(e => setError((e as Error).message))
      .finally(() => setBusy(false));
  };

  const confirmImport = () => {
    if (!plan || busy || plan.conflict) return;
    setBusy(true); setError('');
    void (async () => {
      try {
        const ok = await controller.action('Importing skill', () => controller.client.api('/skills/import', { workspace, rootId: plan.candidate.rootId, id: plan.candidate.id, sourceHash: plan.sourceHash }));
        if (ok) { onImported(); onClose(); }
        else setError(controller.getState().notice || 'Import was not completed.');
      } catch (e) { setError((e as Error).message); }
      finally { setBusy(false); }
    })();
  };

  if (view === 'plan' && plan) {
    const c = plan.candidate;
    const back = () => { if (!busy) { setView('list'); setPlan(null); } };
    if (plan.conflict) return <Menu title={`Import ${c.name}`} onClose={back} footer={error || c.conflictReason} items={[
      { id: 'reason', label: 'Import is unavailable', description: plan.conflictReason, disabled: true, action: () => {} },
      { id: 'back', label: 'Back to skill list', action: back },
    ]} />;
    const items: MenuItem[] = [
      ...plan.files.map(f => ({ id: `file:${f.path}`, label: `${f.executable ? 'x  ' : '   '}${f.path}`, description: `${f.bytes} B`, disabled: true, action: () => {} })),
      { id: 'import', label: `Import "${c.name}" into this project`, separatorBefore: true, disabled: busy, action: () => void confirmImport() },
      { id: 'back', label: 'Back to skill list', action: back },
    ];
    return <Menu title={`Import ${c.name}`} onClose={back} footer={error || `Source: ${c.rootName} / ${c.id} · Destination: .litespeed/skills/${c.id}/ · ${plan.files.length} file${plan.files.length === 1 ? '' : 's'} · ${formatBytes(c.totalBytes)}${plan.files.some(f => f.executable) ? ' · executable mode preserved, nothing is run' : ''}`} items={items} />;
  }

  if (view === 'list') {
    const items: MenuItem[] = rootCandidates.filter(c => !c.conflict || c.conflictReason).map(c => ({
      id: `${c.rootId}:${c.id}`, label: `${c.source === 'claude' ? 'Claude' : 'Codex'} · ${c.name}${c.conflict ? ' ✓ imported' : ''}`,
      description: c.conflict ? c.conflictReason : `${c.description || 'No description'} · ${c.fileCount} file${c.fileCount === 1 ? '' : 's'} · ${formatBytes(c.totalBytes)}`,
      disabled: busy || c.conflict, action: () => openPlan(c),
    }));
    if (!items.length) items.push({ id: 'none', label: 'No importable skills found', disabled: true, action: () => {} });
    items.push({ id: 'refresh', label: 'Refresh discovery', separatorBefore: true, disabled: busy, action: () => { if (!busy) retry(); } });
    return <Menu title={rootCommon ? `Importable skills · ${rootCommon}` : 'Importable skills'} onClose={() => { if (!busy) setView('roots'); }} footer={error || issues.join(' · ') || 'Choose a skill to preview where it will land.'} items={items} />;
  }

  const rootItems: MenuItem[] = roots.map(r => ({
    id: r.rootId, label: r.rootName, description: `${r.count} skill${r.count === 1 ? '' : 's'} available`,
    disabled: r.count === 0 || busy, action: () => openRoot(r.rootId),
  }));
  rootItems.push({ id: 'refresh', label: loadError ? 'Retry discovery' : 'Refresh discovery', separatorBefore: true, disabled: busy, action: () => { if (!busy) retry(); } });
  return <Menu title="Import skills into this project" onClose={() => { if (!busy) onClose(); }} footer={error || loadError || (loaded ? 'Only the fixed Claude and Codex roots are scanned; nothing is copied until you confirm. Choose a source.' : 'Scanning your Claude and Codex skill folders… this only happens when you open this panel.') + (issues.length ? ' · ' + issues.join(' · ') : '')} items={rootItems} />;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
