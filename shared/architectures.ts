/** Multi-model architectures (the registry).
 *
 * Lite's founding opinion is that a coding harness is intrinsically
 * multi-model: "which model?" is often the wrong question — the right one is
 * "which arrangement of models?". A session can therefore run either a single
 * model or a named ARCHITECTURE: a fixed arrangement of cooperating models
 * with defined roles. Architectures are a discriminated union so future
 * arrangements add variants here without touching the Session shape, and this
 * registry is the single source both pickers (web + terminal) and the server
 * validator consume.
 */

/** The per-session selection persisted on Session.architecture. */
export type ArchitectureSelection = { kind: 'sidekick-fusion'; sidekick: { providerId: string; model: string } };
export type ArchitectureKind = ArchitectureSelection['kind'];

/** One selectable model slot an architecture asks the user to fill. */
export interface ArchitectureRole { id: string; label: string; hint?: string }
export interface ArchitectureInfo { kind: ArchitectureKind; name: string; description: string; roles: ArchitectureRole[] }

export const ARCHITECTURES: readonly ArchitectureInfo[] = [
  {
    kind: 'sidekick-fusion',
    name: 'Sidekick Fusion',
    description: 'A frontier main agent plans, delegates, and reviews while a cheaper persistent sidekick explores, writes code, and fixes bugs — two cached contexts working in parallel.',
    roles: [{ id: 'sidekick', label: 'Sidekick model', hint: 'cheaper/faster' }],
  },
] as const;

export function architectureInfo(kind: ArchitectureKind): ArchitectureInfo {
  const info = ARCHITECTURES.find(entry => entry.kind === kind);
  if (!info) throw new Error(`Unknown architecture: ${kind}`);
  return info;
}
