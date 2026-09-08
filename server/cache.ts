import { createHash } from 'node:crypto';
import type { CacheDiagnostics, PrefixChangeReason, PrefixShape } from '../shared/cache.js';
import type { ToolDefinition } from '../shared/types.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Hashes the cacheable request prefix. Tool schemas are name-sorted before
 * hashing so an advertisement-order difference alone never reads as a change;
 * the wire order is separately kept stable by the runner. */
export function captureShape(system: string, tools: readonly ToolDefinition[]): PrefixShape {
  const sorted = [...tools].sort((a, b) => a.function.name < b.function.name ? -1 : 1);
  const toolsJson = JSON.stringify(sorted);
  return {
    systemHash: hash(system),
    toolsHash: hash(toolsJson),
    prefixHash: hash(`${hash(system)}\0${hash(toolsJson)}`),
    toolSchemaTokens: Math.ceil(Buffer.byteLength(toolsJson) / 4),
  };
}

/** Compares against the session's previous request shape. `historyReasons` are
 * provider-visible history rewrites since the previous request (compaction,
 * undo/redo) drained by the caller; local-only metadata edits never reach the
 * provider and must not be reported. */
export function compareShape(previous: PrefixShape | undefined, current: PrefixShape, historyReasons: PrefixChangeReason[]): CacheDiagnostics {
  const reasons: PrefixChangeReason[] = [];
  if (!previous) reasons.push('first_turn');
  else {
    if (previous.systemHash !== current.systemHash) reasons.push('system');
    if (previous.toolsHash !== current.toolsHash) reasons.push('tools');
  }
  reasons.push(...historyReasons);
  return { shape: current, prefixChanged: reasons.length > 0, reasons };
}
