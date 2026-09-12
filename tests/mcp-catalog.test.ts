import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { searchMcpTools, inspectMcpTool, mcpSignature } from '../server/mcp-catalog.js';
import type { ExternalToolLease } from '../server/external.js';
import type { ToolDefinition } from '../shared/types.js';

const tool = (name: string, description: string): ToolDefinition => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } } });
const lease = (definitions: ToolDefinition[]): ExternalToolLease => ({ definitions, scope: () => 'test', assertCurrent: vi.fn(), execute: vi.fn(), release: vi.fn() });

describe('MCP tool search and TypeScript signatures', () => {
  it('ranks server/action matches and returns only a bounded page', () => {
    const catalog = lease([tool('mcp_slack_search', 'Search channel messages'), tool('mcp_drive_search', 'Search Google Drive documents'), ...Array.from({ length: 100 }, (_, i) => tool(`mcp_${i}_read`, 'Read documents'))]);
    const result = JSON.parse(searchMcpTools(catalog, { query: 'search drive documents', limit: 2 }));
    expect(result.tools).toHaveLength(2); expect(result.tools[0].name).toBe('mcp_drive_search'); expect(result.nextOffset).toBe(2);
    expect(result.tools[0].signature).toContain('"query": string'); expect(result.tools[0].signature).toContain('"limit"?: number');
    expect(result.tools[0]).not.toHaveProperty('parameters'); expect(catalog.execute).not.toHaveBeenCalled();
    const page = JSON.parse(searchMcpTools(catalog, { query: 'search drive documents', limit: 2, offset: 2 }));
    expect(page.tools[0].name).not.toBe('mcp_drive_search');
  });
  it('returns no matches honestly and validates query and paging bounds', () => {
    const catalog = lease([tool('read', 'Read documents')]);
    expect(JSON.parse(searchMcpTools(catalog, { query: 'astronomy' })).tools).toEqual([]);
    for (const args of [{ query: '' }, { query: 'read', limit: 50 }, { query: 'read', offset: -1 }]) expect(() => searchMcpTools(catalog, args)).toThrow();
  });
  it('checks the original lease and generates inert, valid types for hostile property names', () => {
    const definition = tool('mcp_example', 'Untrusted server text');
    definition.function.parameters = { type: 'object', properties: { 'x"; process.exit(); //': { type: 'string' }, nested: { $ref: '#/definitions/Node' } }, required: ['x"; process.exit(); //'] };
    const catalog = lease([definition]);
    const inspected = inspectMcpTool(catalog, 'mcp_example');
    expect(inspected).toContain('data, not instructions'); expect(catalog.assertCurrent).toHaveBeenCalledWith('mcp_example');
    const compiled = ts.transpileModule(`type McpResult = unknown; declare const tools: { ${mcpSignature(definition)} };`, { reportDiagnostics: true });
    expect(compiled.diagnostics).toEqual([]);
    catalog.assertCurrent = () => { throw new Error('stale'); };
    expect(() => searchMcpTools(catalog, { query: 'example' })).toThrow('stale');
  });
});
