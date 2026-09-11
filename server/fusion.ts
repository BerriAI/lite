import type { ArchitectureSelection } from '../shared/architectures.js';
import type { ToolDefinition } from '../shared/types.js';

const definition = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });

export const delegateTool = definition('delegate',
  'Assign bounded implementation work to a fresh worker. It receives only this brief and workspace access, never a fork of your conversation. Include the outcome, relevant paths, constraints, and acceptance checks in the prompt. Every assignment and repair has a new context. Review its actual changes and run verification after it returns.',
  { repairOf: {type:'string',description:'Finished invocation ID from this turn that this assignment repairs, including completed work with issues found during review. Omit for a new assignment.'}, description: { type: 'string', description: 'Short activity label.' }, prompt: { type: 'string', description: 'Self-contained assignment, relevant paths, constraints, and acceptance criteria.' } }, ['description', 'prompt']);
export const verifyTool = definition('verify',
  'Run one foreground test, typecheck, lint, or build command in the workspace. This is the driver verification phase. Shell operators, environment assignments, background jobs, and arbitrary scripts are unavailable. Use a supported runner such as npm test, npm run check, npx vitest run, pytest, cargo test, or go test.',
  { command: { type: 'string' }, timeout_ms: { type: 'number' } }, ['command']);
export const takeoverTool = definition('takeover',
  'Request an explicit bounded fallback after a worker failed or its budget was exhausted. Explain the blocker and list the exact files you need to repair. If approved, up to three write_file/edit_file calls are allowed this turn for those files. Verification remains separate.',
  { invocationId: {type:'string',description:'The failed invocation being taken over. Required when more than one assignment failed.'}, reason: { type: 'string' }, files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 } }, ['reason', 'files']);

export function verificationCommand(args: Record<string, unknown>): Record<string, unknown> {
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  // A deliberately small command grammar. Test scripts are workspace code,
  // still subject to approval, not a security sandbox or a read-only promise.
  if (!/^[a-zA-Z0-9_./:@=+ ,*?-]+$/.test(command) || !/^(?:npm (?:test|run (?:test(?::[\w-]+)?|check|typecheck|lint|build))|pnpm (?:test|check|typecheck|lint|build)|yarn (?:test|check|typecheck|lint|build)|npx (?:vitest|tsc|playwright test|eslint)|(?:python(?:3)? -m )?pytest|cargo (?:test|check|clippy)|go test|make (?:test|check))(?= |$)/.test(command)) {
    throw new Error('Use one supported verification command without shell operators. Delegate other commands to a worker.');
  }
  if (command.split(/\s+/).some(arg => arg === '--config' || arg === '-c' || arg === '--eval' || arg === '-e')) throw new Error('Inline code and configuration overrides are unavailable in driver verification.');
  return { command, timeout_ms: args.timeout_ms, run_in_background: false };
}

export function fusionInstructions(architecture: ArchitectureSelection, child: boolean): string {
  if (child) return architecture.kind === 'expert-fusion'
    ? 'You are a fresh implementation expert. Work only on this self-contained assignment; do not assume access to the driver conversation. Inspect the relevant code and implement the bounded change. End with changed paths, remaining risks, and recommended checks. The driver owns final verification and will create a fresh expert for any repair. Do not delegate or ask the user questions.'
    : 'You are a fresh task-scoped worker. Inspect the relevant code, implement this assignment, and run its acceptance checks. Fix failures within this assignment budget. Report changed paths, exact checks and outcomes, and remaining blockers. You have no earlier worker or driver conversation. Do not delegate or ask the user questions.';
  return `This session uses ${architecture.kind === 'expert-fusion' ? 'Expert Fusion. You are the cheaper DRIVER; strong experts implement and repair' : 'Team Fusion. You are the strong LEAD; cheaper workers implement scoped assignments'}. For implementation, call delegate with a self-contained brief, relevant paths, constraints, and acceptance checks. Each call starts a fresh context: supply selected evidence, never ask for a conversation fork. Delegate code changes automatically without requiring the user to request workers. Read only what you need to plan and review. After delegation, inspect the changes and use verify to run relevant checks against the combined workspace. If verification fails, give a fresh worker the failure evidence and a bounded repair brief. When repairing a failed invocation, pass its ID as repairOf so the host can track resolution. Earlier failures do not prove the current result failed or passed. Stop within the aggregate budget and report unresolved evidence honestly. Source edits belong to workers. The takeover tool is an explicit, approved, three-edit fallback for a demonstrated worker blocker; record why it was needed. Ordinary conversational answers need no worker.`;
}
