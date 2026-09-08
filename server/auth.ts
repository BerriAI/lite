import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CodexCredential } from './providers.js';

const ISSUER = 'https://auth.openai.com';
// This is a public OAuth client identifier, not a credential or client secret.
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT = 'http://localhost:1455/auth/callback';
const LIFETIME = 15 * 60_000;
type Method = 'device' | 'browser';
interface Tokens { access_token: string; refresh_token?: string; id_token?: string; expires_in?: number }
interface StoredCredential extends CodexCredential { refreshToken: string; expiresAt: number }
export interface LoginStart { loginId: string; method: Method; url: string; userCode?: string; expiresAt: number }
export interface LoginStatus { status: 'pending' | 'complete' | 'error'; error?: string }
interface Pending { providerId: string; status: LoginStatus; controller: AbortController; expiresAt: number; generation: number; server?: Server; timer?: ReturnType<typeof setTimeout> }

/** Own user-initiated logins only. Never import credentials from other applications. */
export class CodexAuth {
  private readonly file: string;
  private readonly entries = new Map<string, StoredCredential>();
  private readonly logins = new Map<string, Pending>();
  private readonly refreshes = new Map<string, Promise<CodexCredential>>();
  private readonly generations = new Map<string, number>();
  private readonly fetcher: typeof fetch;
  private closed = false;

  constructor(directory: string, options: { fetch?: typeof fetch } = {}) {
    const root = resolve(directory);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = join(root, 'subscription-auth.json');
    this.fetcher = options.fetch || fetch;
    if (existsSync(this.file)) {
      if (lstatSync(this.file).isSymbolicLink()) throw new Error('Refusing a symbolic-link credential file.');
      chmodSync(this.file, 0o600);
      let data: unknown;
      try { data = JSON.parse(readFileSync(this.file, 'utf8')); } catch { throw new Error('The application credential file is unreadable.'); }
      if (data && typeof data === 'object') for (const [id, value] of Object.entries(data)) {
        if (value && typeof value.accessToken === 'string' && typeof value.refreshToken === 'string' && Number.isFinite(value.expiresAt)) this.entries.set(id, value);
      }
    }
  }
  connected(providerId: string): boolean { return this.entries.has(providerId); }
  status(loginId: string): LoginStatus {
    const value = this.logins.get(loginId);
    if (!value) throw Object.assign(new Error('Login not found or expired.'), { status: 404 });
    return { ...value.status };
  }
  private persist() {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.file);
  }
  private generation(id: string) { return this.generations.get(id) || 0; }
  private cancel(login: Pending) {
    clearTimeout(login.timer);
    login.controller.abort();
    login.server?.close();
    login.server?.closeAllConnections();
  }
  private fail(login: Pending, error: string) {
    if (login.status.status !== 'pending') return;
    login.status = { status: 'error', error };
    this.cancel(login);
  }
  private complete(login: Pending, tokens: Tokens) {
    if (login.status.status !== 'pending' || this.closed || this.generation(login.providerId) !== login.generation) return;
    this.entries.set(login.providerId, this.convert(tokens));
    this.persist();
    this.generations.set(login.providerId, login.generation + 1);
    login.status = { status: 'complete' };
    clearTimeout(login.timer);
    login.controller.abort();
    login.server?.close();
  }
  private async json(url: string, init: RequestInit): Promise<any> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) });
    } catch { throw new Error('Authentication request could not reach the provider.'); }
    if (!response.ok) throw new Error(`Authentication request failed (HTTP ${response.status}). Check account permissions or try again.`);
    try { return await response.json(); } catch { throw new Error('Authentication returned an invalid response.'); }
  }
  private exchange(code: string, verifier: string, redirect: string, signal?: AbortSignal): Promise<Tokens> {
    return this.json(`${ISSUER}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal,
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, code, code_verifier: verifier, redirect_uri: redirect }).toString(),
    });
  }
  private convert(tokens: Tokens, previous?: StoredCredential): StoredCredential {
    if (!tokens || typeof tokens.access_token !== 'string' || !tokens.access_token || (!tokens.refresh_token && !previous?.refreshToken))
      throw new Error('Authentication did not return the required tokens.');
    const parse = (token?: string): any => {
      try { return JSON.parse(Buffer.from(token?.split('.')[1] || '', 'base64url').toString('utf8')); } catch { return {}; }
    };
    const access = parse(tokens.access_token), identity = parse(tokens.id_token);
    // Claims are routing metadata from this OAuth exchange, not independently verified authorization.
    const account = (claim: any) => claim.chatgpt_account_id || claim['https://api.openai.com/auth']?.chatgpt_account_id || claim.organizations?.[0]?.id;
    const accountId = account(identity) || account(access) || previous?.accountId;
    const residency = access['https://api.openai.com/auth']?.chatgpt_compute_residency || access.chatgpt_compute_residency;
    const lifetime = Number.isFinite(tokens.expires_in) ? tokens.expires_in! * 1000 : 3600_000;
    return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || previous!.refreshToken,
      expiresAt: Number.isFinite(access.exp) ? access.exp * 1000 : Date.now() + lifetime,
      ...(typeof accountId === 'string' ? { accountId } : {}),
      ...(typeof residency === 'string' && residency !== 'no_constraint' ? { residency } : {}),
    };
  }
  async start(providerId: string, method: Method): Promise<LoginStart> {
    if (this.closed) throw new Error('Authentication service is closed.');
    if (!providerId || !['device', 'browser'].includes(method)) throw new Error('Choose browser or device login.');
    for (const [id, login] of this.logins) {
      if (login.expiresAt < Date.now()) { this.cancel(login); this.logins.delete(id); }
      if (login.providerId === providerId && login.status.status === 'pending') this.fail(login, 'Replaced by a new login.');
    }
    if (this.logins.size >= 100) throw new Error('Too many login attempts. Wait before trying again.');
    const loginId = randomUUID(), expiresAt = Date.now() + LIFETIME;
    const login: Pending = { providerId, status: { status: 'pending' }, controller: new AbortController(), expiresAt, generation: this.generation(providerId) };
    login.timer = setTimeout(() => this.fail(login, 'Login expired. Start again.'), LIFETIME);
    login.timer.unref();
    this.logins.set(loginId, login);
    try {
      if (method === 'device') {
        const device = await this.json(`${ISSUER}/api/accounts/deviceauth/usercode`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'lite/0.1.0' },
          body: JSON.stringify({ client_id: CLIENT_ID }), signal: login.controller.signal,
        });
        if (typeof device.device_auth_id !== 'string' || typeof (device.user_code ?? device.usercode) !== 'string') throw new Error('Authentication returned an invalid device code.');
        const userCode = device.user_code ?? device.usercode;
        void this.poll(login, device.device_auth_id, userCode, Math.max(Number.parseInt(device.interval) || 5, 1) * 1000 + 3000);
        return { loginId, method, url: `${ISSUER}/codex/device`, userCode, expiresAt };
      }
      const verifier = randomBytes(32).toString('base64url');
      const state = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      let callbackReceived = false;
      const server = createServer((req, res) => {
        const url = new URL(req.url || '/', REDIRECT);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end('Not found.'); return; }
        if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid login state.'); return; }
        if (callbackReceived || login.status.status !== 'pending') { res.writeHead(409).end('This login has already been handled.'); return; }
        if (url.searchParams.has('error')) {
          res.writeHead(400).end('Login was declined. Return to your application.');
          this.fail(login, 'Login was declined by the account provider.'); return;
        }
        const code = url.searchParams.get('code');
        if (!code) { res.writeHead(400).end('Missing authorization code.'); return; }
        callbackReceived = true;
        void this.exchange(code, verifier, REDIRECT, login.controller.signal).then(tokens => {
          res.end('Login completed. You can close this tab and return to your application.');
          this.complete(login, tokens);
        }).catch(() => {
          res.writeHead(502).end('Login could not be completed. Return to your application and try again.');
          this.fail(login, 'Login exchange failed. Please start again.');
        });
      });
      login.server = server;
      await new Promise<void>((resolve, reject) => {
        server.once('error', () => reject(new Error('Browser login needs localhost port 1455. Close the other listener or use device login.')));
        server.listen(1455, '127.0.0.1', resolve);
      });
      const params = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT,
        scope: 'openid profile email offline_access', code_challenge: challenge, code_challenge_method: 'S256', state,
        id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'lite' });
      return { loginId, method, url: `${ISSUER}/oauth/authorize?${params}`, expiresAt };
    } catch (error) {
      this.fail(login, error instanceof Error ? error.message : 'Unable to start login.');
      throw error;
    }
  }
  private async poll(login: Pending, deviceId: string, userCode: string, interval: number) {
    try {
      while (!login.controller.signal.aborted && Date.now() < login.expiresAt) {
        const response = await this.fetcher(`${ISSUER}/api/accounts/deviceauth/token`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'lite/0.1.0' },
          body: JSON.stringify({ device_auth_id: deviceId, user_code: userCode }), redirect: 'error',
          signal: AbortSignal.any([login.controller.signal, AbortSignal.timeout(30_000)]),
        });
        if (response.ok) {
          const data = await response.json() as any;
          if (typeof data.authorization_code !== 'string' || typeof data.code_verifier !== 'string') throw new Error('Invalid token response.');
          this.complete(login, await this.exchange(data.authorization_code, data.code_verifier, `${ISSUER}/deviceauth/callback`, login.controller.signal));
          return;
        }
        await response.body?.cancel();
        if (![403, 404].includes(response.status)) throw new Error('Device authorization was declined.');
        await delay(interval, undefined, { signal: login.controller.signal, ref: false });
      }
      this.fail(login, 'Login expired. Start again.');
    } catch {
      this.fail(login, 'Device login did not complete. Check that device-code login is enabled in your account or workspace security settings, then try again.');
    }
  }
  async credentials(providerId: string): Promise<CodexCredential> {
    const value = this.entries.get(providerId);
    if (!value) throw new Error('ChatGPT is not connected. Start a login from Settings.');
    if (value.expiresAt > Date.now() + 60_000) return { accessToken: value.accessToken, accountId: value.accountId, residency: value.residency };
    let pending = this.refreshes.get(providerId);
    if (!pending) {
      const generation = this.generation(providerId);
      pending = (async () => {
        let tokens: Tokens;
        try {
          tokens = await this.json(`${ISSUER}/oauth/token`, {
            method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: value.refreshToken }).toString(),
          });
        } catch { throw new Error('Subscription login could not be refreshed. Sign in again.'); }
        if (this.closed || generation !== this.generation(providerId)) throw new Error('Subscription login was disconnected.');
        const updated = this.convert(tokens, value);
        this.entries.set(providerId, updated);
        this.persist();
        return { accessToken: updated.accessToken, accountId: updated.accountId, residency: updated.residency };
      })().finally(() => this.refreshes.delete(providerId));
      this.refreshes.set(providerId, pending);
    }
    return pending;
  }
  disconnect(providerId: string) {
    this.generations.set(providerId, this.generation(providerId) + 1);
    this.entries.delete(providerId);
    this.persist();
    for (const login of this.logins.values()) if (login.providerId === providerId) this.fail(login, 'Login was cancelled.');
  }
  close() {
    this.closed = true;
    for (const login of this.logins.values()) { this.fail(login, 'Application closed.'); this.cancel(login); }
  }
}
