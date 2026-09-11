/** @jsxImportSource @opentui/react */
import { useState, useSyncExternalStore } from 'react';
import { architectureWorker, selectArchitecture, type ArchitectureKind } from '../shared/architectures.js';
import { SETUP_ARCHITECTURES, modelGuidance } from '../shared/setup.js';
import type { Session } from '../shared/types.js';
import type { TerminalController } from './controller.js';
import { Menu } from './ui.js';
import { SHUNT_DESCRIPTION, shuntConfigured, type ShuntSelection } from '../shared/shunt.js';
import { ModelChooser, ShuntSettings } from './models.js';
import { GatewaySetup } from './gateway.js';
import { Providers } from './providers.js';

export function Onboarding({ controller, initial, onClose, quick = false }: { controller: TerminalController; quick?: boolean; initial: Session; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [step, setStep] = useState(quick && state.settings?.providers.some(p => p.id === initial.providerId && p.baseUrl) ? 2 : 0), [kind, setKind] = useState<'single' | ArchitectureKind>(initial.architecture?.kind ?? (quick || !initial.model ? 'sidekick-fusion' : 'single'));
  const [shunt,setShunt]=useState<ShuntSelection>(initial.shunt??{enabled:false});
  const [driver, setDriver] = useState({ providerId: initial.providerId, model: initial.model });
  const [worker, setWorker] = useState(initial.architecture ? architectureWorker(initial.architecture) : null);
  const [permissionMode, setPermissionMode] = useState(initial.permissionMode), [view, setView] = useState('main');
  const [revision, setRevision] = useState(initial.configRevision ?? 0);
  const label = kind === 'expert-fusion' ? 'Expert' : kind === 'team-fusion' ? 'Worker' : 'Sidekick';
  const back = () => setView('main');
  if (!state.settings) return null;
  if(view==='advanced')return <ShuntSettings controller={controller} settings={state.settings} value={shunt} onChange={setShunt} onClose={back}/>;
  if (view === 'providers') return <Providers controller={controller} onClose={back} />;
  if (view === 'driver' || view === 'worker') return <ModelChooser simple={quick && state.settings.providers.length === 1} feedback={modelGuidance(kind, view === 'worker' ? 'worker' : 'driver')} controller={controller} settings={state.settings} title={view === 'driver' ? kind === 'single' ? 'Model' : 'Driver' : label} value={view === 'worker' ? worker ?? driver : driver} onClose={back} onChange={route => { if (view === 'worker') setWorker(route); else setDriver(route); back(); }} />;
  async function save(route = driver) {
    const patch = { ...route, architecture: kind === 'single' ? null : selectArchitecture(kind, worker!), permissionMode, shunt };
    if (!await controller.configure(patch, revision)) return;
    setRevision(controller.detail!.session.configRevision ?? 0);
    if (await controller.action('Remembering setup', () => controller.client.api('/workspace-preferences', { ...controller.detail!.session, ...patch, setupComplete: true }))) onClose();
  }
  if (step === 0) return <GatewaySetup quick={quick} controller={controller} settings={state.settings} providerId={driver.providerId} onClose={onClose} onProviders={() => setView('providers')} onContinue={providerId => { setDriver(current => ({providerId,model: current.providerId === providerId ? current.model : ''})); setStep(1); }} onConnected={result => {
    setDriver(current => ({providerId: result.providerId, model: current.providerId === result.providerId && result.models.some(model => model.id === current.model) ? current.model : ''}));
    setWorker(current => current?.providerId === result.providerId && result.models.some(model => model.id === current.model) ? current : null);
    setStep(quick ? 2 : 1);
    setShunt(current=>current.enabled&&current.model.providerId===result.providerId&&!result.models.some(model=>model.id===current.model.model)?{...current,model:{providerId:result.providerId,model:''}}:current);
  }} />;
  if (step === 1) return <Menu title="Set up Litespeed · 2 of 3" search={false} onClose={() => setStep(0)} footer="Choose how to work. You can change this later with /setup." items={[
    ...SETUP_ARCHITECTURES.map(item => ({ id: item.kind, label: `${kind === item.kind ? '●' : '○'} ${item.name}${item.recommended ? ' · Recommended' : ''}`, description: item.description, action: () => { setKind(item.kind); setStep(2); } })),
    { id: 'back', label: 'Back to gateway', action: () => setStep(0) },
  ]} />;
  return <Menu title={quick ? "Choose your setup" : "Choose your models · 3 of 3"} search={false} onClose={() => setStep(1)} footer={state.notice || 'Saved for this workspace in both clients. /models has advanced options.'} items={[
    { id: 'architecture', label: SETUP_ARCHITECTURES.find(item => item.kind === kind)!.name, description: kind === 'sidekick-fusion' ? 'Recommended · Change setup' : 'Change setup', action: () => setStep(1) },
    { id: 'driver', label: `${kind === 'single' ? 'Model' : 'Driver'}: ${driver.model || 'Choose a model'}`, description: modelGuidance(kind, 'driver'), action: () => setView('driver') },
    ...(kind === 'single' ? [] : [{ id: 'worker', label: `${label}: ${worker?.model || 'Choose a model'}`, description: modelGuidance(kind, 'worker'), action: () => setView('worker') }]),
    {id:'advanced',label:`Advanced settings · Shunt ${shunt.enabled?'On':'Off'}`,description:SHUNT_DESCRIPTION,action:()=>setView('advanced')},
    ...(!quick ? [{ id: 'providers', label: 'Manage providers', description: 'Connect an API or sign in to ChatGPT', action: () => setView('providers') },
    { id: 'permissions', label: `Permissions: ${permissionMode === 'auto' ? 'Allow all tools' : 'Ask first'}`, description: permissionMode === 'ask' ? 'Review actions and remember tools you trust' : 'No routine prompts; explicit project rules still apply', action: () => setPermissionMode(permissionMode === 'auto' ? 'ask' : 'auto') }] : []),
    { id: 'save', label: state.pending ? 'Saving…' : quick ? 'Start chatting' : 'Start with this setup', separatorBefore: true, disabled: Boolean(state.pending) || !shuntConfigured(shunt,state.settings.providers) || !driver.model || !state.settings.providers.some(provider => provider.id === driver.providerId) || kind !== 'single' && (!worker?.model || !state.settings.providers.some(provider => provider.id === worker.providerId)), action: () => { void save(); } },
  ]} />;
}
