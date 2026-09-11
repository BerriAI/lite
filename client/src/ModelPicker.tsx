import { SHUNT_DESCRIPTION, SHUNT_MODEL_HINT, SHUNT_BENEFIT, shuntConfigured, type ShuntSelection } from '../../shared/shunt';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { REASONING_EFFORTS, type Model, type ReasoningEffort, type Settings } from '../../shared/types';
import { architectureWorker, selectArchitecture, type ArchitectureKind, type ModelRoute } from '../../shared/architectures';
import { SETUP_ARCHITECTURES, modelGuidance } from '../../shared/setup';
import type { Selection } from './Composer';
import { api, errorMessage, query } from './api';
import { Modal, LiteSpeed } from './ui';

const arrangements = SETUP_ARCHITECTURES;
type View = 'single' | ArchitectureKind;
type Role = 'model' | 'worker' | 'planner';

function moveOption(event: KeyboardEvent, selector = '[role="option"]') {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(selector)];
  if (!options.length) return;
  event.preventDefault();
  const current = options.indexOf(document.activeElement as HTMLButtonElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  options[index].focus();
}

/** A model menu belongs to its role. Search never changes a different slot. */
export function ModelField({ simple = false, hint, label, value, settings, selection, onChange, onReasoning, open, onOpen }: {
  simple?: boolean; hint?: string; label: string; value: ModelRoute | null; settings: Settings; selection: Selection;
  onChange: (route: ModelRoute) => void; onReasoning: (route: ModelRoute, effort: string) => void;
  open: boolean; onOpen: (open: boolean) => void;
}) {
  const id = useId(), trigger = useRef<HTMLButtonElement>(null);
  const [providerId, setProviderId] = useState(value?.providerId || selection.providerId || settings.providers[0]?.id || '');
  const [search, setSearch] = useState('');
  const [catalog, setCatalog] = useState<Record<string, Model[]>>({});
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const preferred = value?.providerId || providerId;
    if (!settings.providers.some(provider => provider.id === preferred)) setProviderId(settings.providers[0]?.id || '');
    else if (value?.providerId) setProviderId(value.providerId);
  }, [value?.providerId, settings.providers]);
  useEffect(() => {
    let live = true;
    if (!providerId) return;
    setLoading(true); setError('');
    api<{ models: Model[]; error?: string }>(`/models?${query({ providerId })}`)
      .then(result => { if (live) { setCatalog(current => ({ ...current, [providerId]: result.models })); setError(result.error ?? ''); } })
      .catch(error => { if (live) setError(errorMessage(error)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [providerId]);
  const models = catalog[providerId] ?? [];
  const configured = settings.providers.find(provider => provider.id === providerId)?.models ?? [];
  const all = [...models, ...configured.filter(id => id && !models.some(model => model.id === id)).map(id => ({ id, name: id, providerId }))];
  const filtered = all.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(search.toLowerCase()));
  const effort = value ? selection.modelReasoning?.[JSON.stringify([value.providerId, value.model])] ?? '' : '';
  const supported = value ? catalog[value.providerId]?.find(model => model.id === value.model)?.reasoningEfforts : undefined;
  const efforts = supported ?? REASONING_EFFORTS;
  function close() { onOpen(false); trigger.current?.focus(); }
  function choose(model: string) { onChange({ providerId, model }); setSearch(''); close(); }
  return <div className={`model-field ${simple ? 'simple' : ''}`} onKeyDown={event => { if (event.key === 'Escape' && open) { event.stopPropagation(); close(); } }}>
    <div className="model-field-row">
      <span className="model-field-label" id={`${id}-label`}>{label}</span>{!simple && <span className="model-effort-mobile" aria-hidden="true">Reasoning</span>}
      <button ref={trigger} type="button" className="model-select-trigger" aria-label={label === 'Model' ? 'Model' : `${label} model`} aria-expanded={open} aria-controls={`${id}-menu`} onClick={() => { setSearch(''); onOpen(!open); }}>
        <span title={value?.model}>{value?.model.split('/').at(-1) || 'Select a model'}</span><ChevronDown size={15} />
      </button>
      {!simple && <select aria-label={`${label} reasoning`} title="Reasoning effort, saved per model" disabled={!value} value={effort} onChange={event => { if (value) onReasoning(value, event.target.value); }}>
        <option value="">Default</option>{efforts.map(level => <option key={level} value={level}>{level === 'xhigh' ? 'Extra high' : level[0].toUpperCase() + level.slice(1)}</option>)}
        {effort && !efforts.includes(effort) && <option value={effort}>{effort} · unsupported</option>}
      </select>}
    </div>
    {hint && <p className="field-hint model-role-hint">{hint}</p>}
    {open && <div id={`${id}-menu`} className="model-select-menu" onKeyDown={event => moveOption(event)}>
      {settings.providers.length > 1 && <label className="model-provider">Provider<select aria-label={`${label} provider`} value={providerId} onChange={event => { setProviderId(event.target.value); setSearch(''); }}>{settings.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>}
      <div className="model-search"><Search size={15} /><input autoFocus aria-label={`Search ${label.toLowerCase()} models`} placeholder="Search models or enter an ID…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && search.trim()) { event.preventDefault(); choose(filtered.length === 1 ? filtered[0].id : search.trim()); } }} /></div>
      {loading && <LiteSpeed active compact />}
      {error && <p className="field-hint error-text">{error} You can enter a model ID above.</p>}
      <div className="model-options" role="listbox" aria-labelledby={`${id}-label`}>
        {filtered.map(model => <button type="button" role="option" aria-selected={model.id === value?.model && providerId === value.providerId} key={model.id} onClick={() => choose(model.id)}><span><strong>{model.name}</strong>{model.name !== model.id && <small>{model.id}</small>}</span>{model.id === value?.model && providerId === value.providerId && <Check size={14} />}</button>)}
        {!loading && !filtered.length && <p className="field-hint">{search ? 'No matching models.' : 'Enter a model ID or configure a provider.'}</p>}
        {search.trim() && !all.some(model => model.id === search.trim()) && <button type="button" role="option" aria-selected={false} onClick={() => choose(search.trim())}>Use “{search.trim()}”</button>}
      </div>
    </div>}
  </div>;
}

export function ModelPicker({ disabled, settings, selection, onChange, onClose, onSettings, workspace }: { disabled?: boolean; settings: Settings; selection: Selection; onChange: (selection: Selection) => void; onClose: () => void; onSettings: () => void; workspace: string }) {
  const [shuntPending,setShuntPending]=useState(false);
  const [view, setView] = useState<View>(selection.architecture?.kind ?? 'single');
  const [open, setOpen] = useState<Role | 'architecture' | null>(null);
  const [workspaceStyles, setWorkspaceStyles] = useState<string[]>([]);
  const architectureTrigger = useRef<HTMLButtonElement>(null), architectureId = useId();
  useEffect(() => { let live = true; api<{ styles: string[] }>(`/styles?${query({ workspace })}`).then(result => { if (live) setWorkspaceStyles(result.styles); }).catch(() => {}); return () => { live = false; }; }, [workspace]);
  const styles = [...new Set(['concise', 'explanatory', 'learning', ...workspaceStyles, ...(selection.outputStyle ? [selection.outputStyle] : [])])];
  const arrangement = arrangements.find(item => item.kind === view)!;
  const route = selection.model ? { providerId: selection.providerId, model: selection.model } : null;
  const worker = selection.architecture ? architectureWorker(selection.architecture) : null;
  const workerLabel = view === 'team-fusion' ? 'Worker' : view === 'expert-fusion' ? 'Expert' : 'Sidekick';
  const pending = view !== 'single' && selection.architecture?.kind !== view;
  function chooseArchitecture(kind: View) {
    setView(kind); setOpen(null); architectureTrigger.current?.focus();
    if (kind === 'single') onChange({ ...selection, architecture: null });
    else if (worker) onChange({ ...selection, architecture: selectArchitecture(kind, worker) });
  }
  function reasoning(value: ModelRoute, effort: string) {
    const modelReasoning = { ...selection.modelReasoning }, key = JSON.stringify([value.providerId, value.model]);
    if (effort) modelReasoning[key] = effort as ReasoningEffort; else delete modelReasoning[key];
    onChange({ ...selection, modelReasoning });
  }
  function field(role: Role, label: string, value: ModelRoute | null) {
    return <ModelField hint={modelGuidance(view, role === 'model' ? 'driver' : role)} label={label} value={value} settings={settings} selection={selection} onReasoning={reasoning} open={open === role} onOpen={next => setOpen(next ? role : null)} onChange={value => {
      if (role === 'planner') onChange({ ...selection, planner: value });
      else if (role === 'worker' && view !== 'single') onChange({ ...selection, architecture: selectArchitecture(view, value) });
      else onChange({ ...selection, ...value });
    }} />;
  }
  return <Modal title="Choose a model" onClose={onClose}>
    <div className="model-picker-scroll"><fieldset className="model-picker" disabled={disabled}>
      <div className="architecture-field" onKeyDown={event => { if (event.key === 'Escape' && open === 'architecture') { event.stopPropagation(); setOpen(null); architectureTrigger.current?.focus(); } }}>
        <label id={`${architectureId}-label`}>Architecture</label>
        <button ref={architectureTrigger} className="architecture-select" aria-label="Architecture" aria-haspopup="listbox" aria-controls={architectureId} aria-expanded={open === 'architecture'} onClick={() => setOpen(open === 'architecture' ? null : 'architecture')}><span><strong>{arrangement.name}</strong><small>{arrangement.description}</small></span><ChevronDown size={16} /></button>
        {open === 'architecture' && <div className="architecture-options" id={architectureId} role="listbox" aria-labelledby={`${architectureId}-label`} onKeyDown={event => moveOption(event)}>{arrangements.map(item => <button autoFocus={item.kind === view} role="option" aria-selected={view === item.kind} key={item.kind} onClick={() => chooseArchitecture(item.kind)}><span><strong>{item.name}{item.recommended && <span className="recommended-label">Recommended</span>}</strong><small>{item.description}</small></span>{view === item.kind && <Check size={15} />}</button>)}</div>}
      </div>
      <section className="model-roles" aria-label="Models">
        <div className="model-column-head"><span>Model</span><span>Reasoning</span></div>
        {field('model', view === 'single' ? 'Model' : 'Driver', route)}
        {view !== 'single' && field('worker', workerLabel, worker)}
        {pending && <p className="field-hint">Choose a {workerLabel.toLowerCase()} to enable {arrangement.name}.</p>}
        {(view === 'team-fusion' || view === 'expert-fusion') && <label className="model-setting-row">Workers at once<select aria-label="Workers at once" disabled={pending} value={selection.architecture && selection.architecture.kind !== 'sidekick-fusion' ? selection.architecture.concurrency ?? 'auto' : 'auto'} onChange={event => { if (selection.architecture && selection.architecture.kind !== 'sidekick-fusion') { const { concurrency: _, ...architecture } = selection.architecture; onChange({ ...selection, architecture: event.target.value === 'auto' ? architecture : { ...architecture, concurrency: Number(event.target.value) as 1 | 2 | 3 | 4 } }); } }}><option value="auto">All requested · default</option>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count === 1 ? '1 · sequential' : `${count} · parallel`}</option>)}</select></label>}
      </section>
      <ShuntSettings settings={settings} selection={selection} onChange={value=>onChange({...selection,shunt:value})} onPending={setShuntPending} onReasoning={reasoning} />
      <section className="planner-section" aria-label="Planning">
        <div className="planner-heading"><div><strong>Planner model</strong><p>Use a different model in Plan mode.</p></div><button type="button" role="switch" className="setting-switch" aria-label="Use a planner model" aria-checked={Boolean(selection.planner)} disabled={!route} onClick={() => { onChange({ ...selection, planner: selection.planner ? null : route }); setOpen(null); }}><span /></button></div>
        {selection.planner && field('planner', 'Planner', selection.planner)}
      </section>
      <label className="model-setting-row output-style-setting">Output style<select aria-label="Output style" value={selection.outputStyle ?? ''} onChange={event => onChange({ ...selection, outputStyle: event.target.value || null })}><option value="">Default</option>{styles.map(style => <option key={style} value={style}>{style[0].toUpperCase() + style.slice(1)}</option>)}</select></label>
    </fieldset></div>
    <div className="model-picker-footer"><button className="text-button" onClick={() => { onClose(); onSettings(); }}>Manage providers</button><button className="button primary" disabled={disabled || pending || shuntPending || !shuntConfigured(selection.shunt,settings.providers)} onClick={onClose}>Done</button></div>
  </Modal>;
}

export function ShuntSettings({settings,selection,onChange,onPending,onReasoning}:{settings:Settings;selection:Selection;onChange:(value:ShuntSelection)=>void;onPending:(pending:boolean)=>void;onReasoning?:(route:ModelRoute,effort:string)=>void}) {
  const value=selection.shunt;
  const [wanted,setWanted]=useState(Boolean(value?.enabled)),[open,setOpen]=useState(false);
  const providers=settings.providers.filter(provider=>provider.kind!=='codex');
  useEffect(()=>{setWanted(Boolean(value?.enabled));},[value?.enabled]);
  const pending=wanted&&(!value?.model||!shuntConfigured({enabled:true,model:value.model},settings.providers));
  useEffect(()=>{onPending(pending);},[pending,onPending]);
  return <details className="shunt-settings planner-section" open={value?.enabled || undefined}>
    <summary><span>Advanced settings <small>Shunt · {value?.enabled?'On':'Off'}</small></span><ChevronDown size={14}/></summary>
    <p className="field-hint">{SHUNT_DESCRIPTION} {SHUNT_BENEFIT} <a href="https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90" target="_blank" rel="noreferrer" title="Spotify’s reported result for large reads. Actual savings vary and Shunt adds its own model usage.">Learn more</a></p>
    <div className="planner-heading"><div><strong>Shunt</strong></div><button type="button" className="setting-switch" role="switch" aria-label="Enable Shunt" aria-checked={wanted} disabled={!providers.length} onClick={()=>{const enabled=!wanted;setWanted(enabled);setOpen(enabled&&!value?.model);if(!enabled)onChange({...value,enabled:false});else if(value?.model&&shuntConfigured({enabled:true,model:value.model},settings.providers))onChange({...value,enabled:true,model:value.model});else setOpen(true);}}><span/></button></div>
    {wanted&&<ModelField simple={!onReasoning} label="Shunt" hint={SHUNT_MODEL_HINT} settings={{...settings,providers}} selection={{...selection,providerId:providers.some(p=>p.id===value?.model?.providerId)?value!.model!.providerId:providers[0]?.id??''}} value={value?.model??null} onChange={model=>onChange({...value,enabled:true,model})} onReasoning={onReasoning??(()=>{})} open={open} onOpen={setOpen}/>}
    {pending&&<p className="field-hint">Choose a Shunt model to enable it.</p>}
    {!providers.length&&<p className="field-hint">Connect an API-key provider to use Shunt.</p>}
  </details>;
}
