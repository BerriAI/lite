import { describe, expect, it } from 'vitest';
import { isEnvelope, renderEnvelope } from '../server/envelope.js';

const sections = { runtime: 'Today: 2026-09-08.', posture: 'Mode: build. Approval: ask.', memory: '' };

describe('session-context envelope', () => {
  it('renders deterministically with a digest and omits empty sections', () => {
    const first = renderEnvelope(sections), second = renderEnvelope({ ...sections });
    expect(first).toBe(second);
    expect(first).toContain('<session-context version="1">');
    expect(first).toContain('## Posture');
    expect(first).toContain('## Runtime');
    expect(first).not.toContain('## Background memory');
    expect(first).toMatch(/Digest: sha256:[0-9a-f]{16}/);
  });
  it('returns an empty string when every section is empty or whitespace', () => {
    expect(renderEnvelope({ runtime: '', posture: '', memory: '' })).toBe('');
    expect(renderEnvelope({ runtime: '  \n ', posture: ' ', memory: '\t' })).toBe('');
  });
  it('validates its own output and rejects tampering', () => {
    const rendered = renderEnvelope(sections);
    expect(isEnvelope(rendered)).toBe(true);
    expect(isEnvelope(rendered.replace('build', 'plan'))).toBe(false);
    expect(isEnvelope('<session-context version="1">\nfake\n</session-context>')).toBe(false);
    expect(isEnvelope('plain text')).toBe(false);
  });
  it('keeps stable sections byte-identical when only memory changes', () => {
    const without = renderEnvelope(sections);
    const withMemory = renderEnvelope({ ...sections, memory: 'Background memory:\n- style: two-space indent' });
    const stablePrefixLength = without.indexOf('\n\nDigest:');
    expect(withMemory.startsWith(without.slice(0, stablePrefixLength))).toBe(true);
  });
});
