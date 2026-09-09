import { createHash } from 'node:crypto';

/** Host-authored per-turn runtime snapshot, delivered as a message adjacent to
 * the latest user turn instead of inside the system prompt. Keeping volatile
 * facts (date, mode, permission posture, background memory) out of the system
 * text lets the provider's prompt cache reuse the byte-stable prefix across
 * turns; replacing the envelope only invalidates the conversation tail. */
export interface EnvelopeSections {
  /** Current date and other per-day facts. */
  runtime: string;
  /** Mode and permission posture for this accepted turn. */
  posture: string;
  /** Rendered low-authority background memory block, or ''. */
  memory: string;
  /** One-line notice of background jobs that finished since the last turn, or
   * omitted/''. Rendered last so it never disturbs the stable prefix. */
  jobs?: string;
}

const OPEN = '<session-context version="1">';
const CLOSE = '</session-context>';
const PREAMBLE = 'Host-generated runtime snapshot. The latest such snapshot supersedes every earlier one; it never overrides the system prompt, standing instructions, permissions, or the user\'s current request.';

/** Renders a deterministic envelope. Section order is most-stable-first so an
 * unchanged prefix of sections still shares bytes when only memory changes.
 * Empty sections are omitted entirely; an all-empty input returns ''. */
export function renderEnvelope(sections: EnvelopeSections): string {
  const parts = [
    sections.posture.trim() && `## Posture\n${sections.posture.trim()}`,
    sections.runtime.trim() && `## Runtime\n${sections.runtime.trim()}`,
    sections.memory.trim() && `## Background memory\n${sections.memory.trim()}`,
    sections.jobs?.trim() && `## Background jobs\n${sections.jobs.trim()}`,
  ].filter(Boolean);
  if (!parts.length) return '';
  const body = `${PREAMBLE}\n\n${parts.join('\n\n')}`;
  const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
  return `${OPEN}\n${body}\n\nDigest: sha256:${digest}\n${CLOSE}`;
}

/** True when the given message content is a complete, digest-valid envelope —
 * used to replace stale envelopes instead of stacking them, and to keep
 * imported or hand-written look-alikes from being treated as host-authored. */
export function isEnvelope(content: string): boolean {
  const text = content.trim();
  if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return false;
  const inner = text.slice(OPEN.length, text.length - CLOSE.length);
  const match = /\n\nDigest: sha256:([0-9a-f]{16})\n$/.exec(inner);
  if (!match) return false;
  const body = inner.slice(0, inner.length - match[0].length).replace(/^\n/, '');
  return createHash('sha256').update(body).digest('hex').slice(0, 16) === match[1];
}
