/** @jsxImportSource @opentui/react */
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Model, ModelReasoning, Session, Settings } from '../shared/types.js';
import { SHUNT_DESCRIPTION, SHUNT_BENEFIT, SHUNT_MODEL_HINT, shuntCanEnable, shuntConfigured, shuntToggle, type ShuntSelection } from '../shared/shunt.js';
import { REASONING_EFFORTS } from '../shared/types.js';
import { ARCHITECTURES, architectureWorker, selectArchitecture, type ArchitectureKind, type ModelRoute } from '../shared/architectures.js';
import { SETUP_ARCHITECTURES, modelGuidance } from '../shared/setup.js';
import { TerminalController } from './controller.js';
import { Menu, TextPrompt, type MenuItem } from './ui.js';

export function ModelChooser({ controller, settings, value, title, onChange, onClose, simple = false, feedback, guidance, onChangeGateway }: { simple?: boolean; feedback?: string; guidance?: string; onChangeGateway?: () => void; controller: TerminalController; settings: Settings; value: ModelRoute; title: string; onChange: (route: ModelRoute) => void; onClose: () => void }) {
  const [provider, setProvider] = useState(settings.providers.some(provider => provider.id === value.providerId) ? value.providerId : settings.providers[0]?.id || ''), [models, setModels] = useState<Model[]>([]);
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
  return <Menu key={`${provider}:${title}`} title={title} onClose={onClose} header={guidance} footer={simple ? feedback || error || (loading ? 'Loading your models…' : 'Type to search · Enter choose · Esc back') : feedback} items={[
    ...(!simple ? [{ id: 'provider', label: `Provider: ${configured?.name ?? provider}`, description: 'Change provider', action: () => setView('providers') },
    { id: 'custom', label: 'Enter a model ID…', description: error || (loading ? 'Loading models…' : undefined), action: () => setView('custom') }] : []),
    ...all.map(model => ({ id: `model:${model.id}`, label: `${model.id === value.model && provider === value.providerId ? '✓ ' : ''}${model.name || model.id}`, description: model.name && model.name !== model.id ? model.id : undefined, action: () => onChange({ providerId: provider, model: model.id }) })),
    ...(simple && !loading && !all.length ? [{id:'retry',label:'Change gateway',action:onChangeGateway ?? onClose}] : []),
  ]} />;
}

/** Edits a complete selection locally, then validates and saves once with the
 * revision captured when this screen opened. Other clients cannot be overwritten. */
export function ModelSettings({ controller, initial, settings, onClose, onProviders }: { controller: TerminalController; initial: Session; settings: Settings; onClose: () => void; onProviders: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [kind, setKind] = useState<'single' | ArchitectureKind>(initial.architecture?.kind ?? 'single');
  const [driver, setDriver] = useState<ModelRoute>({ providerId: initial.providerId, model: initial.model });
  const [worker, setWorker] = useState<ModelRoute | null>(initial.architecture ? architectureWorker(initial.architecture) : null);
  const [shunt,setShunt]=useState<ShuntSelection>(initial.shunt??{enabled:false});
  const [planner, setPlanner] = useState<ModelRoute | null>(initial.planner ?? null);
  const [reasoning, setReasoning] = useState<ModelReasoning>(initial.modelReasoning ?? {});
  const [concurrency, setConcurrency] = useState<1 | 2 | 3 | 4 | undefined>(initial.architecture?.kind === 'team-fusion' || initial.architecture?.kind === 'expert-fusion' ? initial.architecture.concurrency : undefined);
  const [style, setStyle] = useState(initial.outputStyle ?? ''), [styles, setStyles] = useState(['concise', 'explanatory', 'learning']);
  const [view, setView] = useState('main'), [catalog, setCatalog] = useState<Model[]>([]);
  useEffect(() => { let live = true; controller.client.api<{ styles: string[] }>(`/styles?workspace=${encodeURIComponent(initial.workspace)}`).then(result => { if (live) setStyles([...new Set([...styles, ...result.styles])]); }).catch(() => {}); return () => { live = false; }; }, []);
  const route = view.includes('shunt') ? shunt.model : view.includes('worker') ? worker : view.includes('planner') ? planner : driver;
  useEffect(() => {
    if (!view.startsWith('reasoning:') || !route) return;
    let live = true; setCatalog([]);
    controller.client.api<{ models: Model[] }>(`/models?providerId=${encodeURIComponent(route.providerId)}`).then(result => { if (live) setCatalog(result.models); }).catch(() => {});
    return () => { live = false; };
  }, [view, route?.providerId]);
  const back = () => setView('main');
  const name = kind === 'single' ? 'Single model' : ARCHITECTURES.find(item => item.kind === kind)!.name;
  const workerLabel = kind === 'team-fusion' ? 'Worker' : kind === 'expert-fusion' ? 'Expert' : 'Sidekick';
  if (view === 'advanced') return <ShuntSettings controller={controller} settings={settings} value={shunt} onChange={setShunt} onClose={back} reasoning={shunt.model?reasoning[JSON.stringify([shunt.model.providerId,shunt.model.model])]:undefined} onReasoning={()=>setView('reasoning:shunt')}/>;
  if (view === 'architecture') return <Menu title="Architecture" search={false} onClose={back} items={[
    ...SETUP_ARCHITECTURES.map(item => ({ id: item.kind, label: `${item.name}${item.recommended ? ' · Recommended' : ''}`, description: item.description, action: () => { setKind(item.kind); back(); } })),
  ]} />;
  if (view.startsWith('model:')) return <ModelChooser feedback={modelGuidance(kind, view === 'model:worker' ? 'worker' : view === 'model:planner' ? 'planner' : 'driver')} controller={controller} settings={settings} value={route ?? driver} title={view === 'model:driver' ? kind === 'single' ? 'Model' : 'Driver' : view === 'model:worker' ? workerLabel : 'Planner'} onClose={back} onChange={value => { if (view === 'model:worker') setWorker(value); else if (view === 'model:planner') setPlanner(value); else setDriver(value); back(); }} />;
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
    { id: `model:${id}`, label: `${label}: ${value?.model || 'Choose a model'}`, description: modelGuidance(kind, id as 'driver' | 'worker' | 'planner'), action: () => setView(`model:${id}`) },
    ...(value ? [{ id: `reasoning:${id}`, label: `Reasoning: ${reasoning[JSON.stringify([value.providerId, value.model])] ?? 'Default'}`, action: () => setView(`reasoning:${id}`) }] : []),
  ];
  const save = async () => {
    try {
      const architecture = kind !== 'single' && worker ? selectArchitecture(kind, worker) : null;
      if (architecture?.kind === 'team-fusion' || architecture?.kind === 'expert-fusion') architecture.concurrency = concurrency;
      if (await controller.configure({ ...driver, architecture, planner, shunt, modelReasoning: reasoning, outputStyle: style || null }, initial.configRevision ?? 0)) onClose();
    } catch (error) { controller.notice(String((error as Error).message)); }
  };
  return <Menu title="Models" search={false} onClose={onClose} footer={state.notice || '↑↓ choose · Enter edit · Save applies changes · Esc cancel'} items={[
    { id: 'architecture', label: `Architecture: ${name}`, action: () => setView('architecture') },
    ...fields('driver', kind === 'single' ? 'Model' : 'Driver', driver),
    ...(kind !== 'single' ? fields('worker', workerLabel, worker) : []),
    ...(kind === 'team-fusion' || kind === 'expert-fusion' ? [{ id: 'workers', label: `Workers at once: ${concurrency ?? 'Automatic'}`, action: () => setView('concurrency') }] : []),
    { id:'advanced',label:`Advanced settings · Shunt ${shunt.enabled?'On':'Off'}`,description:SHUNT_DESCRIPTION,action:()=>setView('advanced')},
    { id: 'planner', separatorBefore: true, label: `Planner model: ${planner ? 'On' : 'Off'}`, description: 'Use a different model in Plan mode.', action: () => { if (planner) setPlanner(null); else setView('model:planner'); } },
    ...(planner ? fields('planner', 'Planner', planner) : []),
    { id: 'style', separatorBefore: true, label: `Output style: ${style || 'Default'}`, action: () => setView('style') },
    { id: 'save', separatorBefore: true, label: state.pending ? 'Saving…' : 'Save', disabled: Boolean(state.pending) || !shuntConfigured(shunt,settings.providers) || !driver.model.trim() || !driver.providerId || (kind !== 'single' && !worker), action: () => { void save(); } },
    { id: 'providers', label: 'Manage providers', action: onProviders },
  ]} />;
}

export function ShuntSettings({controller,settings,value,onChange,onClose,reasoning,onReasoning}:{controller:TerminalController;settings:Settings;value:ShuntSelection;onChange:(value:ShuntSelection)=>void;onClose:()=>void;reasoning?:string;onReasoning?:()=>void}) {
  const [choosing,setChoosing]=useState(false);
  const providers=settings.providers.filter(provider=>provider.kind!=='codex');
  const canEnable=shuntCanEnable(providers);
  const modelConfigured=shuntConfigured(value,providers);
  if(choosing)return <ModelChooser controller={controller} settings={{...settings,providers}} title="Shunt model" guidance={SHUNT_MODEL_HINT} value={value.model??{providerId:providers[0]?.id??'',model:''}} onClose={()=>setChoosing(false)} onChange={model=>{onChange({...value,enabled:true,model});setChoosing(false);}}/>;
  return <Menu title="Advanced settings" search={false} onClose={onClose} footer={`${SHUNT_BENEFIT} Reported by Spotify; results vary.`} items={[
    {id:'shunt',label:`Shunt: ${value.enabled?'On':'Off'}`,description:SHUNT_DESCRIPTION,disabled:!value.enabled&&!canEnable,action:()=>onChange(shuntToggle(value,!value.enabled))},
    ...(value.enabled?[{id:'shunt-model',label:`Shunt model: ${value.model?.model || 'Choose a model'}`,description:value.model?.model?SHUNT_MODEL_HINT:'Choose a fast, efficient model to enable Shunt.',action:()=>setChoosing(true)}]:[]),
    ...(value.enabled&&modelConfigured&&onReasoning?[{id:'reasoning',label:`Reasoning: ${reasoning??'Default'}`,action:onReasoning}]:[]),
    ...(!canEnable?[{id:'connect',label:'Connect an API-key provider to use Shunt',disabled:true,action:()=>{}}]:[]),
    {id:'back',label:'Back',action:onClose},
  ]}/>;
}
