import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { readFileSync, readdirSync } from 'node:fs';
import { app } from '../src/server/index';
import { TestDb } from './test-db';
import { fixture } from './fixture';
import { importStatements } from '../src/lib/import';

const issuer = 'https://access-test.cloudflareaccess.com';
const access = { ACCESS_TEAM_DOMAIN: issuer, ACCESS_AUD: 'dopanki-test-audience' };
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let db: TestDb;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'test-key', alg: 'RS256' };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ keys: [jwk] })));
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  db = new TestDb();
  for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.sqlite.exec(readFileSync(`migrations/${file}`, 'utf8'));
  db.sqlite.exec(importStatements(fixture()).join(';') + ';');
});
afterEach(() => db.sqlite.close());
const bindings = () => ({ DB: db as unknown as D1Database, MEDIA: {} as R2Bucket, ASSETS: {} as Fetcher, APP_PASSWORD: 'legacy-secret', ...access });
const request = (path: string, token?: string, extraHeaders: Record<string, string> = {}, body?: unknown) => app.request(`https://dopanki.example${path}`, {
  ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  headers: { 'Content-Type': 'application/json', ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...extraHeaders },
}, bindings());
async function token(overrides: JWTPayload = {}, signingKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: issuer, aud: access.ACCESS_AUD, sub: 'owner-id', iat: now, exp: now + 300, email: 'owner@example.com', ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).sign(signingKey);
}

describe('Cloudflare Access owns production browser authentication', () => {
  it('opens the collection and backup without a password cookie and exposes Access logout', async () => {
    const jwt = await token();
    expect(await (await request('/api/session', jwt)).json()).toEqual({ authenticated: true, passwordRequired: false, logoutUrl: '/cdn-cgi/access/logout' });
    expect((await request('/api/overview', jwt)).status).toBe(200);
    expect((await request('/api/export', jwt)).status).toBe(200);
    expect(await (await request('/api/logout', jwt, {}, {})).json()).toEqual({ ok: true, logoutUrl: '/cdn-cgi/access/logout' });
    expect((await request('/api/login', jwt, {}, { password: 'legacy-secret' })).status).toBe(403);
  });

  it('rejects missing, forged, expired, or wrong-application tokens even with a valid legacy cookie', async () => {
    const local = await app.request('http://localhost/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'legacy-secret' }) }, { ...bindings(), ACCESS_TEAM_DOMAIN: undefined, ACCESS_AUD: undefined });
    const cookie = local.headers.get('Set-Cookie')!.split(';')[0];
    const wrongKeys = await generateKeyPair('RS256');
    const invalid = [undefined, 'not-a-jwt', await token({}, wrongKeys.privateKey), await token({ exp: 1 }), await token({ exp: undefined }), await token({ aud: 'another-app' }), await token({ iss: 'https://another-team.cloudflareaccess.com' })];
    for (const jwt of invalid) {
      for (const path of ['/api/session', '/api/overview', '/media/example.mp3']) {
        expect((await request(path, jwt, { Cookie: cookie, 'Cf-Access-Authenticated-User-Email': 'owner@example.com' })).status).toBe(401);
      }
    }
  });

  it('fails closed with incomplete Access configuration instead of accepting a local/password session', async () => {
    const response = await app.request('http://localhost/api/session', {}, { ...bindings(), ACCESS_AUD: undefined });
    expect(response.status).toBe(503);
  });

  it('protects media using Access and retains the same-origin write check', async () => {
    const jwt = await token();
    expect((await request('/media/example.mp3', jwt)).status).toBe(404);
    expect((await request('/api/review', jwt, { Origin: 'https://evil.example' }, {})).status).toBe(403);
  });

  it('requires a scoped authoring token for service identities and never grants them a browser session', async () => {
    const jwt = await token({ email: undefined, common_name: 'service-id' });
    const bearer = 'dpk_test-service';
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer)))].map(x => x.toString(16).padStart(2, '0')).join('');
    db.sqlite.prepare('INSERT INTO api_tokens(id,name,token_hash,scopes,created_at) VALUES(?,?,?,?,?)').run('token-id', 'AI', hash, '["content:read"]', new Date().toISOString());
    const auth = { Authorization: `Bearer ${bearer}` };
    expect((await request('/api/manage/notes', undefined, auth)).status).toBe(401);
    expect((await request('/api/manage/notes', jwt, auth)).status).toBe(200);
    expect((await request('/api/export', jwt, auth)).status).toBe(401);
    expect((await request('/api/export', jwt)).status).toBe(401);
    expect((await request('/media/example.mp3', jwt)).status).toBe(401);
    expect((await request('/api/manage/tokens', jwt, auth)).status).toBe(401);
    expect(await (await request('/api/session', jwt)).json()).toMatchObject({ authenticated: false, passwordRequired: false });
  });
});
