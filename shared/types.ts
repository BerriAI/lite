import type { HistoryState } from './history.js';
import type { DelegationSummary } from './delegation.js';
export type { DelegationSummary, DelegationStatus, DelegationDetail } from './delegation.js';
import type { ActiveProfile } from './profiles.js';
export type { ActiveProfile, ProfileChoice, ProfileCatalog, ProfileDetail } from './profiles.js';
import type { ContextSnapshot } from './context.js';
export type { ContextSnapshot } from './context.js';
import type { QuestionRequest } from './questions.js';
export type { QuestionOption, QuestionRequest, QuestionAnswer, QuestionResolution, AnswerReceipt } from './questions.js';
import type { PermissionRuleSet, RuleMatch } from './permissions.js';
export type { PermissionDecision, PermissionRule, PermissionRuleSet, RuleMatch } from './permissions.js';
import type { SessionGoal } from './goals.js';
export type { SessionGoal, GoalStatus, GoalReportStatus } from './goals.js';
import type { TurnReceipts } from './receipts.js';
export type { TurnReceipts } from './receipts.js';
import type { HookConfig } from './hooks.js';
export type { HookConfig, HookEvent } from './hooks.js';
import type { PluginRegistryEntry } from './plugins.js';
export type { PluginRegistryEntry, PluginItem, InstallAction, InstallPlan, UninstallResult } from './plugins.js';
import type { SidecarConfig } from './sidecars.js';
export type { SidecarConfig, SidecarEvent } from './sidecars.js';
import type { ArchitectureSelection } from './architectures.js';
export type { ArchitectureSelection, ArchitectureKind, ArchitectureInfo, ArchitectureRole } from './architectures.js';

export type Mode = 'build' | 'plan';
export type PermissionMode = 'ask' | 'auto';
export type RunStatus = 'idle' | 'running' | 'waiting' | 'error';
export type ProviderKind = 'openai' | 'anthropic' | 'codex';
export interface Provider { id: string; name: string; kind: ProviderKind; baseUrl: string; apiKey?: string; configured?: boolean; models?: string[]; contextWindows?: Record<string, number>; }
export interface Model { id: string; name: string; providerId: string; contextWindow?: number; maxInputTokens?: number; }
export interface Settings { mcpConfigRevision?: string; providers: Provider[]; defaultProvider: string; defaultModel: string; workspace: string; permissionMode: PermissionMode; maxSteps: number; theme: 'system' | 'light' | 'dark'; mcpServers: Record<string, McpServerConfig>; permissionRules?: PermissionRuleSet; memoryEnabled?: boolean;
  /** Lifecycle hooks configured at the app level (design note 4.3). */
  hooks?: HookConfig[];
  /** Canonical (realpath) workspace paths the user marked trusted. Project
   * .lite/hooks.json only runs for a workspace listed here. */
  trustedWorkspaces?: string[];
  /** Installed plugin registry (design note 4.4): per-plugin provenance so
   * uninstall removes exactly the items an install recorded. */
  plugins?: Record<string, PluginRegistryEntry>;
  /** Sidecar extensions (design note 4.5): app-level ONLY in v1 — a project
   * sidecar would need the workspace-trust gate project hooks use (deferred). */
  sidecars?: SidecarConfig[];
  /** OS notifications on turn seal / waiting-for-input. Default false (opt-in).
   * Read LIVE at each notification moment, never captured into a turn policy:
   * it is a preference about the user's desktop, not a property of the accepted
   * turn, so flipping it mid-response takes effect immediately. */
  notifications?: boolean; }
/** advertise: true opts this server's tools back into DIRECT tool-array
 * advertisement (decode-time schemas, prefix churn on catalog change). Default
 * false routes them through the fixed-schema capability gateway so connect/
 * refresh/disconnect never reshapes the advertised tool array
 * (docs/design-capability-proxy.md, Option 3). */
export interface McpServerConfig { command?: string; args?: string[]; env?: Record<string,string>; url?: string; enabled?: boolean; advertise?: boolean; }
export interface Session { profile?: ActiveProfile; configRevision?: number; id: string; title: string; workspace: string; model: string; providerId: string; mode: Mode; permissionMode: PermissionMode; createdAt: number; updatedAt: number; status: RunStatus; archived: boolean; parentId?: string;
  /** Session goal (goal mode): persists on the session; see shared/goals.ts. */
  goal?: SessionGoal;
  /** Optional planner half of a planner+executor pair. Plan-mode turns run on
   * this pair; Build turns run on the session providerId/model (the executor).
   * A model-routing decision only — workspace, permissions, and profile are shared. */
  planner?: { providerId: string; model: string };
  /** Multi-model architecture selection (shared/architectures.ts). When set,
   * the session runs as that arrangement of models — e.g. Sidekick Fusion pairs
   * the session providerId/model (the main agent) with a cheaper persistent
   * sidekick. Changing it is an idle-only config change with a revision bump,
   * exactly like changing the model. */
  architecture?: ArchitectureSelection;
  /** Output style (5.7): a built-in name (shared/styles.ts OUTPUT_STYLES) or a
   * workspace .lite/styles/<name>.md file name. Resolved at turn ACCEPTANCE
   * into the captured policy (like guidance); appended to the system prompt
   * tail so it stays in the cached prefix. Changing it is an idle-only config
   * change with a revision bump, exactly like changing the model. */
  outputStyle?: string; }
export interface ToolCall { delegationId?: string; ruleMatch?: RuleMatch; id: string; name: string; args: Record<string,unknown>; status: 'pending' | 'running' | 'completed' | 'error' | 'denied'; output?: string; startedAt?: number; endedAt?: number;
  /** Sidecar interception attribution (design note 4.5): present iff a sidecar
   * modified this call. `args` above are the MODIFIED (executed) arguments;
   * the unmodified original is preserved here so the interception is auditable
   * in the transcript and visibly attributed on the activity card. */
  intercepted?: { by: string; originalArgs: Record<string,unknown>; reason: string }; }
export interface Attachment { name: string; path?: string; content?: string; mimeType?: string; dataUrl?: string; }
export interface Message { context?: ContextSnapshot; activity?: string; providerMetadata?: Record<string,unknown>; id: string; sessionId: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; reasoning?: string; toolCalls?: ToolCall[]; toolCallId?: string; createdAt: number; attachments?: Attachment[]; usage?: Usage; error?: string;
  /** Host-computed end-of-turn evidence account. Only on the FINAL assistant message of a completed root turn; observation only, never persisted for children. */
  receipts?: TurnReceipts; }
export interface Usage { inputTokens: number; outputTokens: number; cachedTokens?: number; cost?: number; durationMs?: number; }
export interface Todo { id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; }
export interface PermissionRequest { id: string; sessionId: string; toolCallId: string; tool: string; args: Record<string,unknown>; description: string; }
export interface FileEntry { name: string; path: string; type: 'file' | 'directory'; size?: number; }
export interface FileChange { path: string; before: string | null; after: string | null; }
export interface QueuedMessage { id: string; sessionId: string; content: string; attachments: Attachment[]; createdAt: number; }
export interface QueueState { items: QueuedMessage[]; paused: boolean; reason?: string; manualPause?: boolean; }
export interface BackgroundJob { id: string; command: string; status: 'running' | 'exited' | 'killed' | 'failed'; pid?: number; startedAt: number; endedAt?: number; exitCode?: number; signal?: string; timedOut: boolean; truncated: boolean; }
export interface SessionDetail { delegations?: DelegationSummary[]; lastEventId?: number; session: Session; messages: Message[]; todos: Todo[]; permissions: PermissionRequest[]; questions?: QuestionRequest[]; queue?: QueueState; history?: HistoryState; jobs?: BackgroundJob[]; }
export interface RunEvent { id?: number; type: 'session' | 'delegation' | 'message' | 'delta' | 'reasoning' | 'tool' | 'permission' | 'permission_resolved' | 'question' | 'question_resolved' | 'todos' | 'reset' | 'queue' | 'history' | 'done' | 'error'; sessionId: string; data: any; }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string,unknown> }; }
export interface StreamChunk { type: 'text' | 'reasoning' | 'tool' | 'usage' | 'metadata'; metadata?: Record<string,unknown>; text?: string; tool?: { index: number; id?: string; name?: string; arguments?: string }; usage?: Usage; }
/** One provider-reported usage record (5.1). Token counts are whatever the
 * provider stream reported — Lite never estimates here, and no cost is
 * computed (there is no rate card in v1; document, don't guess). cachedTokens
 * is absent when the provider did not report it, never invented as 0. */
export interface UsageLogEntry { sessionId: string; providerId: string; model: string; inputTokens: number; outputTokens: number; cachedTokens?: number; }
/** One day+provider+model aggregate from usageSummary. */
export interface UsageSummaryRow { day: string; providerId: string; model: string; inputTokens: number; outputTokens: number; cachedTokens?: number; requests: number; }
export interface UsageTotals { inputTokens: number; outputTokens: number; cachedTokens?: number; requests: number; }
/** GET /api/usage response: newest day first, entries grouped per provider+model. */
export interface UsageReport { days: { day: string; entries: { providerId: string; model: string; inputTokens: number; outputTokens: number; cachedTokens?: number; requests: number }[]; totals: UsageTotals }[]; totals: UsageTotals; }
