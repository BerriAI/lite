import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import { aggregateUsage, type RequestUsage } from '../shared/usage.js';
import type { Usage } from '../shared/types.js';

/** A request identity survives repeated cumulative usage chunks and compaction.
 * Like the historical daily ledger, spend survives transcript deletion. */
export class UsageLedger {
  constructor(private store: Store) {
    store.db.exec('CREATE TABLE IF NOT EXISTS request_usage (id TEXT PRIMARY KEY, root_session_id TEXT NOT NULL, turn_id TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS request_usage_turn ON request_usage(root_session_id,turn_id);');
    const columns = store.db.prepare('PRAGMA table_info(usage_log)').all() as {name:string}[];
    if (!columns.some(column => column.name === 'request_id')) store.db.exec('ALTER TABLE usage_log ADD COLUMN request_id TEXT;');
    store.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS usage_request_id ON usage_log(request_id);');
  }
  start(input: Omit<RequestUsage,'id'|'usage'>): RequestUsage {
    const record = { ...input, id: randomUUID() };
    this.store.db.prepare('INSERT INTO request_usage(id,root_session_id,turn_id,data) VALUES(?,?,?,?)').run(record.id,record.rootSessionId,record.turnId,JSON.stringify(record));
    return record;
  }
  update(record: RequestUsage, usage: Usage) {
    if (![usage.inputTokens,usage.outputTokens,...(usage.cachedTokens === undefined ? [] : [usage.cachedTokens])].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid provider token usage.');
    record.usage = { ...usage, ...(usage.cost !== undefined && (!Number.isFinite(usage.cost) || usage.cost < 0) ? {cost:undefined} : {}) };
    const now = Date.now();
    this.store.atomic(() => {
      this.store.db.prepare('UPDATE request_usage SET data=? WHERE id=?').run(JSON.stringify(record),record.id);
      this.store.db.prepare(`INSERT INTO usage_log(request_id,session_id,provider_id,model,day,input_tokens,output_tokens,cached_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(request_id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens`)
        .run(record.id,record.sessionId,record.providerId,record.model,new Date(now).toISOString().slice(0,10),usage.inputTokens,usage.outputTokens,usage.cachedTokens ?? null,now);
    });
  }
  turn(rootSessionId: string, turnId: string) {
    const rows = this.store.db.prepare('SELECT data FROM request_usage WHERE root_session_id=? AND turn_id=? ORDER BY rowid').all(rootSessionId,turnId) as {data:string}[];
    return aggregateUsage(rows.map(row => JSON.parse(row.data)));
  }
}
