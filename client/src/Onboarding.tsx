import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { architectureWorker, selectArchitecture, type ArchitectureKind } from '../../shared/architectures';
import { SETUP_ARCHITECTURES, SETUP_PERMISSIONS } from '../../shared/setup';
import type { Settings } from '../../shared/types';
import type { Selection } from './Composer';
import { ModelField } from './ModelPicker';
import { Logo, Modal } from './ui';
import { errorMessage } from './api';

export function Onboarding({ settings, selection, onSave, onClose, renderProviders }: { settings: Settings; selection: Selection; onSave: (next: Selection) => Promise<void>; onClose: () => void; renderProviders: (close: () => void) => ReactNode }) {
  const [providers, setProviders] = useState(false);
  const [step, setStep] = useState(1), [kind, setKind] = useState<'single' | ArchitectureKind>(selection.architecture?.kind ?? 'single');
  const [draft, setDraft] = useState(selection), [worker, setWorker] = useState(selection.architecture ? architectureWorker(selection.architecture) : null);
  const [open, setOpen] = useState<string | null>(null), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const label = kind === 'expert-fusion' ? 'Expert' : kind === 'team-fusion' ? 'Worker' : 'Sidekick';
  const valid = Boolean(draft.model && settings.providers.some(provider => provider.id === draft.providerId) && (kind === 'single' || worker?.model && settings.providers.some(provider => provider.id === worker.providerId)));
  async function save() {
    setSaving(true); setError('');
    try { await onSave({ ...draft, architecture: kind === 'single' ? null : selectArchitecture(kind, worker!) }); onClose(); }
    catch (error) { setError(errorMessage(error)); } finally { setSaving(false); }
  }
  if (providers) return renderProviders(() => setProviders(false));
  return <Modal title="Set up Lite" onClose={() => { if (!saving) onClose(); }}>
    <div className="setup-intro"><Logo /><div><p>{step === 1 ? 'How would you like to work?' : 'Choose your models'}</p><small>{step} of 2 · You can change this later.</small></div></div>
    <div className="setup-content">
      {step === 1 ? <div className="setup-options" role="group" aria-label="Architecture">{SETUP_ARCHITECTURES.map(item => <button key={item.kind} className={`setup-option ${kind === item.kind ? 'selected' : ''}`} aria-pressed={kind === item.kind} onClick={() => setKind(item.kind)}><span><strong>{item.name}</strong><small>{item.description}</small></span>{kind === item.kind && <Check size={16} />}</button>)}</div> : <>
        <p className="field-hint">{SETUP_ARCHITECTURES.find(item => item.kind === kind)?.description}</p>
        {!settings.providers.length ? <p className="field-hint">Connect a provider to see its models.</p> : <div className="setup-models">
          <ModelField simple label={kind === 'single' ? 'Model' : 'Driver'} settings={settings} selection={draft} value={draft.model ? draft : null} onChange={route => setDraft({ ...draft, ...route })} onReasoning={() => {}} open={open === 'driver'} onOpen={value => setOpen(value ? 'driver' : null)} />
          {kind !== 'single' && <ModelField simple label={label} settings={settings} selection={draft} value={worker} onChange={setWorker} onReasoning={() => {}} open={open === 'worker'} onOpen={value => setOpen(value ? 'worker' : null)} />}
        </div>}
        <button className="text-button" onClick={() => setProviders(true)}>Manage providers</button>
        <label className="model-setting-row setup-permissions">Permissions<select aria-label="Setup permissions" value={draft.permissionMode} onChange={event => setDraft({ ...draft, permissionMode: event.target.value as 'ask' | 'auto' })}><option value="ask">Ask first</option><option value="auto">Allow all tools</option></select></label>
        <p className="field-hint">{SETUP_PERMISSIONS}</p>
      </>}
      {error && <p role="alert" className="error-text">{error}</p>}
    </div>
    <div className="model-picker-footer"><button className="text-button" disabled={saving} onClick={() => step === 1 ? onClose() : setStep(1)}>{step === 1 ? 'Set up later' : 'Back'}</button><button className="button primary" disabled={saving || step === 2 && !valid} onClick={() => step === 1 ? setStep(2) : void save()}>{saving ? 'Saving…' : step === 1 ? 'Continue' : 'Start with this setup'}</button></div>
  </Modal>;
}
