import { ARCHITECTURES } from './architectures.js';

/** Keep the first-run explanations identical in both clients. */
export const SETUP_ARCHITECTURES = [
  { kind: 'single' as const, name: 'Single model', description: 'One model does everything. The simplest way to start.' },
  { ...ARCHITECTURES[0], description: 'A driver plans and reviews. One sidekick does the work and remembers context.' },
  { ...ARCHITECTURES[1], description: 'A driver splits work among parallel workers. Use a faster, cheaper worker model.' },
  { ...ARCHITECTURES[2], description: 'A lighter driver calls stronger experts for hard tasks, then checks their work.' },
];
export const SETUP_PERMISSIONS = 'Ask first lets you review actions. Allow all tools runs without routine approval prompts. Explicit project rules still apply.';
