/** Multi-model architectures (the registry).
 *
 * Litespeed's founding opinion is that a coding harness is intrinsically
 * multi-model: "which model?" is often the wrong question — the right one is
 * "which arrangement of models?". A session can therefore run either a single
 * model or a named ARCHITECTURE: a fixed arrangement of cooperating models
 * with defined roles. Architectures are a discriminated union so future
 * arrangements add variants here without touching the Session shape, and this
 * registry is the single source both pickers (web + terminal) and the server
 * validator consume.
 */

/** The per-session selection persisted on Session.architecture. */
export interface ModelRoute { providerId: string; model: string }
export type ArchitectureSelection =
  | { kind: 'sidekick-fusion'; sidekick: ModelRoute }
  | { kind: 'team-fusion'; worker: ModelRoute; concurrency?: 1 | 2 | 3 | 4 }
  | { kind: 'expert-fusion'; expert: ModelRoute; concurrency?: 1 | 2 | 3 | 4 };
export type ArchitectureKind = ArchitectureSelection['kind'];

/** One selectable model slot an architecture asks the user to fill. */
export interface ArchitectureRole { id: string; label: string; hint?: string }
export interface ArchitectureInfo { kind: ArchitectureKind; name: string; description: string; roles: ArchitectureRole[] }

export const ARCHITECTURES: readonly ArchitectureInfo[] = [
  {
    kind: 'sidekick-fusion',
    name: 'Sidekick Fusion',
    description: 'A lead plans and reviews while a persistent sidekick explores, implements, tests, and repairs.',
    roles: [{ id: 'sidekick', label: 'Sidekick model', hint: 'cheaper/faster' }],
  },
  {
    kind: 'team-fusion', name: 'Team Fusion',
    description: 'A strong lead divides work into scoped assignments for fresh cheaper workers, then verifies the result.',
    roles: [{ id: 'worker', label: 'Worker model', hint: 'cheaper/faster' }],
  },
  {
    kind: 'expert-fusion', name: 'Expert Fusion',
    description: 'A cheaper driver briefs fresh strong experts to implement and repair, and runs verification itself.',
    roles: [{ id: 'expert', label: 'Expert model', hint: 'stronger' }],
  },
] as const;

export function architectureWorker(selection: ArchitectureSelection): ModelRoute {
  return selection.kind === 'sidekick-fusion' ? selection.sidekick : selection.kind === 'team-fusion' ? selection.worker : selection.expert;
}

export function selectArchitecture(kind: ArchitectureKind, route: ModelRoute): ArchitectureSelection {
  return kind === 'sidekick-fusion' ? { kind, sidekick: route } : kind === 'team-fusion' ? { kind, worker: route } : { kind, expert: route };
}

export function architectureInfo(kind: ArchitectureKind): ArchitectureInfo {
  const info = ARCHITECTURES.find(entry => entry.kind === kind);
  if (!info) throw new Error(`Unknown architecture: ${kind}`);
  return info;
}
