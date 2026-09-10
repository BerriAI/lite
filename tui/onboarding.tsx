/** @jsxImportSource @opentui/react */
import { useState, useSyncExternalStore } from 'react';
import { architectureWorker, selectArchitecture, type ArchitectureKind } from '../shared/architectures.js';
import { SETUP_ARCHITECTURES } from '../shared/setup.js';
import type { Session } from '../shared/types.js';
import type { TerminalController } from './controller.js';
import { Menu } from './ui.js';
import { ModelChooser } from './models.js';
import { Providers } from './providers.js';

export function Onboarding({ controller, initial, onClose }: { controller: TerminalController; initial: Session; onClose: () => void }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [step, setStep] = useState(1), [kind, setKind] = useState<'single' | ArchitectureKind>(initial.architecture?.kind ?? 'single');
  const [driver, setDriver] = useState({ providerId: initial.providerId, model: initial.model });
  const [worker, setWorker] = useState(initial.architecture ? architectureWorker(initial.architecture) : null);
  const [permissionMode, setPermissionMode] = useState(initial.permissionMode), [view, setView] = useState('main');
  const [revision, setRevision] = useState(initial.configRevision ?? 0);
  const label = kind === 'expert-fusion' ? 'Expert' : kind === 'team-fusion' ? 'Worker' : 'Sidekick';
  const back = () => setView('main');
  if (!state.settings) return null;
  if (view === 'providers') return <Providers controller={controller} onClose={back} />;
  if (view === 'driver' || view === 'worker') return <ModelChooser controller={controller} settings={state.settings} title={view === 'driver' ? kind === 'single' ? 'Model' : 'Driver' : label} value={view === 'worker' ? worker ?? driver : driver} onClose={back} onChange={route => { if (view === 'worker') setWorker(route); else setDriver(route); back(); }} />;
  async function save() {
    const patch = { ...driver, architecture: kind === 'single' ? null : selectArchitecture(kind, worker!), permissionMode };
    if (!await controller.configure(patch, revision)) return;
    setRevision(controller.detail!.session.configRevision ?? 0);
    if (await controller.action('Remembering setup', () => controller.client.api('/workspace-preferences', { ...controller.detail!.session, ...patch, setupComplete: true }))) onClose();
  }
  if (step === 1) return <Menu title="Set up Lite · 1 of 2" search={false} onClose={onClose} footer="Choose how to work. You can change this later with /setup." items={[
    ...SETUP_ARCHITECTURES.map(item => ({ id: item.kind, label: `${kind === item.kind ? '●' : '○'} ${item.name}`, description: item.description, action: () => { setKind(item.kind); setStep(2); } })),
    { id: 'later', label: 'Set up later', action: onClose },
  ]} />;
  return <Menu title="Choose your models · 2 of 2" search={false} onClose={() => setStep(1)} footer={state.notice || 'Saved for this workspace in both clients. /models has advanced options.'} items={[
    { id: 'architecture', label: SETUP_ARCHITECTURES.find(item => item.kind === kind)!.name, description: 'Change architecture', action: () => setStep(1) },
    { id: 'driver', label: `${kind === 'single' ? 'Model' : 'Driver'}: ${driver.model || 'Choose a model'}`, description: kind === 'single' ? 'Handles the whole task' : 'Plans, coordinates, and reviews', action: () => setView('driver') },
    ...(kind === 'single' ? [] : [{ id: 'worker', label: `${label}: ${worker?.model || 'Choose a model'}`, description: kind === 'expert-fusion' ? 'A stronger model for difficult assignments' : 'A faster model for delegated work', action: () => setView('worker') }]),
    { id: 'providers', label: 'Manage providers', description: 'Connect an API or sign in to ChatGPT', action: () => setView('providers') },
    { id: 'permissions', label: `Permissions: ${permissionMode === 'auto' ? 'Allow all tools' : 'Ask first'}`, description: permissionMode === 'ask' ? 'Review actions and remember tools you trust' : 'No routine prompts; explicit project rules still apply', action: () => setPermissionMode(permissionMode === 'auto' ? 'ask' : 'auto') },
    { id: 'save', label: state.pending ? 'Saving…' : 'Start with this setup', separatorBefore: true, disabled: Boolean(state.pending) || !driver.model || !state.settings.providers.some(provider => provider.id === driver.providerId) || kind !== 'single' && (!worker?.model || !state.settings.providers.some(provider => provider.id === worker.providerId)), action: () => { void save(); } },
  ]} />;
}
