import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryAutoRecall, MemoryFact, MemoryFactSummary, MemoryInput, MemoryRecall } from '../shared/memory.js';
import { MEMORY_HEADER, MEMORY_LIMITS } from '../shared/memory.js';
import type { Store } from './store.js';

type Row = { id: string; workspace: string; name: string; description: string; body: string; created_at: number; updated_at: number };
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });
const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });
const tokenize = (text: string): Set<string> => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
function boundedBytes(text: string, max: number): string {
  const bytes = Buffer.from(text); if (bytes.length <= max) return text;
  let end = Math.max(0, max); while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
// Trim lone surrogate halves a code-unit slice may leave at either edge.
function safeSlice(text: string, start: number, end: number): string {
  let slice = text.slice(start, end);
  if (/^[\udc00-\udfff]/.test(slice)) slice = slice.slice(1);
  if (/[\ud800-\udbff]$/.test(slice)) slice = slice.slice(0, -1);
  return slice;
}

/** Durable, workspace-scoped background facts. Low authority by design: recalls
 * render as data, never as instructions, and never override request/mode/permissions. */
export class Memory {
  readonly db: DatabaseSync;
  constructor(source: Store | DatabaseSync) {
    this.db = source instanceof DatabaseSync ? source : source.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_facts (
      id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workspace,name));
      CREATE INDEX IF NOT EXISTS memory_facts_workspace ON memory_facts(workspace);`);
  }
  private scope(workspace: string): string {
    if (typeof workspace !== 'string' || !workspace.trim()) throw invalid('Memory workspace must be a nonempty canonical path.');
    return workspace;
  }
  private fact(row: Row): MemoryFact {
    return { id: row.id, workspace: row.workspace, name: row.name, description: row.description, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  remember(workspace: string, input: MemoryInput): MemoryFact {
    workspace = this.scope(workspace);
    const { name, description, body } = input ?? {};
    if (typeof name !== 'string' || !/^[a-z0-9-]{1,64}$/.test(name)) throw invalid('Memory name must be a 1-64 character slug of lowercase letters, digits and hyphens.');
    if (typeof description !== 'string' || !description.trim() || description.length > MEMORY_LIMITS.description || /[\p{Cc}\p{Cf}]/u.test(description)) throw invalid('Memory description must be a short single-line label of at most 200 characters.');
    if (typeof body !== 'string' || !body.trim() || body.includes('\0') || Buffer.byteLength(body) > MEMORY_LIMITS.bodyBytes) throw invalid('Memory body must be nonempty printable text of at most 6000 bytes.');
    // Names are already lowercase slugs; the LOWER() guard also fails closed
    // against differently-cased rows that reached the table by other means.
    const existing = this.db.prepare('SELECT * FROM memory_facts WHERE workspace=? AND LOWER(name)=LOWER(?)').get(workspace, name) as unknown as Row | undefined;
    if (existing && existing.name !== name) throw conflict(`Memory name collides with existing fact "${existing.name}".`);
    const now = Date.now();
    if (existing) {
      this.db.prepare('UPDATE memory_facts SET description=?,body=?,updated_at=? WHERE id=?').run(description, body, now, existing.id);
      return { ...this.fact(existing), description, body, updatedAt: now };
    }
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM memory_facts WHERE workspace=?').get(workspace) as { n: number }).n;
    if (count >= MEMORY_LIMITS.facts) throw conflict('The 500-fact workspace memory limit has been reached. Forget a fact before adding another.');
    const fact: MemoryFact = { id: randomUUID(), workspace, name, description, body, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO memory_facts(id,workspace,name,description,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(fact.id, workspace, name, description, body, now, now);
    return fact;
  }
  forget(workspace: string, name: string): boolean {
    workspace = this.scope(workspace);
    if (typeof name !== 'string') return false;
    return this.db.prepare('DELETE FROM memory_facts WHERE workspace=? AND name=?').run(workspace, name).changes > 0;
  }
  // Bodies are intentionally omitted: they are only surfaced by explicit recall.
  list(workspace: string): MemoryFactSummary[] {
    workspace = this.scope(workspace);
    const rows = this.db.prepare('SELECT id,name,description,updated_at FROM memory_facts WHERE workspace=? ORDER BY name').all(workspace) as unknown as Omit<Row, 'workspace' | 'body' | 'created_at'>[];
    return rows.map(row => ({ id: row.id, name: row.name, description: row.description, updatedAt: row.updated_at }));
  }
  get(workspace: string, name: string): MemoryFact | undefined {
    workspace = this.scope(workspace);
    const row = this.db.prepare('SELECT * FROM memory_facts WHERE workspace=? AND name=?').get(workspace, name) as unknown as Row | undefined;
    return row ? this.fact(row) : undefined;
  }
  recall(workspace: string, query: string, limit: number = MEMORY_LIMITS.autoRecallFacts): MemoryRecall[] {
    workspace = this.scope(workspace);
    const bound = Number.isSafeInteger(limit) && limit >= 1 ? Math.min(limit, 8) : MEMORY_LIMITS.autoRecallFacts;
    const tokens = typeof query === 'string' ? [...tokenize(query)] : [];
    if (!tokens.length) return [];
    const rows = this.db.prepare('SELECT * FROM memory_facts WHERE workspace=?').all(workspace) as unknown as Row[];
    const scored: { row: Row; score: number }[] = [];
    for (const row of rows) {
      const name = tokenize(row.name), description = tokenize(row.description), body = tokenize(row.body);
      let score = 0;
      for (const token of tokens) score += (name.has(token) ? 3 : 0) + (description.has(token) ? 2 : 0) + (body.has(token) ? 1 : 0);
      if (score > 0) scored.push({ row, score });
    }
    scored.sort((a, b) => b.score - a.score || b.row.updated_at - a.row.updated_at || a.row.name.localeCompare(b.row.name));
    return scored.slice(0, bound).map(({ row, score }) => ({ name: row.name, description: row.description, snippet: this.snippet(row, tokens), score }));
  }
  private snippet(row: Row, tokens: string[]): string {
    const body = row.body, lower = body.toLowerCase(), span = MEMORY_LIMITS.snippetChars;
    let at = -1, length = 0;
    for (const token of tokens) {
      const index = lower.indexOf(token);
      if (index >= 0 && (at < 0 || index < at)) { at = index; length = token.length; }
    }
    if (at < 0) return row.description;
    if (body.length <= span) return body;
    const start = Math.max(0, Math.min(at + Math.floor(length / 2) - Math.floor(span / 2), body.length - span));
    return safeSlice(body, start, start + span);
  }
  autoRecall(workspace: string, query: string): MemoryAutoRecall {
    const recalls: MemoryRecall[] = [];
    let bytes = 0;
    for (const recall of this.recall(workspace, query, MEMORY_LIMITS.autoRecallFacts)) {
      const remaining = MEMORY_LIMITS.autoRecallBytes - bytes;
      if (remaining <= 0) break;
      const snippet = boundedBytes(recall.snippet, remaining);
      if (!snippet) break;
      recalls.push({ ...recall, snippet }); bytes += Buffer.byteLength(snippet);
    }
    if (!recalls.length) return { block: '', recalls: [] };
    // The exact low-authority header is part of the contract: recalled content is data.
    return { block: [MEMORY_HEADER, ...recalls.map(recall => `- ${recall.name}: ${recall.snippet}`)].join('\n'), recalls };
  }
}
