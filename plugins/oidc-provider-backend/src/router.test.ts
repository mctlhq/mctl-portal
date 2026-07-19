import express from 'express';
import knexLib, { Knex } from 'knex';
import { createHash, randomBytes } from 'crypto';
import { AddressInfo } from 'net';
import { Server } from 'http';
import { createRouter, MembershipLookup, OidcClient } from './router';
import { KeyStore } from './keyStore';
import { OidcStore } from './oidcStore';

const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {}, child: () => logger } as any;

const CLIENT: OidcClient = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUris: ['https://app.example.com/callback'],
};

const membership: MembershipLookup = {
  async getUserGroups() {
    return ['labs', 'labs-team-a'];
  },
  async userExists() {
    return true;
  },
  async getUserRole() {
    return 'owner';
  },
  async getUserTenantRoles() {
    return { labs: 'owner', ovk: 'viewer' };
  },
};

interface TestCtx {
  base: string;
  store: OidcStore;
  knex: Knex;
  server: Server;
}

async function startProvider(): Promise<TestCtx> {
  const knex = knexLib({
    client: 'better-sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
  });
  const store = new OidcStore(knex, logger, false);
  await store.init();
  const keyStore = new KeyStore(logger);
  await keyStore.init(store);

  const app = express();
  const router = createRouter({
    logger,
    membership,
    keyStore,
    issuer: 'http://localhost/api/oidc-provider',
    clients: [CLIENT],
    githubClientId: 'gh-id',
    githubClientSecret: 'gh-secret',
    store,
  });
  app.use(router);

  const server = await new Promise<Server>(resolve => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, store, knex, server };
}

async function loginSession(ctx: TestCtx, userId = 'alice'): Promise<string> {
  const sessionId = `sess-${randomBytes(8).toString('hex')}`;
  await ctx.store.saveSession(sessionId, userId, Date.now() + 60 * 60 * 1000);
  return `oidc_session=${sessionId}`;
}

/** Run /authorize with an authenticated session; returns the issued code. */
async function authorize(
  ctx: TestCtx,
  cookie: string,
  extraParams: Record<string, string> = {},
): Promise<{ status: number; code?: string; body?: any }> {
  const url = new URL(`${ctx.base}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT.clientId);
  url.searchParams.set('redirect_uri', CLIENT.redirectUris[0]);
  url.searchParams.set('scope', 'openid profile groups tenant_roles');
  url.searchParams.set('state', 'xyz');
  for (const [k, v] of Object.entries(extraParams)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url, { redirect: 'manual', headers: { cookie } });
  if (res.status === 302) {
    const location = new URL(res.headers.get('location')!);
    return { status: res.status, code: location.searchParams.get('code') ?? undefined };
  }
  return { status: res.status, body: await res.json().catch(() => undefined) };
}

async function exchangeToken(
  ctx: TestCtx,
  code: string,
  extra: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: CLIENT.redirectUris[0],
    client_id: CLIENT.clientId,
    client_secret: CLIENT.clientSecret,
    ...extra,
  });
  const res = await fetch(`${ctx.base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  return { status: res.status, body: await res.json() };
}

function decodeJwtPayload(jwt: string): any {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

let ctx: TestCtx;

beforeEach(async () => {
  ctx = await startProvider();
});

afterEach(async () => {
  await new Promise(resolve => ctx.server.close(resolve));
  await ctx.knex.destroy();
});

describe('discovery', () => {
  it('advertises PKCE S256 and tenant_roles', async () => {
    const res = await fetch(`${ctx.base}/.well-known/openid-configuration`);
    const body = await res.json();
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.claims_supported).toContain('tenant_roles');
    expect(body.scopes_supported).toContain('tenant_roles');
  });
});

describe('authorization code flow without PKCE (existing Dex-style clients)', () => {
  it('issues a token exactly as before', async () => {
    const cookie = await loginSession(ctx);
    const { code } = await authorize(ctx, cookie);
    expect(code).toBeDefined();

    const { status, body } = await exchangeToken(ctx, code!);
    expect(status).toBe(200);
    const claims = decodeJwtPayload(body.id_token);
    expect(claims.sub).toBe('alice');
    expect(claims.groups).toEqual(['labs', 'labs-team-a']);
    expect(claims.tenant_roles).toEqual({ labs: 'owner', ovk: 'viewer' });
  });

  it('ignores a stray code_verifier when no challenge was sent', async () => {
    const cookie = await loginSession(ctx);
    const { code } = await authorize(ctx, cookie);
    const { status } = await exchangeToken(ctx, code!, { code_verifier: 'whatever' });
    expect(status).toBe(200);
  });
});

describe('PKCE', () => {
  const verifier = randomBytes(32).toString('base64url');

  it('accepts a valid S256 verifier', async () => {
    const cookie = await loginSession(ctx);
    const { code } = await authorize(ctx, cookie, {
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    });
    expect(code).toBeDefined();
    const { status, body } = await exchangeToken(ctx, code!, { code_verifier: verifier });
    expect(status).toBe(200);
    expect(body.id_token).toBeDefined();
  });

  it('rejects a wrong verifier', async () => {
    const cookie = await loginSession(ctx);
    const { code } = await authorize(ctx, cookie, {
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    });
    const { status, body } = await exchangeToken(ctx, code!, { code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier-1' });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  it('rejects redemption without a verifier when challenge was set', async () => {
    const cookie = await loginSession(ctx);
    const { code } = await authorize(ctx, cookie, {
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    });
    const { status, body } = await exchangeToken(ctx, code!);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_grant');
  });

  it('rejects code_challenge_method=plain', async () => {
    const cookie = await loginSession(ctx);
    const result = await authorize(ctx, cookie, {
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'plain',
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_request');
  });

  it('rejects a malformed code_challenge', async () => {
    const cookie = await loginSession(ctx);
    const result = await authorize(ctx, cookie, {
      code_challenge: 'too-short',
      code_challenge_method: 'S256',
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_request');
  });
});

describe('client validation', () => {
  it('rejects an unregistered redirect_uri', async () => {
    const cookie = await loginSession(ctx);
    const url = new URL(`${ctx.base}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CLIENT.clientId);
    url.searchParams.set('redirect_uri', 'https://evil.example.com/callback');
    const res = await fetch(url, { redirect: 'manual', headers: { cookie } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects a wrong client secret at the token endpoint', async () => {
    const cookie = await loginSession(ctx);
    const { code } = await authorize(ctx, cookie);
    const { status, body } = await exchangeToken(ctx, code!, { client_secret: 'bad' });
    expect(status).toBe(401);
    expect(body.error).toBe('invalid_client');
  });

  it('codes are single-use', async () => {
    const cookie = await loginSession(ctx);
    const { code } = await authorize(ctx, cookie);
    expect((await exchangeToken(ctx, code!)).status).toBe(200);
    expect((await exchangeToken(ctx, code!)).status).toBe(400);
  });
});

describe('userinfo', () => {
  it('returns groups and tenant_roles', async () => {
    const cookie = await loginSession(ctx);
    const { code } = await authorize(ctx, cookie);
    const { body } = await exchangeToken(ctx, code!);

    const res = await fetch(`${ctx.base}/userinfo`, {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info.sub).toBe('alice');
    expect(info.groups).toEqual(['labs', 'labs-team-a']);
    expect(info.tenant_roles).toEqual({ labs: 'owner', ovk: 'viewer' });
  });
});

describe('signing key persistence', () => {
  it('a second KeyStore init reuses the stored key so old tokens keep verifying', async () => {
    const cookie = await loginSession(ctx);
    const { code } = await authorize(ctx, cookie);
    const { body } = await exchangeToken(ctx, code!);
    const kidBefore = JSON.parse(
      Buffer.from(body.id_token.split('.')[0], 'base64url').toString('utf8'),
    ).kid;

    // Simulates a pod restart against the same database.
    const restarted = new KeyStore(logger);
    await restarted.init(ctx.store);
    const jwks = restarted.getJWKS();
    expect(jwks.keys.map(k => k.kid)).toContain(kidBefore);
  });
});
