import type { ToolDefinition } from '../shared/types.js';
import type { McpServerStatus } from '../shared/mcp.js';

/** A turn's immutable catalog and connection identity; never resolves a name
 * against a later configuration. Releasing invalidates this handle only. */
export interface ExternalToolLease {
  readonly definitions: readonly ToolDefinition[];
  scope(name: string): string;
  assertCurrent(name: string): void;
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  release(): void;
}
export interface ExternalTools {
  /** Synchronous, cache-only: cannot connect, discover, or await tools/list. */
  capture(signal: AbortSignal): ExternalToolLease;
  status?(): McpServerStatus[];
  configRevision?(): string;
  refresh?(name: string, expectedRevision: string, signal: AbortSignal): Promise<McpServerStatus[]>;
  reconnect?(name: string, expectedRevision: string, signal: AbortSignal): Promise<McpServerStatus[]>;
  close?(): Promise<void>;
}
