import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A bounded provider fixture exercises the actual runner, policy, child
 * sessions, approvals, verification, file history, and terminal input. */
export async function fusionCases({ api, terminal, screen, waitFor, save, settings, session, detail }) {
  const idle = () => waitFor(() => screen().includes('idle') && screen().includes('Ask Lite to do') && !screen().includes('×'), 'Fusion idle composer');
  const configure = async (kind, index, label) => {
    await idle(); terminal.write('/models\r');
    await waitFor(() => screen().includes('Architecture:'), 'architecture editor');
    terminal.write('\x1b[H\r');
    await waitFor(() => screen().includes('Expert Fusion'), 'architecture choices');
    terminal.write('\x1b[H' + '\x1b[B'.repeat(index) + '\r');
    await waitFor(() => screen().includes(`${label}:`), `${label} role`);
    terminal.write('\x1b[H' + '\x1b[B'.repeat(3) + '\r');
    await waitFor(() => screen().includes('Enter a model ID'), `${label} model dropdown`);
    terminal.write('test-fast');
    await waitFor(() => /›.*test-fast/.test(screen()), 'worker model result'); terminal.write('\r');
    await waitFor(() => screen().includes(`${label}: test-fast`), `${label} model chosen`);
    terminal.write('\x1b[F\x1b[A\r');
    await waitFor(async () => (await detail()).session.architecture?.kind === kind, `${kind} saved`);
    await idle();
  };
  const approve = async () => {
    let permission;
    await waitFor(async () => { permission = (await detail()).permissions[0]; return permission && screen().includes(`Permission requested · ${permission.tool}`); }, 'worker approval reaches root');
    terminal.write('1'); await waitFor(async () => !(await detail()).permissions.some(item => item.id === permission.id), 'permission resolved');
  };
  await api(`/sessions/${session.id}/tool-grants`, undefined, 'DELETE');
  await configure('sidekick-fusion', 1, 'Sidekick');
  terminal.write('SIDEKICK_BROWSER terminal first handoff\r');
  await approve(); await approve(); await idle();
  const first = (await detail()).delegations.at(-1); assert.equal(first.role, 'sidekick'); assert.equal(first.status, 'completed');
  terminal.write('SIDEKICK_BROWSER terminal second handoff\r');
  await approve(); await approve(); await idle();
  const second = (await detail()).delegations.at(-1); assert.equal(second.childSessionId, first.childSessionId); assert.notEqual(second.id, first.id);
  const firstView = await api(`/sessions/${session.id}/delegations/${first.id}`);
  assert(firstView.messages.some(message => message.content.includes('turn 1')));
  assert(!firstView.messages.some(message => message.content.includes('turn 2')), 'old handoff stays immutable');
  terminal.write('/workers\r');
  await waitFor(() => screen().includes('Worker assignments'), 'worker list'); terminal.write('\r');
  await waitFor(() => screen().includes('Assignment brief'), 'worker inspector');
  await save('10-sidekick-inspector'); terminal.write('\x1b[H' + '\x1b[B'.repeat(4) + '\r');
  await waitFor(() => screen().includes('Read-only invocation transcript'), 'read-only worker transcript');
  await save('11-worker-transcript'); terminal.write('\x1b');
  await waitFor(() => screen().includes('Assignment brief') && !screen().includes('Read-only invocation transcript'), 'back to worker inspector'); terminal.write('\x1b');
  await waitFor(() => !screen().includes('Worker evidence is separate'), 'worker inspector closed');
  await idle();
  await writeFile(join(settings.workspace, 'package.json'), JSON.stringify({ scripts: { test: `node -e "require('node:assert/strict').equal(require('node:fs').readFileSync('answer.txt','utf8'),'42\\n')"` } }));
  const fresh = [];
  for (const [kind, index, label] of [['team-fusion', 2, 'Worker'], ['expert-fusion', 3, 'Expert']]) {
    await configure(kind, index, label);
    terminal.write(`FUSION_BROWSER terminal ${kind} implement and verify\r`);
    await approve();
    await approve();
    await approve();
    await idle();
    const state = await detail(), task = state.delegations.at(-1), final = state.messages.filter(message => message.role === 'assistant').at(-1);
    assert.equal(task.role, label.toLowerCase()); assert.equal(task.status, 'completed'); fresh.push(task.childSessionId);
    assert(final.receipts?.checksRun.includes('npm test'), 'driver verification receipt');
    assert.equal(final.turnUsage.requests, 5); assert.equal(final.turnUsage.reportedRequests, 5);
    await save(`12-${kind}`);
    terminal.write('/changes\r'); await waitFor(() => screen().includes('Changed files') && screen().includes('answer.txt') && !screen().includes('Loading changes'), 'worker change in parent review'); terminal.write('\x1b');
    await idle();
    terminal.write('/undo\r');
    await waitFor(async () => (await detail()).history.canRedo, 'parent undoes worker turn');
    await idle();
    terminal.write('/redo\r');
    await waitFor(async () => !(await detail()).history.canRedo, 'parent redoes worker turn');
    await idle();
  }
  assert.notEqual(fresh[0], fresh[1], 'Team and Expert use fresh contexts');
  terminal.write('FUSION_BROWSER terminal cancel worker\r');
  await approve();
  await waitFor(async () => (await detail()).permissions.some(item => item.tool === 'write_file') && screen().includes('Permission requested · write_file'), 'worker awaiting decision before stop');
  terminal.write('\x1b'); await new Promise(done => setTimeout(done, 180)); terminal.write('\x1b');
  await idle();
  assert.equal((await detail()).delegations.at(-1).status, 'cancelled');
  assert.equal((await detail()).permissions.length, 0);

  // A second client changes configuration. The open terminal editor must
  // reject its stale save instead of overwriting the newer model.
  terminal.write('/models\r'); await waitFor(() => screen().includes('Architecture:'), 'stale editor opened');
  await api(`/sessions/${session.id}`, { model: 'budget-model', expectedConfigRevision: (await detail()).session.configRevision }, 'PATCH');
  terminal.write('\x1b[F\x1b[A\r');
  await waitFor(() => /Session configuration changed/i.test(screen()), 'stale configuration rejected');
  assert.equal((await detail()).session.model, 'budget-model');
  terminal.write('\x1b');
  await api(`/sessions/${session.id}`, { model: 'test-model', planner: { providerId: 'fixture', model: 'test-fast' }, mode: 'plan', expectedConfigRevision: (await detail()).session.configRevision }, 'PATCH');
  await waitFor(() => /test-fast.*plan/.test(screen().split('\n')[0]), 'effective planner in header');
  terminal.write('FUSION_BROWSER terminal planning only\r'); await waitFor(() => screen().includes('Planning only'), 'planning response'); await idle();
  assert((await detail()).messages.at(-1).content.includes('Planning only'));
  await api(`/sessions/${session.id}`, { architecture: null, planner: null, mode: 'build', expectedConfigRevision: (await detail()).session.configRevision }, 'PATCH');
  await idle();
}
