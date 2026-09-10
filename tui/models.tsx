/** @jsxImportSource @opentui/react */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Model, ModelReasoning, Session, Settings } from '../shared/types.js';
import { REASONING_EFFORTS } from '../shared/types.js';
import { ARCHITECTURES, architectureWorker, selectArchitecture, type ArchitectureKind, type ModelRoute } from '../shared/architectures.js';
import { TerminalController } from './controller.js';
import { Menu, TextPrompt, type MenuItem } from './ui.js';

export function ModelChooser({ controller, settings, value, title, onChange, onClose }: { controller: TerminalController; settings: Settings; value: ModelRoute; title: string; onChange: (route: ModelRoute) => void; onClose: () => void }) {
  const [provider, setProvider] = useState(value.providerId), [models, setModels] = useState<Model[]>([]);
  const [view, setView] = useState<'models' | 'providers' | 'custom'>('models'), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true; setLoading(true); setError(''); setModels([]);
    controller.client.api<{ models: Model[]; error?: string }>(`/models?providerId=${encodeURIComponent(provider)}`).then(result => { if (live) { setModels(result.models); setError(result.error || ''); } }).catch(error => { if (live) setError(String(error.message ?? error)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [provider, controller]);
  if (view === 'providers') return <Menu title="Provider" onClose={() => setView('models')} items={settings.providers.map(item => ({ id: item.id, label: item.name, description: item.kind, action: () => { setProvider(item.id); setView('models'); } }))} />;
  if (view === 'custom') return <TextPrompt title="Model ID" placeholder="provider/model-name" onClose={() => setView('models')} onSave={model => { if (model.trim()) onChange({ providerId: provider, model: model.trim() }); }} />;
  const configured = settings.providers.find(item => item.id === provider);
  const all = [...models, ...(configured?.models ?? []).filter(id => !models.some(model => model.id === id)).map(id => ({ id, name: id, providerId: provider }))];
  return <Menu key={provider} title={title} onClose={onClose} items={[
    { id: 'provider', label: `Provider: ${configured?.name ?? provider}`, description: 'Change provider', action: () => setView('providers') },
    { id: 'custom', label: 'Enter a model ID…', description: error || (loading ? 'Loading models…' : undefined), action: () => setView('custom') },
    ...all.map(model => ({ id: `model:${model.id}`, label: `${model.id === value.model && provider === value.providerId ? '✓ ' : ''}${model.name || model.id}`, description: model.name && model.name !== model.id ? model.id : undefined, action: () => onChange({ providerId: provider, model: model.id }) })),
  ]} />;
}

/** Edits a complete selection locally, then validates and saves once with the
 * revision captured when this screen opened. Other clients cannot be overwritten. */
export function ModelSettings({ controller, initial, settings, onClose, onProviders }: { controller: TerminalController; initial: Session; settings: Settings; onClose: () => void; onProviders: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [kind, setKind] = useState<'single' | ArchitectureKind>(initial.architecture?.kind ?? 'single');
  const [driver, setDriver] = useState<ModelRoute>({ providerId: initial.providerId, model: initial.model });
  const [worker, setWorker] = useState<ModelRoute | null>(initial.architecture ? architectureWorker(initial.architecture) : null);
  const [planner, setPlanner] = useState<ModelRoute | null>(initial.planner ?? null);
  const [reasoning, setReasoning] = useState<ModelReasoning>(initial.modelReasoning ?? {});
  const [concurrency, setConcurrency] = useState<1 | 2 | 3 | 4 | undefined>(initial.architecture?.kind === 'team-fusion' || initial.architecture?.kind === 'expert-fusion' ? initial.architecture.concurrency : undefined);
  const [style, setStyle] = useState(initial.outputStyle ?? ''), [styles, setStyles] = useState(['concise', 'explanatory', 'learning']);
  const [view, setView] = useState('main'), [catalog, setCatalog] = useState<Model[]>([]);
  useEffect(() => { let live = true; controller.client.api<{ styles: string[] }>(`/styles?workspace=${encodeURIComponent(initial.workspace)}`).then(result => { if (live) setStyles([...new Set([...styles, ...result.styles])]); }).catch(() => {}); return () => { live = false; }; }, []);
  const route = view.includes('worker') ? worker : view.includes('planner') ? planner : driver;
  useEffect(() => {
    if (!view.startsWith('reasoning:') || !route) return;
    let live = true; setCatalog([]);
    controller.client.api<{ models: Model[] }>(`/models?providerId=${encodeURIComponent(route.providerId)}`).then(result => { if (live) setCatalog(result.models); }).catch(() => {});
    return () => { live = false; };
  }, [view, route?.providerId]);
  const back = () => setView('main');
  const name = kind === 'single' ? 'Single model' : ARCHITECTURES.find(item => item.kind === kind)!.name;
  const workerLabel = kind === 'team-fusion' ? 'Worker' : kind === 'expert-fusion' ? 'Expert' : 'Sidekick';
  if (view === 'architecture') return <Menu title="Architecture" search={false} onClose={back} items={[
    { id: 'single', label: 'Single model', description: 'One model handles the whole task.', action: () => { setKind('single'); back(); } },
    ...ARCHITECTURES.map(item => ({ id: item.kind, label: item.name, description: item.kind === 'sidekick-fusion' ? 'A driver works with one sidekick that keeps its context.' : item.kind === 'team-fusion' ? 'A strong driver delegates scoped work to cheaper workers.' : 'A cheaper driver calls strong experts, then checks their work.', action: () => { setKind(item.kind); back(); } })),
  ]} />;
  if (view.startsWith('model:')) return <ModelChooser controller={controller} settings={settings} value={route ?? driver} title={view === 'model:driver' ? kind === 'single' ? 'Model' : 'Driver' : view === 'model:worker' ? workerLabel : 'Planner'} onClose={back} onChange={value => { if (view === 'model:worker') setWorker(value); else if (view === 'model:planner') setPlanner(value); else setDriver(value); back(); }} />;
  if (view.startsWith('reasoning:') && route) {
    const key = JSON.stringify([route.providerId, route.model]);
    const supported = catalog.find(item => item.id === route.model)?.reasoningEfforts ?? REASONING_EFFORTS;
    return <Menu title={`Reasoning · ${route.model}`} search={false} onClose={back} items={['', ...supported].map(effort => ({ id: effort || 'default', label: effort || 'Default', action: () => { const next = { ...reasoning }; if (effort) next[key] = effort as typeof REASONING_EFFORTS[number]; else delete next[key]; setReasoning(next); back(); } }))} />;
  }
  if (view === 'concurrency') return <Menu title="Workers at once" search={false} onClose={back} items={[
    { id: 'auto', label: 'Automatic', description: 'Run independent assignments together within the turn budget.', action: () => { setConcurrency(undefined); back(); } },
    ...([1, 2, 3, 4] as const).map(count => ({ id: String(count), label: count === 1 ? '1 · sequential' : `${count} · parallel`, action: () => { setConcurrency(count); back(); } })),
  ]} />;
  if (view === 'style') return <Menu title="Output style" onClose={back} items={['', ...styles].map(value => ({ id: value || 'default', label: value || 'Default', action: () => { setStyle(value); back(); } }))} />;
  const fields = (id: string, label: string, value: ModelRoute | null): MenuItem[] => [
    { id: `model:${id}`, label: `${label}: ${value?.model || 'Choose a model'}`, description: value?.providerId, action: () => setView(`model:${id}`) },
    ...(value ? [{ id: `reasoning:${id}`, label: `Reasoning: ${reasoning[JSON.stringify([value.providerId, value.model])] ?? 'Default'}`, action: () => setView(`reasoning:${id}`) }] : []),
  ];
  const save = async () => {
    try {
      const architecture = kind !== 'single' && worker ? selectArchitecture(kind, worker) : null;
      if (architecture?.kind === 'team-fusion' || architecture?.kind === 'expert-fusion') architecture.concurrency = concurrency;
      if (await controller.configure({ ...driver, architecture, planner, modelReasoning: reasoning, outputStyle: style || null }, initial.configRevision ?? 0)) onClose();
    } catch (error) { controller.notice(String((error as Error).message)); }
  };
  return <Menu title="Models" search={false} onClose={onClose} footer={state.notice || '↑↓ choose · Enter edit · Save applies changes · Esc cancel'} items={[
    { id: 'architecture', label: `Architecture: ${name}`, action: () => setView('architecture') },
    ...fields('driver', kind === 'single' ? 'Model' : 'Driver', driver),
    ...(kind !== 'single' ? fields('worker', workerLabel, worker) : []),
    ...(kind === 'team-fusion' || kind === 'expert-fusion' ? [{ id: 'workers', label: `Workers at once: ${concurrency ?? 'Automatic'}`, action: () => setView('concurrency') }] : []),
    { id: 'planner', separatorBefore: true, label: `Planner model: ${planner ? 'On' : 'Off'}`, description: 'Use a different model in Plan mode.', action: () => { if (planner) setPlanner(null); else setView('model:planner'); } },
    ...(planner ? fields('planner', 'Planner', planner) : []),
    { id: 'style', separatorBefore: true, label: `Output style: ${style || 'Default'}`, action: () => setView('style') },
    { id: 'save', separatorBefore: true, label: state.pending ? 'Saving…' : 'Save', disabled: Boolean(state.pending) || !driver.model.trim() || !driver.providerId || (kind !== 'single' && !worker), action: () => { void save(); } },
    { id: 'providers', label: 'Manage providers', action: onProviders },
  ]} />;
}
