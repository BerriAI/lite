/** Pure guided-setup flow helpers for the terminal onboarding.
 *
 * The TUI first-run and `/setup` walk-through is architecture-first: choose an
 * arrangement, then a model for each role, then review (optional Advanced/Shunt).
 * These helpers encode the sequential transition rules so they can be
 * unit-tested without a renderer. The OpentUI components in `tui/onboarding.tsx`
 * call them for choices that must stay consistent; they are NOT shared with the
 * browser client, which has its own Onboarding flow.
 */

import type { ModelRoute } from './architectures.js';

export type SetupStep = 'architecture' | 'gateway' | 'driver' | 'worker' | 'review';

type SetupKind = 'single' | 'sidekick-fusion' | 'team-fusion' | 'expert-fusion';

export function isFusion(kind: SetupKind): boolean {
  return kind !== 'single';
}

/** The model-role steps required after the architecture choice, in order.
 * - Single: only the base/driver model; never a supporting model.
 * - Fusion (sidekick/team/expert): a driver plus one supporting model. */
export function modelRoles(kind: SetupKind): Array<'driver' | 'worker'> {
  return isFusion(kind) ? ['driver', 'worker'] : ['driver'];
}

/** Advance after the architecture choice: connect a provider only when needed,
 * otherwise go straight to the driver/base role. */
export function nextAfterArchitecture(providerConnected: boolean): SetupStep {
  return providerConnected ? 'driver' : 'gateway';
}

/** Advance after picking a role's model during the walkthrough.
 * Review edits return directly to review instead. */
export function nextAfterRole(kind: SetupKind, role: 'driver' | 'worker'): SetupStep {
  if (role === 'worker' || !isFusion(kind)) return 'review';
  return 'worker';
}

/** Back from a role step during the initial walkthrough. */
export function backFromRole(role: 'driver' | 'worker'): SetupStep {
  return role === 'worker' ? 'driver' : 'architecture';
}

/** Back from the review screen to the last model role, sequentially. */
export function backFromReview(kind: SetupKind): SetupStep {
  return isFusion(kind) ? 'worker' : 'driver';
}

/** Whether a selected route points at a configured provider on the settings. */
export function routeConfigured(route: ModelRoute | null | undefined, providerConfigured: (id: string) => boolean): boolean {
  return Boolean(route?.model.trim() && providerConfigured(route.providerId));
}

/** Whether saving is allowed from the review step: every required model is
 * configured and any Shunt needs are met. */
export function saveEnabled(args: {
  step: SetupStep;
  kind: SetupKind;
  driver: ModelRoute | null;
  worker: ModelRoute | null;
  shuntOk: boolean;
  providerConfigured: (id: string) => boolean;
}): boolean {
  const { step, kind, driver, worker, shuntOk, providerConfigured } = args;
  if (step !== 'review') return false;
  if (!routeConfigured(driver, providerConfigured)) return false;
  if (isFusion(kind) && !routeConfigured(worker, providerConfigured)) return false;
  return shuntOk;
}
