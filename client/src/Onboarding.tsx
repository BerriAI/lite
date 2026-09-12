import { useState, type ReactNode } from 'react';
import { shuntConfigured } from '../../shared/shunt';
import { Check } from 'lucide-react';
import { architectureWorker, selectArchitecture, type ArchitectureKind } from '../../shared/architectures';
import { SETUP_ARCHITECTURES, SETUP_PERMISSIONS, modelGuidance, GATEWAY_URL_HINT, GATEWAY_KEY_HINT, gatewayBaseUrl, setupGateway, type GatewayConnection } from '../../shared/setup';
import type { Settings } from '../../shared/types';
import type { Selection } from './Composer';
import { ModelField, ShuntSettings } from './ModelPicker';
import { Logo, Modal } from './ui';
import { errorMessage, post } from './api';
import { SkillImporter } from './SkillImporter';

export function Onboarding({ settings, selection, workspace, onSave, onClose, renderProviders, onSettings, quick = false }: { settings: Settings; quick?: boolean; selection: Selection; workspace: string; onSave: (next: Selection) => Promise<void>; onClose: () => void; onSettings: (settings: Settings) => void; renderProviders: (close: () => void) => ReactNode }) {
  const [shuntPending,setShuntPending]=useState(false);
  const [providers, setProviders] = useState(false);
  const [skills, setSkills] = useState(false);
  const [simple, setSimple] = useState(quick);
  const [step, setStep] = useState(quick && settings.providers.some(p => p.id === selection.providerId && p.baseUrl) ? 2 : 0), [kind, setKind] = useState<'single' | ArchitectureKind>(selection.architecture?.kind ?? (quick || !selection.model ? 'sidekick-fusion' : 'single'));
  const [draft, setDraft] = useState(selection), [worker, setWorker] = useState(selection.architecture ? architectureWorker(selection.architecture) : null);
  const [open, setOpen] = useState<string | null>(null), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [gateway, setGateway] = useState(() => setupGateway(settings, selection.providerId));
  const [baseUrl, setBaseUrl] = useState(gateway.baseUrl), [apiKey, setApiKey] = useState('');
  const [connection, setConnection] = useState('');
  const label = kind === 'expert-fusion' ? 'Expert' : kind === 'team-fusion' ? 'Worker' : 'Sidekick';
  const valid = !shuntPending && shuntConfigured(draft.shunt,settings.providers) && Boolean(draft.model && settings.providers.some(provider => provider.id === draft.providerId) && (kind === 'single' || worker?.model && settings.providers.some(provider => provider.id === worker.providerId)));
  async function connect() {
    setSaving(true); setError('');
    try {
      const result = await post<GatewayConnection>('/providers/connect', { providerId: gateway.providerId, baseUrl: gatewayBaseUrl(baseUrl), ...(apiKey.trim() ? {apiKey: apiKey.trim()} : {}) });
      onSettings(result.settings); setGateway({providerId: result.providerId, baseUrl: baseUrl.trim(), existing: true}); setApiKey('');
      setDraft(current => ({...current, ...(current.shunt?.enabled&&current.shunt.model.providerId===result.providerId&&!result.models.some(model=>model.id===current.shunt!.model!.model)?{shunt:{...current.shunt,model:{providerId:result.providerId,model:''}}}:{}), providerId: result.providerId, model: current.providerId === result.providerId && result.models.some(model => model.id === current.model) ? current.model : ''}));
      setWorker(current => current?.providerId === result.providerId && result.models.some(model => model.id === current.model) ? current : null);
      setConnection(`Connected · ${result.models.length} models available`); setStep(simple ? 2 : 1); setOpen(null);
    } catch (error) { setError(errorMessage(error)); } finally { setSaving(false); }
  }
  async function save() {
    setSaving(true); setError('');
    try { await onSave({ ...draft, architecture: kind === 'single' ? null : selectArchitecture(kind, worker!) }); onClose(); }
    catch (error) { setError(errorMessage(error)); } finally { setSaving(false); }
  }
  if (skills) return <Modal title="Import a Claude/Codex skill" onClose={() => setSkills(false)}><SkillImporter workspace={workspace} onClose={() => setSkills(false)} onImported={() => setSkills(false)} /></Modal>;
  if (providers) return renderProviders(() => { const next = setupGateway(settings, settings.defaultProvider); setGateway(next); setBaseUrl(next.baseUrl); setApiKey(''); setProviders(false); });
  return <Modal title="Set up Litespeed" onClose={() => { if (!saving) onClose(); }}>
    <div className="setup-intro"><Logo /><div><p>{step === 0 ? 'Connect your LiteLLM gateway' : step === 1 ? 'How would you like to work?' : 'Choose your models'}</p><small>{simple ? step === 0 ? 'Enter your connection to get started.' : 'Choose a setup, then a model for each role.' : `${step + 1} of 3 · You can change this later.`}</small></div></div>
    <div className="setup-content">
      {step === 0 ? <form id="gateway-setup" className="setup-gateway" onSubmit={event => { event.preventDefault(); if (!saving) void connect(); }}>
        <label>Gateway base URL<input type="url" autoFocus required placeholder="https://your-gateway.example.com" value={baseUrl} disabled={saving} onChange={event => setBaseUrl(event.target.value)} spellCheck={false} /><span className="field-hint">{GATEWAY_URL_HINT}</span></label>
        <label>API key<input type="password" autoComplete="off" placeholder={gateway.existing && baseUrl === gateway.baseUrl ? 'Leave blank to keep your saved key' : 'Enter your LiteLLM API key'} value={apiKey} disabled={saving} onChange={event => setApiKey(event.target.value)} /><span className="field-hint">{GATEWAY_KEY_HINT}</span></label>
        <p className="field-hint">Connect to check your gateway and load the models available to your key.</p>
        <button type="button" className="text-button" disabled={saving} onClick={() => setProviders(true)}>Use another provider</button>
        {settings.providers.filter(provider => provider.kind !== 'openai').map(provider => <button key={provider.id} type="button" className="text-button" onClick={() => { setDraft(current => ({...current, providerId: provider.id, model: current.providerId === provider.id ? current.model : ''})); setError(''); setStep(1); }}>Continue with {provider.name}</button>)}
      </form> : step === 1 ? <div className="setup-options" role="group" aria-label="Architecture">{SETUP_ARCHITECTURES.map(item => <button key={item.kind} className={`setup-option ${kind === item.kind ? 'selected' : ''}`} aria-pressed={kind === item.kind} onClick={() => setKind(item.kind)}><span><strong>{item.name}{item.recommended && <span className="recommended-label">Recommended</span>}</strong><small>{item.description}</small></span>{kind === item.kind && <Check size={16} />}</button>)}</div> : <>
        {simple && <label className="setup-architecture">Setup<select aria-label="Setup architecture" value={kind} onChange={event => { setKind(event.target.value as typeof kind); setOpen(null); }}>{SETUP_ARCHITECTURES.map(item => <option key={item.kind} value={item.kind}>{item.name}{item.recommended ? ' · Recommended' : ''}</option>)}</select></label>}
        <p className="field-hint">{SETUP_ARCHITECTURES.find(item => item.kind === kind)?.description}</p>
        {!settings.providers.length ? <p className="field-hint">Connect a provider to see its models.</p> : <div className="setup-models">
          <ModelField simple hint={modelGuidance(kind, 'driver')} label={kind === 'single' ? 'Model' : 'Driver'} settings={settings} selection={draft} value={draft.model ? draft : null} onChange={route => setDraft({ ...draft, ...route })} onReasoning={() => {}} open={open === 'driver'} onOpen={value => setOpen(value ? 'driver' : null)} />
          {kind !== 'single' && <ModelField simple hint={modelGuidance(kind, 'worker')} label={label} settings={settings} selection={draft} value={worker} onChange={setWorker} onReasoning={() => {}} open={open === 'worker'} onOpen={value => setOpen(value ? 'worker' : null)} />}
        </div>}
        <ShuntSettings settings={settings} selection={draft} onChange={shunt=>setDraft({...draft,shunt})} onPending={setShuntPending}/>
        <div className="setup-links"><button className="text-button" onClick={() => simple ? setStep(0) : setProviders(true)}>{simple ? 'Change gateway' : 'Manage providers'}</button>
        {simple && <button className="text-button" onClick={() => { setSimple(false); setStep(1); setOpen(null); }}>Customize setup</button>}</div>
        {!simple && <><label className="model-setting-row setup-permissions">Permissions<select aria-label="Setup permissions" value={draft.permissionMode} onChange={event => setDraft({ ...draft, permissionMode: event.target.value as 'ask' | 'auto' })}><option value="ask">Ask first</option><option value="auto">Allow all tools</option></select></label>
        <p className="field-hint">{SETUP_PERMISSIONS}</p></>}
        <div className="setup-links"><button className="text-button" onClick={() => setSkills(true)}>Import Claude/Codex skills from your machine</button></div>
      </>}
      {step > 0 && connection && <p className="field-hint">{connection}</p>}
      {error && <p role="alert" className="error-text">{error}</p>}
    </div>
    <div className="model-picker-footer"><button className="text-button" disabled={saving} onClick={() => { setError(''); step === 0 ? onClose() : setStep(simple ? 0 : step - 1); }}>{step === 0 ? 'Set up later' : 'Back'}</button><button className="button primary" type={step === 0 ? "submit" : "button"} form={step === 0 ? "gateway-setup" : undefined} disabled={saving || step === 0 && !baseUrl.trim() || step === 2 && !valid} onClick={() => { if (step === 1) setStep(2); else if (step === 2) void save(); }}>{saving ? step === 0 ? 'Connecting…' : 'Saving…' : step === 0 ? 'Connect & continue' : step === 1 ? 'Continue' : simple ? 'Start chatting' : 'Start with this setup'}</button></div>
  </Modal>;
}
