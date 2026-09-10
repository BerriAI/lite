import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { History } from '../server/history.js';
import { ParallelWorkers } from '../server/parallel-workers.js';

describe('isolated worker publication', () => {
  let directory: string, store: Store, history: History, id: string;
  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'speedrail-isolated-publish-')));
    store = new Store(join(directory, 'state')); history = new History(store);
    id = store.createSession({ workspace: directory }).id;
    await writeFile(join(directory, 'a.txt'), 'before'); await writeFile(join(directory, 'b.txt'), 'before');
    history.accept(id, { id: 'turn', sessionId: id, role: 'user', content: 'Implement both assignments', createdAt: 1 });
  });
  afterEach(async () => { vi.restoreAllMocks(); store.close(); await rm(directory, { recursive: true, force: true }); });
  async function batch(signal = new AbortController().signal, current = () => true) {
    const batch = await ParallelWorkers.create(directory, id, ['one', 'two'], history, signal, current);
    await writeFile(join(batch.workspaces.get('one')!.workspace, 'a.txt'), 'worker one');
    await writeFile(join(batch.workspaces.get('two')!.workspace, 'b.txt'), 'worker two');
    return batch;
  }
  it('excludes state reached through a different filesystem alias from workspace copies', async () => {
    const alias = directory + '-alias'; await symlink(directory, alias, 'dir');
    const aliasStore = new Store(join(alias, 'state'));
    try {
      const workers = await ParallelWorkers.create(directory, id, ['one', 'two'], new History(aliasStore), new AbortController().signal);
      for (const worker of workers.workspaces.values()) {
        await expect(stat(join(worker.workspace, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(worker.workspace, 'a.txt'), 'utf8')).toBe('before');
      }
      await Promise.all(['one', 'two'].map(key => workers.complete(key, true)));
      await workers.cleanup();
    } finally { aliasStore.close(); await rm(alias); }
  });
  it('preserves an external edit while integrating the independent assignment', async () => {
    const workers = await batch(); await writeFile(join(directory, 'a.txt'), 'user edit');
    const results = await Promise.all([workers.complete('one', true), workers.complete('two', true)]);
    expect(results.map(result => result.accepted)).toEqual([false, true]);
    expect(results[0].note).toContain('Integration conflict');
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('user edit');
    expect(await readFile(join(directory, 'b.txt'), 'utf8')).toBe('worker two');
  });
  it.each(['steering', 'cancel'])('does not publish stale assignments after %s', async reason => {
    const controller = new AbortController(); let current = true;
    const workers = await batch(controller.signal, () => current);
    const first = workers.complete('one', true);
    if (reason === 'steering') current = false; else controller.abort();
    const results = await Promise.all([first, workers.complete('two', true)]);
    expect(results.every(result => !result.accepted && !result.changes.length)).toBe(true);
    await workers.cleanup();
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('before');
    expect(await readFile(join(workers.workspaces.get('one')!.workspace, 'a.txt'), 'utf8')).toBe('worker one');
  });
  it('reports a partially integrated patch and recovers its durable intent without replay', async () => {
    const workers = await batch();
    const commit = vi.spyOn(history, 'commitChange').mockImplementationOnce(() => { throw new Error('Simulated persistence interruption'); });
    const results = await Promise.all([workers.complete('one', true), workers.complete('two', false)]);
    expect(results[0]).toMatchObject({ accepted: false, changes: [{ path: 'a.txt', before: 'before', after: 'worker one' }] });
    expect(results[0].note).toContain('after 1 file');
    commit.mockRestore(); history.seal(id);
    const recovered = await history.recover(id);
    const undone = await history.undo(id, recovered.undoId!);
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('before');
    await history.redo(id, undone.redoId!);
    expect(await readFile(join(directory, 'a.txt'), 'utf8')).toBe('worker one');
  });
});
