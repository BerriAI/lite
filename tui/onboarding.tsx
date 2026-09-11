/** @jsxImportSource @opentui/react */
import { useState, useSyncExternalStore } from 'react';
import { architectureWorker, selectArchitecture, type ArchitectureKind, type ModelRoute } from '../shared/architectures.js';
import { SETUP_ARCHITECTURES, modelGuidance, providerIsConfigured, roleGuidance, roleStepTitle } from '../shared/setup.js';
import { SHUNT_DESCRIPTION, SHUNT_MODEL_HINT, shuntConfigured, type ShuntSelection } from '../shared/shunt.js';
import {
  backFromReview, backFromRole, modelRoles, nextAfterArchitecture, nextAfterRole, saveEnabled, type SetupStep,
} from '../shared/setupFlow.js';
import type { Session } from '../shared/types.js';
import type { TerminalController } from './controller.js';
import { Menu } from './ui.js';
import { ModelChooser, ShuntSettings } from './models.js';
import { GatewaySetup } from './gateway.js';
import { Providers } from './providers.js';

const workerLabel = (kind: 'single' | ArchitectureKind) => kind === 'expert-fusion' ? 'Expert' : kind === 'team-fusion' ? 'Worker' : 'Sidekick';

export function Onboarding({ controller, initial, onClose, quick = false }: { controller: TerminalController; quick?: boolean; initial: Session; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [step, setStep] = useState<SetupStep>('architecture'), [kind, setKind] = useState<'single' | ArchitectureKind>(initial.architecture?.kind ?? (quick || !initial.model ? 'sidekick-fusion' : 'single'));
  const [from, setFrom] = useState<'walkthrough' | 'review'>('walkthrough');
  const [shunt, setShunt] = useState<ShuntSelection>(initial.shunt ?? { enabled: false });
  const [driver, setDriver] = useState<ModelRoute>({ providerId: initial.providerId, model: initial.model });
  const [worker, setWorker] = useState<ModelRoute | null>(initial.architecture ? architectureWorker(initial.architecture) : null);
  const [permissionMode, setPermissionMode] = useState(initial.permissionMode), [view, setView] = useState<'main' | 'providers' | 'advanced'>('main');
  const [revision, setRevision] = useState(initial.configRevision ?? 0);

  if (!state.settings) return null;
  const back = () => setView('main');
  if (view === 'providers') return <Providers controller={controller} onClose={back} />;
  if (view === 'advanced') return <ShuntSettings controller={controller} settings={state.settings} value={shunt} onChange={setShunt} onClose={back} />;

  const hasConfigured = state.settings.providers.some(provider => providerIsConfigured(provider));
  const providerConfigured = (id: string) => state.settings!.providers.some(provider => provider.id === id && providerIsConfigured(provider));
  const roles = modelRoles(kind);
  const defaultProviderId = state.settings.defaultProvider || state.settings.providers[0]?.id || 'litellm';

  // Transition helpers shared by the role pickers and the review rows.
  const openRole = (role: 'driver' | 'worker', editing: boolean) => { setFrom(editing ? 'review' : 'walkthrough'); setStep(role); };
  const onRoleChange = (role: 'driver' | 'worker', route: ModelRoute) => {
    if (role === 'driver') setDriver(route); else setWorker(route);
    setStep(from === 'review' ? 'review' : nextAfterRole(kind, role));
  };
  const onRoleClose = (role: 'driver' | 'worker') => setStep(from === 'review' ? 'review' : backFromRole(role));

  if (step === 'architecture') {
    return <Menu title="How would you like to work?" search={false} onClose={onClose} footer="Choose how to work first. You can change this later with /setup." items={
      SETUP_ARCHITECTURES.map(item => ({ id: item.kind, label: `${kind === item.kind ? '● ' : '○ '}${item.name}${item.recommended ? ' · Recommended' : ''}`, description: item.description, action: () => { setKind(item.kind); setFrom('walkthrough'); setStep(nextAfterArchitecture(hasConfigured)); } }))
    } />;
  }

  if (step === 'gateway') {
    return <GatewaySetup quick={quick} controller={controller} settings={state.settings} providerId={driver.providerId || defaultProviderId} onClose={() => setStep('architecture')} onProviders={() => setView('providers')} onContinue={providerId => { setDriver(current => ({ providerId, model: current.providerId === providerId ? current.model : '' })); setStep(nextAfterArchitecture(true)); }} onConnected={result => {
      setDriver(current => ({ providerId: result.providerId, model: current.providerId === result.providerId && result.models.some(model => model.id === current.model) ? current.model : '' }));
      setWorker(current => current?.providerId === result.providerId && result.models.some(model => model.id === current.model) ? current : null);
      setShunt(current => current.enabled && current.model.providerId === result.providerId && !result.models.some(model => model.id === current.model.model) ? { ...current, model: { providerId: result.providerId, model: '' } } : current);
      setFrom('walkthrough'); setStep(nextAfterArchitecture(true));
    }} />;
  }

  if (step === 'driver' || step === 'worker') {
    const isDriver = step === 'driver';
    const role = (isDriver ? 'driver' : 'worker') as 'driver' | 'worker';
    return <ModelChooser key={`${kind}:${role}`} simple={quick && state.settings.providers.length === 1} guidance={roleGuidance(kind, role)} onChangeGateway={() => setStep('gateway')} controller={controller} settings={state.settings} title={roleStepTitle(kind, role)} value={isDriver ? driver : worker ?? { providerId: driver.providerId || defaultProviderId, model: '' }} onClose={() => onRoleClose(role)} onChange={route => onRoleChange(role, route)} />;
  }

  // Review
  const canSave = saveEnabled({ step, kind, driver, worker, shuntOk: shuntConfigured(shunt, state.settings.providers), providerConfigured });
  return <Menu title="Review your setup" search={false} onClose={() => { setFrom('walkthrough'); setStep(backFromReview(kind)); }} footer={state.notice || `${SHUNT_DESCRIPTION} Use /models for advanced options.`} items={[
    { id: 'architecture', label: `Architecture: ${SETUP_ARCHITECTURES.find(item => item.kind === kind)!.name}`, description: SETUP_ARCHITECTURES.find(item => item.kind === kind)!.description, action: () => { setFrom('walkthrough'); setStep('architecture'); } },
    { id: 'driver', label: `${kind === 'single' ? 'Model' : 'Driver'}: ${driver.model || 'Choose a model'}`, description: modelGuidance(kind, 'driver'), action: () => openRole('driver', true) },
    ...(roles.includes('worker') ? [{ id: 'worker', label: `${workerLabel(kind)}: ${worker?.model || 'Choose a model'}`, description: modelGuidance(kind, 'worker'), action: () => openRole('worker', true) }] : []),
    { id: 'advanced', label: `Advanced settings · Shunt ${shunt.enabled ? 'On' : 'Off'}`, description: `${SHUNT_DESCRIPTION} ${shunt.enabled && !shuntConfigured(shunt, state.settings.providers) ? 'Choose a Shunt model to enable it.' : SHUNT_MODEL_HINT}`, action: () => setView('advanced') },
    ...(!quick ? [{ id: 'providers', label: 'Manage providers', description: 'Connect an API or sign in to ChatGPT', action: () => setView('providers') },
    { id: 'permissions', label: `Permissions: ${permissionMode === 'auto' ? 'Allow all tools' : 'Ask first'}`, description: permissionMode === 'ask' ? 'Review actions and remember tools you trust' : 'No routine prompts; explicit project rules still apply', action: () => setPermissionMode(permissionMode === 'auto' ? 'ask' : 'auto') }] : []),
    { id: 'save', label: state.pending ? 'Saving…' : quick ? 'Start chatting' : 'Start with this setup', separatorBefore: true, disabled: Boolean(state.pending) || !canSave, action: () => { void save(); } },
  ]} />;

  async function save() {
    const patch = { ...driver, architecture: kind === 'single' ? null : worker ? selectArchitecture(kind, worker) : null, permissionMode, shunt };
    if (!await controller.configure(patch, revision)) return;
    setRevision(controller.detail!.session.configRevision ?? 0);
    if (await controller.action('Remembering setup', () => controller.client.api('/workspace-preferences', { ...controller.detail!.session, ...patch, setupComplete: true }))) onClose();
  }
}
