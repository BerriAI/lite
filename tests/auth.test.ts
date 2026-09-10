import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAuth } from '../server/auth.js';
const services: CodexAuth[] = [], directories: string[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function service(fetcher: typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), 'speedrail-auth-test-')); directories.push(dir);
  const auth = new CodexAuth(dir, { fetch: fetcher }); services.push(auth);
  return { auth, dir };
}
const jwt = (claims: any) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('user-initiated subscription login', () => {
  it('uses device-code exchange, stores only own tokens privately and single-flights refresh', async () => {
    let refreshes = 0;
    const calls: { url: string; body: string; type?: string }[] = [];
    const fetcher = vi.fn(async (url: any, init: any) => {
      calls.push({ url, body: init.body, type: init.headers['Content-Type'] });
      if (url.endsWith('/usercode')) return json({ device_auth_id: 'own-device', user_code: 'ABCD', interval: '5' });
      if (url.endsWith('/deviceauth/token')) return json({ authorization_code: 'own-code', code_verifier: 'own-verifier' });
      if (init.body.includes('grant_type=refresh_token')) {
        refreshes++;
        return json({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: 'rotated-refresh', expires_in: 3600 });
      }
      return json({ access_token: jwt({ exp: 1, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1', chatgpt_compute_residency: 'eu' } }), refresh_token: 'own-refresh', expires_in: 0 });
    }) as typeof fetch;
    const { auth, dir } = service(fetcher);
    const start = await auth.start('codex', 'device');
    expect(start.url).toBe('https://auth.openai.com/codex/device'); expect(start.userCode).toBe('ABCD');
    expect(JSON.stringify(start)).not.toContain('own-refresh');
    await vi.waitFor(() => expect(auth.status(start.loginId).status).toBe('complete'));
    expect(auth.connected('codex')).toBe(true);
    expect(calls[0].body).toBe(JSON.stringify({ client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }));
    expect(calls[2].type).toBe('application/x-www-form-urlencoded');
    const exchange = new URLSearchParams(calls[2].body);
    expect(exchange.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback');
    expect(exchange.get('code_verifier')).toBe('own-verifier');
    const tokens = await Promise.all([auth.credentials('codex'), auth.credentials('codex')]);
    expect(refreshes).toBe(1); expect(tokens[0].accountId).toBe('account-1');
    expect(tokens[0]).not.toHaveProperty('refreshToken');
    const path = join(dir, 'subscription-auth.json');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('rotated-refresh');
    auth.disconnect('codex'); expect(auth.connected('codex')).toBe(false);
    await expect(auth.credentials('codex')).rejects.toThrow('not connected');
    expect(readFileSync(path, 'utf8')).toBe('{}');
  });
  it('fails safely when device auth is disabled or tokens malformed', async () => {
    const disabled = service(vi.fn(async () => json({ error: 'secret-response' }, 403)) as typeof fetch);
    await expect(disabled.auth.start('p', 'device')).rejects.toThrow('HTTP 403');
    const invalid = service(vi.fn(async (url: any) => {
      if (url.endsWith('/usercode')) return json({ device_auth_id: 'device', user_code: 'CODE', interval: '5' });
      if (url.endsWith('/deviceauth/token')) return json({ authorization_code: 'code', code_verifier: 'verifier' });
      return json({ unexpected: 'secret' });
    }) as typeof fetch);
    const start = await invalid.auth.start('p', 'device');
    await vi.waitFor(() => expect(invalid.auth.status(start.loginId).status).toBe('error'));
    expect(invalid.auth.connected('p')).toBe(false);
    expect(JSON.stringify(invalid.auth.status(start.loginId))).not.toContain('secret');
  });
  it('does not resurrect a disconnected account when an in-flight login completes', async () => {
    let release: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(async (url: any) => {
      if (url.endsWith('/usercode')) return json({ device_auth_id: 'device', user_code: 'CODE', interval: '1' });
      if (url.endsWith('/deviceauth/token')) return new Promise<Response>(resolve => { release = resolve; });
      return json({ access_token: 'access', refresh_token: 'refresh' });
    }) as typeof fetch;
    const { auth } = service(fetcher); const start = await auth.start('p', 'device');
    await vi.waitFor(() => expect(release).toBeDefined());
    auth.disconnect('p'); release!(json({ authorization_code: 'code', code_verifier: 'verifier' }));
    await vi.waitFor(() => expect(auth.status(start.loginId).status).toBe('error'));
    expect(auth.connected('p')).toBe(false);
  });
  it('creates S256 browser login, validates state, exchanges and shuts down callback', async () => {
    const requests: URLSearchParams[] = [];
    const { auth } = service(vi.fn(async (_url: any, init: any) => { requests.push(new URLSearchParams(init.body)); return json({ access_token: 'own-access', refresh_token: 'own-refresh' }); }) as typeof fetch);
    const start = await auth.start('p', 'browser');
    const url = new URL(start.url);
    expect(url.origin).toBe('https://auth.openai.com'); expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('originator')).toBe('speedrail');
    const bad = await fetch('http://127.0.0.1:1455/auth/callback?code=code&state=wrong');
    expect(bad.status).toBe(400); expect(requests).toHaveLength(0);
    const good = await fetch(`http://127.0.0.1:1455/auth/callback?code=code&state=${url.searchParams.get('state')}`);
    expect(good.status).toBe(200); expect(await good.text()).toContain('Login completed');
    await vi.waitFor(() => expect(auth.status(start.loginId).status).toBe('complete'));
    expect(requests[0].get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(requests[0].get('code_verifier')?.length).toBeGreaterThanOrEqual(43);
  });
});
