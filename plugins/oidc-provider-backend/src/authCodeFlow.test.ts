import express from 'express';
import { AddressInfo } from 'net';
import http, { Server } from 'http';
import knexLib, { Knex } from 'knex';
import { createHash, randomBytes } from 'crypto';
import * as jose from 'jose';
import { KeyStore } from './keyStore';
import { OidcStore } from './oidcStore';
import { createRouter, verifyPkce } from './router';
import { OIDC_SESSION_COOKIE } from './sessionAuth';

// The authorization-code flow a downstream client runs against the provider
// over real HTTP: Dex without PKCE, mctl-rules with PKCE S256, and the
// tenant_roles claim both of them receive.

const ISSUER = 'https://app.mctl.ai/api/oidc-provider';
const DEX_CALLBACK = 'https://ops.mctl.ai/api/dex/callback';
const RULES_CALLBACK = 'https://labs-mctl-rules.mctl.ai/api/auth/callback';
const TENANT_ROLES: Record<string, Record<string, string>> = {
  mashkovd: { admins: 'owner', labs: 'owner', ovk: 'member' },
};

let server: Server;
let base: string;
let knex: Knex;
let store: OidcStore;
let keyStore: KeyStore;

beforeAll(() => {
  // createRouter schedules a cleanup interval; keep it from holding Jest open.
  jest.spyOn(global, 'setInterval').mockImplementation((() => 0) as any);
});

beforeEach(async () => {
  knex = knexLib({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
  const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any;
  store = new OidcStore(knex, logger, false);
  await store.init();
  keyStore = new KeyStore(logger);
  await keyStore.init();
  const router = createRouter({
    logger,
    membership: {
      getUserGroups: async userId => Object.keys(TENANT_ROLES[userId] ?? {}),
      userExists: async userId => userId in TENANT_ROLES,
      getUserRole: async (userId, tenant) => TENANT_ROLES[userId]?.[tenant] ?? null,
      tenantExists: async () => true,
      getUserTenantRoles: async userId => TENANT_ROLES[userId] ?? {},
    },
    keyStore,
    issuer: ISSUER,
    clients: [
      { clientId: 'dex', clientSecret: 'dex-secret', redirectUris: [DEX_CALLBACK] },
      { clientId: 'mctl-rules', clientSecret: 'rules-secret', redirectUris: [RULES_CALLBACK] },
    ],
    githubClientId: 'gh-client',
    githubClientSecret: 'gh-secret',
    store,
    forwardAuthHosts: [],
  });
  const app = express();
  app.use('/api/oidc-provider', router);
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oidc-provider`;
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  await knex.destroy();
});

interface TestResponse {
  status: number;
  text: string;
  json(): any;
  location: string | null;
}

// Plain node:http so the request carries a real browser's Sec-Fetch-Mode
// (fetch overwrites it with "cors"), and no agent, so no kept-alive socket
// reaches a previous test's server.
function request(
  method: 'GET' | 'POST',
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${base}${path}`,
      { method, headers: opts.headers ?? {}, agent: false },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            text,
            json: () => JSON.parse(text),
            location: res.headers.location ?? null,
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function portalSession(userId = 'mashkovd'): Promise<string> {
  const sessionId = `portal-${randomBytes(8).toString('hex')}`;
  await store.saveSession(sessionId, userId, Date.now() + 60 * 60 * 1000);
  return sessionId;
}

// A signed-in browser navigating to /authorize.
async function authorize(params: Record<string, string>, sessionId?: string): Promise<TestResponse> {
  const query = new URLSearchParams(params).toString();
  return request('GET', `/authorize?${query}`, {
    headers: {
      'Sec-Fetch-Mode': 'navigate',
      Cookie: `${OIDC_SESSION_COOKIE}=${sessionId ?? (await portalSession())}`,
    },
  });
}

function token(form: Record<string, string>): Promise<TestResponse> {
  const body = new URLSearchParams(form).toString();
  return request('POST', '/token', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });
}

function codeOf(res: TestResponse, callback: string): string {
  expect(res.status).toBe(302);
  const url = new URL(res.location!);
  expect(`${url.origin}${url.pathname}`).toBe(callback);
  const code = url.searchParams.get('code');
  expect(code).toBeTruthy();
  return code!;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function decodeIdToken(idToken: string, audience: string): Promise<jose.JWTPayload> {
  const jwks = jose.createLocalJWKSet(keyStore.getJWKS());
  const { payload } = await jose.jwtVerify(idToken, jwks, { issuer: ISSUER, audience });
  return payload;
}

const DEX = { response_type: 'code', client_id: 'dex', redirect_uri: DEX_CALLBACK, state: 's' };
const RULES = { response_type: 'code', client_id: 'mctl-rules', redirect_uri: RULES_CALLBACK, state: 's' };

describe('discovery', () => {
  it('advertises PKCE S256 and the tenant_roles claim', async () => {
    const res = await request('GET', '/.well-known/openid-configuration');
    expect(res.status).toBe(200);
    const doc = res.json();
    expect(doc.code_challenge_methods_supported).toEqual(['S256']);
    expect(doc.claims_supported).toContain('tenant_roles');
    expect(doc.scopes_supported).toContain('tenant_roles');
  });
});

describe('authorization code without PKCE (Dex)', () => {
  it('redeems the code for an ID token carrying groups and tenant_roles', async () => {
    const code = codeOf(await authorize({ ...DEX, nonce: 'n1' }), DEX_CALLBACK);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: DEX_CALLBACK,
      client_id: 'dex',
      client_secret: 'dex-secret',
    });
    expect(res.status).toBe(200);
    const body = res.json();
    expect(body.scope).toBe('openid profile email groups tenant_roles');
    const claims = await decodeIdToken(body.id_token, 'dex');
    expect(claims.sub).toBe('mashkovd');
    expect(claims.nonce).toBe('n1');
    expect(claims.groups).toEqual(['admins', 'labs', 'ovk']);
    expect(claims.tenant_roles).toEqual({ admins: 'owner', labs: 'owner', ovk: 'member' });
  });

  it('returns tenant_roles from /userinfo', async () => {
    const code = codeOf(await authorize(DEX), DEX_CALLBACK);
    const { access_token } = (
      await token({
        grant_type: 'authorization_code',
        code,
        redirect_uri: DEX_CALLBACK,
        client_id: 'dex',
        client_secret: 'dex-secret',
      })
    ).json();
    const res = await request('GET', '/userinfo', { headers: { Authorization: `Bearer ${access_token}` } });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({
      sub: 'mashkovd',
      groups: ['admins', 'labs', 'ovk'],
      tenant_roles: { admins: 'owner', labs: 'owner', ovk: 'member' },
    });
  });

  it('gives a user with no memberships empty groups and tenant_roles', async () => {
    const code = codeOf(await authorize(DEX, await portalSession('nobody')), DEX_CALLBACK);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: DEX_CALLBACK,
      client_id: 'dex',
      client_secret: 'dex-secret',
    });
    expect(res.status).toBe(200);
    const claims = await decodeIdToken(res.json().id_token, 'dex');
    expect(claims.groups).toEqual([]);
    expect(claims.tenant_roles).toEqual({});
  });

  it('accepts each code once', async () => {
    const code = codeOf(await authorize(DEX), DEX_CALLBACK);
    const form = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: DEX_CALLBACK,
      client_id: 'dex',
      client_secret: 'dex-secret',
    };
    expect((await token(form)).status).toBe(200);
    const again = await token(form);
    expect(again.status).toBe(400);
    expect(again.json().error).toBe('invalid_grant');
  });

  it('rejects a wrong client secret without consuming the code', async () => {
    const code = codeOf(await authorize(DEX), DEX_CALLBACK);
    const bad = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: DEX_CALLBACK,
      client_id: 'dex',
      client_secret: 'wrong',
    });
    expect(bad.status).toBe(401);
    const good = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: DEX_CALLBACK,
      client_id: 'dex',
      client_secret: 'dex-secret',
    });
    expect(good.status).toBe(200);
  });

  it('rejects a code minted for another client', async () => {
    const code = codeOf(await authorize(DEX), DEX_CALLBACK);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: RULES_CALLBACK,
      client_id: 'mctl-rules',
      client_secret: 'rules-secret',
    });
    expect(res.status).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });
});

describe('authorization code with PKCE S256 (mctl-rules)', () => {
  it('redeems the code with the matching verifier', async () => {
    const { verifier, challenge } = pkcePair();
    const code = codeOf(
      await authorize({ ...RULES, code_challenge: challenge, code_challenge_method: 'S256', nonce: 'n2' }),
      RULES_CALLBACK,
    );
    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: RULES_CALLBACK,
      client_id: 'mctl-rules',
      client_secret: 'rules-secret',
      code_verifier: verifier,
    });
    expect(res.status).toBe(200);
    const claims = await decodeIdToken(res.json().id_token, 'mctl-rules');
    expect(claims.sub).toBe('mashkovd');
    expect(claims.nonce).toBe('n2');
    expect(claims.tenant_roles).toEqual({ admins: 'owner', labs: 'owner', ovk: 'member' });
  });

  it.each([
    ['a wrong verifier', () => pkcePair().verifier],
    ['no verifier', () => undefined],
    ['a too-short verifier', () => 'short'],
  ])('refuses the code with %s and burns it', async (_name, badVerifier) => {
    const { challenge } = pkcePair();
    const code = codeOf(
      await authorize({ ...RULES, code_challenge: challenge, code_challenge_method: 'S256' }),
      RULES_CALLBACK,
    );
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: RULES_CALLBACK,
      client_id: 'mctl-rules',
      client_secret: 'rules-secret',
    };
    const v = badVerifier();
    if (v !== undefined) form.code_verifier = v;
    const res = await token(form);
    expect(res.status).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    // The failed attempt consumed the code: the real verifier no longer helps.
    expect(await store.consumeCode(code)).toBeUndefined();
  });

  it('ignores a stray verifier on a code minted without a challenge', async () => {
    const code = codeOf(await authorize(RULES), RULES_CALLBACK);
    const res = await token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: RULES_CALLBACK,
      client_id: 'mctl-rules',
      client_secret: 'rules-secret',
      code_verifier: pkcePair().verifier,
    });
    expect(res.status).toBe(200);
  });

  it('rejects the plain method', async () => {
    const res = await authorize({ ...RULES, code_challenge: pkcePair().challenge, code_challenge_method: 'plain' });
    expect(res.status).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('rejects a challenge without a method', async () => {
    const res = await authorize({ ...RULES, code_challenge: pkcePair().challenge });
    expect(res.status).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('rejects a malformed challenge', async () => {
    const res = await authorize({ ...RULES, code_challenge: 'not base64url!', code_challenge_method: 'S256' });
    expect(res.status).toBe(400);
    expect(res.json().error).toBe('invalid_request');
  });

  it('refuses a code to anything but a navigation even with a session', async () => {
    const query = new URLSearchParams({ ...RULES, ...pkcePairParams() }).toString();
    const res = await request('GET', `/authorize?${query}`, {
      headers: { 'Sec-Fetch-Mode': 'cors', Cookie: `${OIDC_SESSION_COOKIE}=${await portalSession()}` },
    });
    expect(res.status).toBe(403);
  });
});

function pkcePairParams(): Record<string, string> {
  return { code_challenge: pkcePair().challenge, code_challenge_method: 'S256' };
}

describe('verifyPkce', () => {
  it('accepts the S256 proof and nothing else', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkce(challenge, verifier)).toBe(true);
    expect(verifyPkce(challenge, `${verifier}x`)).toBe(false);
    expect(verifyPkce(challenge, challenge)).toBe(false);
    expect(verifyPkce(challenge, undefined)).toBe(false);
    expect(verifyPkce(challenge, 42)).toBe(false);
    expect(verifyPkce(challenge, 'a'.repeat(129))).toBe(false);
  });
});
