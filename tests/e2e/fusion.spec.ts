import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import type { Session, SessionDetail } from '../../shared/types';

for (const [name, kind, role] of [['Team Fusion', 'team-fusion', 'Worker'], ['Expert Fusion', 'expert-fusion', 'Expert']] as const) {
  test(`${name}: configure roles, delegate, verify, inspect usage and transcript, undo, and switch to planning`, async ({ page, request }) => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'lite-fusion-browser-')));
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }));
    await writeFile(join(workspace, 'check.cjs'), 'const fs=require("node:fs");if(fs.readFileSync("answer.txt","utf8")!=="42\\n")process.exit(1);console.log("Answer verified");');
    let session: Session | undefined;
    try {
      const response = await request.post('/api/sessions', { data: { workspace, providerId: 'fixture', model: 'test-model', architecture: null, planner: null, mode: 'build', permissionMode: 'auto' } });
      expect(response.status()).toBe(201); session = await response.json();
      const detail = async (): Promise<SessionDetail> => (await request.get(`/api/sessions/${session!.id}`)).json();
      await page.goto(`/#session/${session!.id}`);
      await page.locator('.model-trigger').click();
      await page.getByRole('button', { name: 'Architecture', exact: true }).click();
      await page.getByRole('option', { name: new RegExp(`^${name}`) }).click();
      await page.getByRole('button', { name: `${role} model`, exact: true }).click();
      await page.getByRole('textbox', { name: `Search ${role.toLowerCase()} models` }).fill('fast');
      await page.getByRole('option', { name: 'test-fast', exact: true }).click();
      await expect(page.getByLabel(`${role} reasoning`, { exact: true })).toBeEnabled();
      await page.getByLabel(`${role} reasoning`, { exact: true }).selectOption('low');
      await expect(page.getByRole('switch', { name: 'Use a planner model' })).toBeEnabled();
      await page.getByRole('switch', { name: 'Use a planner model' }).click();
      await expect(page.getByRole('button', { name: 'Planner model', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Planner model', exact: true }).click();
      await page.getByRole('option', { name: 'budget-model', exact: true }).click();
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.reload();
      expect((await detail()).session).toMatchObject({ architecture: { kind }, planner: { providerId: 'fixture', model: 'budget-model' } });
      await page.getByRole('textbox', { name: 'Message Lite', exact: true }).fill(`FUSION_BROWSER ${session!.id} implement and verify`);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByRole('article', { name: 'Assistant message' }).last()).toContainText('npm test passed');
      await expect(page.getByRole('button', { name: 'Stop generation', exact: true })).toHaveCount(0);
      const completed = await detail();
      expect(completed.delegations).toHaveLength(1); expect(completed.delegations![0].status).toBe('completed');
      expect(await readFile(join(workspace, 'answer.txt'), 'utf8')).toBe('42\n');
      const final = completed.messages.findLast(message => message.role === 'assistant')!;
      expect(final.receipts?.checksRun).toContain('npm test');
      expect(final.turnUsage).toMatchObject({ requests: 5, reportedRequests: 5, inputTokens: 125, outputTokens: 175 });
      await expect(page.locator('.usage')).toHaveCount(1);
      await page.locator('.usage-details > summary').click();
      await expect(page.locator('.usage-breakdown')).toContainText('test-fast');
      await page.locator('.work-log > summary').first().click();
      await expect(page.getByRole('region', { name: `${role} transcript`, exact: true })).toContainText('Implementation complete');
      await page.getByRole('button', { name: 'Session actions', exact: true }).click();
      await page.getByRole('button', { name: 'Undo last turn', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Undo last turn', exact: true }).click();
      await expect.poll(async () => (await detail()).messages.filter(message => message.role === 'user').length).toBe(0);
      await expect(readFile(join(workspace, 'answer.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await page.getByRole('combobox', { name: 'Agent mode', exact: true }).selectOption('plan');
      await expect(page.locator('.model-trigger')).toContainText('budget-model');
      await page.getByRole('textbox', { name: 'Message Lite', exact: true }).fill(`FUSION_BROWSER ${session!.id} plan only`);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByRole('article', { name: 'Assistant message' }).last()).toContainText('Planning only');
      expect((await detail()).delegations).toHaveLength(0);
    } finally {
      if (session) { await request.post(`/api/sessions/${session.id}/cancel`); await request.delete(`/api/sessions/${session.id}`); }
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
