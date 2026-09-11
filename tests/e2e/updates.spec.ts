import { test, expect } from './fixtures';
const state = { currentVersion: '0.1.0', latestVersion: '0.2.0', available: true, packaged: true, restartRequired: false, releaseUrl: 'https://github.com/BerriAI/litespeed/releases/tag/v0.2.0', command: 'litespeed update' };
test('updates are visible, staged explicitly, and preserve work when restart is blocked', async ({ page }) => {
  let installed = false;
  await page.route('**/api/updates**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/restart')) return route.fulfill({ status: 409, json: { error: 'Finish active tasks and background jobs before restarting.' } });
    if (path.endsWith('/install')) installed = true;
    return route.fulfill({ json: { ...state, restartRequired: installed, ...(installed ? { installedVersion: '0.2.0' } : {}) } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Update to 0.2.0' }).click();
  await expect(page.getByRole('region', { name: 'Litespeed updates' })).toContainText('Litespeed 0.1.0');
  await page.getByRole('button', { name: 'Install update', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Litespeed updates' })).toContainText('0.2.0 is installed');
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Litespeed updates' }).getByRole('alert')).toContainText('Finish active tasks');
});
test('source checkouts get an honest update path and offline checks can be retried', async ({ page }) => {
  await page.route('**/api/updates**', route => route.fulfill({ json: { ...state, packaged: false, error: 'Update check failed (offline).' } }));
  await page.goto('/'); await page.getByRole('button', { name: 'Update to 0.2.0' }).click();
  const panel = page.getByRole('region', { name: 'Litespeed updates' });
  await expect(panel).toContainText('update your source checkout');
  await expect(page.getByRole('button', { name: 'Install update', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('offline');
});
