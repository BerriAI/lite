import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureTuiServer } from '../bin/tui-server.mjs';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function address() { const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return `http://127.0.0.1:${port}`; }
describe('terminal server startup', () => {
  it('starts only one owned backend for simultaneous launches and leaves it available for attachments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lite-start-test-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'dist/server'), { recursive: true });
    await writeFile(join(root, 'dist/server/index.js'), `require('node:http').createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,version:'test'}))}).listen(Number(process.env.LITE_PORT),'127.0.0.1')`);
    const base = await address(), options = { base, root, workspace: root, explicit: false, env: { ...process.env, LITE_DATA_DIR: join(root, 'state') } };
    const results = await Promise.all([ensureTuiServer(options), ensureTuiServer(options)]);
    const started = results.find(result => result)!; cleanups.push(async () => { process.kill(started.pid, 'SIGTERM'); });
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ensureTuiServer({ ...options, explicit: true })).toBeUndefined();
    expect((await fetch(`${base}/api/health`)).ok).toBe(true);
  });
  it('does not start anything for an unavailable explicitly selected server', async () => {
    await expect(ensureTuiServer({ base: await address(), root: '/does-not-exist', workspace: '/tmp', explicit: true })).rejects.toThrow();
  });
  it('treats HTTP failures as a server error rather than a missing server', async () => {
    const server = createServer((_, response) => { response.writeHead(503); response.end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise(resolve => server.close(() => resolve())));
    await expect(ensureTuiServer({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, root: '/does-not-exist', workspace: '/tmp', explicit: false })).rejects.toThrow('503');
  });
});
