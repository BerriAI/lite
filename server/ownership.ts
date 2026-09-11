import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** An OS-held SQLite lock releases even after SIGKILL. Acquire before recovery
 * touches the application database; a port check alone cannot protect two ports. */
export function ownDataDirectory(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'server-owner.db');
  const owner = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    owner.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY); COMMIT;');
  } catch (error) {
    owner.close();
    if ((error as {errcode?: number}).errcode === 5) throw new Error('Another Speedrail server is using this data directory. Use the running server, or stop it before starting another.');
    throw error;
  }
  let closed = false;
  return () => { if (!closed) { closed = true; owner.close(); } };
}
