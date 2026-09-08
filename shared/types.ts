export type Mode = 'build' | 'plan';
export type PermissionMode = 'ask' | 'auto';
export type RunStatus = 'idle' | 'running' | 'waiting' | 'error';
export type ProviderKind = 'openai' | 'anthropic' | 'codex';
export interface Provider { id: string; name: string; kind: ProviderKind; baseUrl: string; apiKey?: string; configured?: boolean; models?: string[]; }
export interface Model { id: string; name: string; providerId: string; contextWindow?: number; }
export interface Settings { providers: Provider[]; defaultProvider: string; defaultModel: string; workspace: string; permissionMode: PermissionMode; maxSteps: number; theme: 'system' | 'light' | 'dark'; mcpServers: Record<string, McpServerConfig>; }
export interface McpServerConfig { command?: string; args?: string[]; env?: Record<string,string>; url?: string; enabled?: boolean; }
export interface Session { id: string; title: string; workspace: string; model: string; providerId: string; mode: Mode; permissionMode: PermissionMode; createdAt: number; updatedAt: number; status: RunStatus; archived: boolean; parentId?: string; }
export interface ToolCall { id: string; name: string; args: Record<string,unknown>; status: 'pending' | 'running' | 'completed' | 'error' | 'denied'; output?: string; startedAt?: number; endedAt?: number; }
export interface Attachment { name: string; path?: string; content?: string; mimeType?: string; dataUrl?: string; }
export interface Message { providerMetadata?: Record<string,unknown>; id: string; sessionId: string; role: 'user' | 'assistant' | 'tool' | 'system'; content: string; reasoning?: string; toolCalls?: ToolCall[]; toolCallId?: string; createdAt: number; attachments?: Attachment[]; usage?: Usage; error?: string; }
export interface Usage { inputTokens: number; outputTokens: number; cachedTokens?: number; cost?: number; durationMs?: number; }
export interface Todo { id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; }
export interface PermissionRequest { id: string; sessionId: string; toolCallId: string; tool: string; args: Record<string,unknown>; description: string; }
export interface FileEntry { name: string; path: string; type: 'file' | 'directory'; size?: number; }
export interface FileChange { path: string; before: string | null; after: string | null; }
export interface SessionDetail { lastEventId?: number; session: Session; messages: Message[]; todos: Todo[]; permissions: PermissionRequest[]; }
export interface RunEvent { id?: number; type: 'session' | 'message' | 'delta' | 'reasoning' | 'tool' | 'permission' | 'permission_resolved' | 'todos' | 'done' | 'error'; sessionId: string; data: any; }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string,unknown> }; }
export interface StreamChunk { type: 'text' | 'reasoning' | 'tool' | 'usage' | 'metadata'; metadata?: Record<string,unknown>; text?: string; tool?: { index: number; id?: string; name?: string; arguments?: string }; usage?: Usage; }
