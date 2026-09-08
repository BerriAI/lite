import { describe, expect, it } from 'vitest';
import { captureShape, compareShape } from '../server/cache.js';
import type { ToolDefinition } from '../shared/types.js';

const tool = (name: string, description = 'A test tool.'): ToolDefinition => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {}, required: [] } } });

describe('prefix shape diagnostics', () => {
  it('is stable across identical inputs and tool advertisement order', () => {
    const first = captureShape('system text', [tool('alpha'), tool('beta')]);
    const second = captureShape('system text', [tool('beta'), tool('alpha')]);
    expect(first).toEqual(second);
  });
  it('changes when the system text or a schema changes', () => {
    const base = captureShape('system text', [tool('alpha')]);
    expect(captureShape('system text 2', [tool('alpha')]).systemHash).not.toBe(base.systemHash);
    expect(captureShape('system text', [tool('alpha', 'Changed description.')]).toolsHash).not.toBe(base.toolsHash);
    expect(captureShape('system text', [tool('alpha'), tool('beta')]).prefixHash).not.toBe(base.prefixHash);
  });
  it('reports first_turn once and clean prefixes after', () => {
    const shape = captureShape('system', [tool('alpha')]);
    const first = compareShape(undefined, shape, []);
    expect(first).toMatchObject({ prefixChanged: true, reasons: ['first_turn'] });
    const second = compareShape(shape, captureShape('system', [tool('alpha')]), []);
    expect(second).toMatchObject({ prefixChanged: false, reasons: [] });
  });
  it('names the changed component and appends drained history reasons', () => {
    const previous = captureShape('system', [tool('alpha')]);
    const diagnostics = compareShape(previous, captureShape('other system', [tool('alpha'), tool('beta')]), ['history_compacted']);
    expect(diagnostics.prefixChanged).toBe(true);
    expect(diagnostics.reasons).toEqual(['system', 'tools', 'history_compacted']);
  });
  it('reports history rewrites even when the prefix itself is unchanged', () => {
    const shape = captureShape('system', [tool('alpha')]);
    const diagnostics = compareShape(shape, captureShape('system', [tool('alpha')]), ['history_edited']);
    expect(diagnostics).toMatchObject({ prefixChanged: true, reasons: ['history_edited'] });
  });
});
