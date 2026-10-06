import { ConfigReader } from '@backstage/config';
import express from 'express';
import { AddressInfo } from 'net';
import http, { Server } from 'http';
import * as jose from 'jose';
import knexLib, { Knex } from 'knex';
import { KeyStore } from './keyStore';
import { OidcStore } from './oidcStore';
import { renderPage } from './pages';
import { createRouter, LOGIN_STATE_COOKIE_PREFIX, RouterOptions } from './router';
import { OIDC_SESSION_COOKIE } from './sessionAuth';
import { readUpstreamConfig } from './upstreamConfig';
import {
  GITHUB_LOGIN_CLAIM,
  parseUpstreamMode,
  pkceChallenge,
  readGithubLogin,
  UpstreamMode,
} from './zitadelUpstream';

// The upstream switch of the provider, over real HTTP against a mocked
// ZITADEL: discovery, token endpoint and keys are answered by global.fetch,
// and ID tokens are signed with a key generated here.

const ISSUER = 'https://app.mctl.ai/api/oidc-provider';
const ZITADEL_ISSUER = 'https://auth.mctl.ai';
const ZITADEL_CLIENT_ID = '300000000000000001';
const ZITADEL_CLIENT_SECRET = 'zitadel-secret';
const ZITADEL_CALLBACK = `${ISSUER}/zitadel/callback`;
const DEX_CALLBACK = 'https://ops.mctl.ai/api/dex/callback';
const DEX_AUTHORIZE = `/authorize?response_type=code&client_id=dex&redirect_uri=${encodeURIComponent(
  DEX_CALLBACK,
)}&state=dex-state`;
// Every browser entry point that starts a sign-in, and where its callback
// must send the browser afterwards.
const SIGN_IN_ENTRY_POINTS: Array<[string, string, string]> = [
  [
    '/login',
    `/login?returnTo=${encodeURIComponent('https://ovk-openclaw.mctl.ai/')}`,
    'https://ovk-openclaw.mctl.ai/',
  ],
  ['/tenant-login', '/tenant-login?tenant=ovk&service=openclaw', 'https://ovk-openclaw.mctl.ai/'],
  ['/authorize (Dex)', DEX_AUTHORIZE, `/api/oidc-provider${DEX_AUTHORIZE}`],
  [
    '/forward-auth/authorize',
    '/forward-auth/authorize?tenant=ovk&service=openclaw&host=ovk-openclaw.mctl.ai&state=0123456789abcdef',
    '/api/oidc-provider/forward-auth/authorize?tenant=ovk&service=openclaw&host=ovk-openclaw.mctl.ai&state=0123456789abcdef',
  ],
];

const realFetch = global.fetch;
const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any;

let signingKey: jose.KeyLike;
let signingJwk: jose.JWK;
let otherKey: jose.KeyLike;
let rotatedKey: jose.KeyLike;
let rotatedJwk: jose.JWK;

let server: Server;
let base: string;
let knex: Knex;
let store: OidcStore;
let members: Set<string>;
let userExistsCalls: string[];

// What the mocked ZITADEL answers; tests change one piece at a time.
interface FakeZitadel {
  discovery: Record<string, unknown> | number;
  keys: jose.JWK[];
  /** Builds the ID token for a token request; receives the flow's nonce. */
  idToken: (nonce: string) => Promise<string>;
  tokenStatus: number;
  tokenRequests: Array<{ headers: Record<string, string>; body: URLSearchParams }>;
  requests: string[];
}
let zitadel: FakeZitadel;
// Nonce of the sign-in in flight, as sent to the authorization endpoint.
let flowNonce: string;

async function signIdToken(
  claims: Record<string, unknown>,
  opts: { key?: jose.KeyLike; kid?: string; expiresIn?: string | number } = {},
): Promise<string> {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'key-1' })
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(opts.key ?? signingKey);
}

// The claims a ZITADEL ID token of this client carries for a mapped user.
function idTokenClaims(nonce: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    iss: ZITADEL_ISSUER,
    aud: [ZITADEL_CLIENT_ID, '300000000000000009'],
    azp: ZITADEL_CLIENT_ID,
    sub: '300000000000000042',
    nonce,
    [GITHUB_LOGIN_CLAIM]: 'MashkovD',
    ...overrides,
  };
  for (const [key, value] of Object.entries(claims)) {
    if (value === undefined) delete claims[key];
  }
  return claims;
}

function mockZitadel() {
  global.fetch = jest.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    zitadel.requests.push(url);
    if (url === `${ZITADEL_ISSUER}/.well-known/openid-configuration`) {
      if (typeof zitadel.discovery === 'number') {
        return new Response('unavailable', { status: zitadel.discovery });
      }
      return new Response(JSON.stringify(zitadel.discovery));
    }
    if (url === `${ZITADEL_ISSUER}/oauth/v2/keys`) {
      return new Response(JSON.stringify({ keys: zitadel.keys }));
    }
    if (url === `${ZITADEL_ISSUER}/oauth/v2/token`) {
      zitadel.tokenRequests.push({ headers: init.headers, body: new URLSearchParams(init.body) });
      if (zitadel.tokenStatus !== 200) {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: zitadel.tokenStatus });
      }
      return new Response(JSON.stringify({ access_token: 'opaque', id_token: await zitadel.idToken(flowNonce) }));
    }
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gh-token' }));
    }
    if (url.startsWith('https://api.github.com/user')) {
      return new Response(JSON.stringify({ login: 'mashkovd' }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as any;
}

function routerOptions(upstream: UpstreamMode | undefined): RouterOptions {
  return {
    logger,
    membership: {
      getUserGroups: async () => ['admins'],
      userExists: async userId => {
        userExistsCalls.push(userId);
        return members.has(userId);
      },
      getUserRole: async userId => (members.has(userId) ? 'owner' : null),
      tenantExists: async () => true,
    },
    keyStore: {} as KeyStore,
    issuer: ISSUER,
    clients: [{ clientId: 'dex', clientSecret: 'dex-secret', redirectUris: [DEX_CALLBACK] }],
    githubClientId: 'gh-client',
    githubClientSecret: 'gh-secret',
    store,
    upstream,
    zitadel:
      upstream === undefined || upstream === 'github'
        ? undefined
        : { issuer: ZITADEL_ISSUER, clientId: ZITADEL_CLIENT_ID, clientSecret: ZITADEL_CLIENT_SECRET },
  };
}

async function listen(upstream: UpstreamMode | undefined): Promise<void> {
  const app = express();
  app.use('/api/oidc-provider', createRouter(routerOptions(upstream)));
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oidc-provider`;
}

beforeAll(async () => {
  // createRouter schedules a cleanup interval; keep it from holding Jest open.
  jest.spyOn(global, 'setInterval').mockImplementation((() => 0) as any);
  const first = await jose.generateKeyPair('RS256');
  signingKey = first.privateKey;
  signingJwk = { ...(await jose.exportJWK(first.publicKey)), kid: 'key-1', alg: 'RS256', use: 'sig' };
  otherKey = (await jose.generateKeyPair('RS256')).privateKey;
  const rotated = await jose.generateKeyPair('RS256');
  rotatedKey = rotated.privateKey;
  rotatedJwk = { ...(await jose.exportJWK(rotated.publicKey)), kid: 'key-2', alg: 'RS256', use: 'sig' };
});

beforeEach(async () => {
  members = new Set(['mashkovd']);
  userExistsCalls = [];
  flowNonce = '';
  zitadel = {
    discovery: {
      issuer: ZITADEL_ISSUER,
      authorization_endpoint: `${ZITADEL_ISSUER}/oauth/v2/authorize`,
      token_endpoint: `${ZITADEL_ISSUER}/oauth/v2/token`,
      jwks_uri: `${ZITADEL_ISSUER}/oauth/v2/keys`,
    },
    keys: [signingJwk],
    idToken: nonce => signIdToken(idTokenClaims(nonce)),
    tokenStatus: 200,
    tokenRequests: [],
    requests: [],
  };
  mockZitadel();
  knex = knexLib({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
  store = new OidcStore(knex, logger, false);
  await store.init();
});

afterEach(async () => {
  global.fetch = realFetch;
  if (server) {
    await new Promise(resolve => server.close(resolve));
  }
  server = undefined as any;
  await knex.destroy();
});

interface TestResponse {
  status: number;
  text: string;
  headers: { get(name: string): string | null; getSetCookie(): string[] };
}

// A top-level browser navigation over plain node:http (fetch is mocked, and
// would overwrite Sec-Fetch-Mode anyway).
function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    http
      .get(`${base}${path}`, { headers: { 'Sec-Fetch-Mode': 'navigate', ...headers }, agent: false }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          text += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            text,
            headers: {
              get: name => {
                const v = res.headers[name.toLowerCase()];
                if (v === undefined) return null;
                return Array.isArray(v) ? v.join(', ') : String(v);
              },
              getSetCookie: () => res.headers['set-cookie'] ?? [],
            },
          }),
        );
      })
      .on('error', reject);
  });
}

function expectHostOnly(setCookie: string) {
  expect(setCookie).not.toMatch(/;\s*domain=/i);
  expect(setCookie).toMatch(/^__Host-/);
  expect(setCookie).toContain('; Path=/');
  expect(setCookie).toContain('; Secure');
  expect(setCookie).toContain('; HttpOnly');
  expect(setCookie).toContain('; SameSite=Lax');
}

async function pendingCount(): Promise<number> {
  const [{ n }] = await knex('oidc_pending_auths').count({ n: '*' });
  return Number(n);
}

async function sessionCount(): Promise<number> {
  const [{ n }] = await knex('oidc_sessions').count({ n: '*' });
  return Number(n);
}

interface StartedSignIn {
  state: string;
  cookie: string;
  authorize: URL;
}

// Starts a sign-in at `path` and returns what the browser now holds.
async function start(path = SIGN_IN_ENTRY_POINTS[0][1]): Promise<StartedSignIn> {
  const res = await get(path);
  expect(res.status).toBe(302);
  const authorize = new URL(res.headers.get('location')!);
  const state = authorize.searchParams.get('state')!;
  flowNonce = authorize.searchParams.get('nonce') ?? '';
  return { state, cookie: `${LOGIN_STATE_COOKIE_PREFIX}${state}=1`, authorize };
}

function finish(started: StartedSignIn, opts: { cookie?: string; state?: string } = {}): Promise<TestResponse> {
  return get(`/zitadel/callback?code=z-code&state=${opts.state ?? started.state}`, {
    Cookie: opts.cookie ?? started.cookie,
  });
}

// A refused sign-in: no portal session cookie and no session row.
async function expectRefused(res: TestResponse, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.getSetCookie().some(c => c.startsWith(`${OIDC_SESSION_COOKIE}=`))).toBe(false);
  expect(res.headers.get('location')).toBeNull();
  expect(await sessionCount()).toBe(0);
}

describe('parseUpstreamMode', () => {
  it('defaults to github when unset', () => {
    expect(parseUpstreamMode(undefined)).toBe('github');
  });

  it.each(['github', 'zitadel', 'both'])('accepts %s', mode => {
    expect(parseUpstreamMode(mode)).toBe(mode);
  });

  it.each(['', 'GitHub', 'oidc', 'zitadel ', 'github,zitadel'])('fails on %j instead of defaulting', mode => {
    expect(() => parseUpstreamMode(mode)).toThrow(/oidcProvider.upstream/);
  });
});

describe('readUpstreamConfig', () => {
  const github = { clientId: 'gh-client', clientSecret: 'gh-secret' };
  const zitadelClient = { issuer: ZITADEL_ISSUER, clientId: ZITADEL_CLIENT_ID, clientSecret: ZITADEL_CLIENT_SECRET };
  const read = (oidcProvider: Record<string, unknown>) =>
    readUpstreamConfig(new ConfigReader({ oidcProvider } as any));

  it('reads only the GitHub client when the switch is unset', () => {
    expect(read({ github })).toEqual({
      upstream: 'github',
      githubClientId: 'gh-client',
      githubClientSecret: 'gh-secret',
      zitadel: undefined,
    });
  });

  it('does not read a configured ZITADEL client while the switch is github', () => {
    for (const upstream of [undefined, 'github']) {
      expect(read({ upstream, github, zitadel: zitadelClient }).zitadel).toBeUndefined();
      // Not even a broken one.
      expect(read({ upstream, github, zitadel: { issuer: 7 } }).zitadel).toBeUndefined();
    }
  });

  it.each(['clientId', 'clientSecret'])('still requires the GitHub %s by default', key => {
    expect(() => read({ github: { ...github, [key]: undefined } })).toThrow(`oidcProvider.github.${key}`);
    expect(() => read({ upstream: 'both', github: { ...github, [key]: undefined }, zitadel: zitadelClient })).toThrow(
      `oidcProvider.github.${key}`,
    );
  });

  it('reads both clients for both', () => {
    expect(read({ upstream: 'both', github, zitadel: zitadelClient })).toEqual({
      upstream: 'both',
      githubClientId: 'gh-client',
      githubClientSecret: 'gh-secret',
      zitadel: zitadelClient,
    });
  });

  it('needs no GitHub client for zitadel', () => {
    expect(read({ upstream: 'zitadel', zitadel: zitadelClient })).toEqual({
      upstream: 'zitadel',
      githubClientId: '',
      githubClientSecret: '',
      zitadel: zitadelClient,
    });
  });

  it.each(['zitadel', 'both'])('requires every field of the ZITADEL client for %s', upstream => {
    for (const key of ['issuer', 'clientId', 'clientSecret']) {
      expect(() => read({ upstream, github, zitadel: { ...zitadelClient, [key]: undefined } })).toThrow(
        `oidcProvider.zitadel.${key}`,
      );
    }
    expect(() => read({ upstream, github })).toThrow('oidcProvider.zitadel.issuer');
  });

  it('fails on an unknown switch value', () => {
    expect(() => read({ upstream: 'oidc', github, zitadel: zitadelClient })).toThrow(/oidcProvider.upstream/);
  });
});

describe('readGithubLogin', () => {
  it('returns the claim lowercased', () => {
    expect(readGithubLogin({ [GITHUB_LOGIN_CLAIM]: 'Octo-Cat1' })).toBe('octo-cat1');
  });

  it('accepts the longest login and an all-digit one', () => {
    expect(readGithubLogin({ [GITHUB_LOGIN_CLAIM]: 'a'.repeat(39) })).toBe('a'.repeat(39));
    expect(readGithubLogin({ [GITHUB_LOGIN_CLAIM]: '1234' })).toBe('1234');
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['a number', 1234],
    ['an array', ['mashkovd']],
    ['an object', { login: 'mashkovd' }],
    ['null', null],
    ['too long', 'a'.repeat(40)],
    ['an e-mail', 'mashkovd@example.com'],
    ['leading hyphen', '-mashkovd'],
    ['trailing hyphen', 'mashkovd-'],
    ['double hyphen', 'mash--kovd'],
    ['with a space', 'mashkovd '],
    ['with a slash', 'user:default/mashkovd'],
  ])('is null when the claim is %s', (_name, value) => {
    expect(readGithubLogin({ [GITHUB_LOGIN_CLAIM]: value })).toBeNull();
  });

  it('never reads another claim', () => {
    expect(
      readGithubLogin({
        github_login: 'mashkovd',
        preferred_username: 'mashkovd',
        email: 'mashkovd@mctl.me',
        sub: 'mashkovd',
        name: 'mashkovd',
      }),
    ).toBeNull();
  });
});

describe('renderPage', () => {
  it('escapes every value', () => {
    const html = renderPage({
      title: '<t>',
      paragraphs: ['a & "b" <script>'],
      links: [{ href: 'https://x.example/?a=1&b="2"', label: "<l>'" }],
    });
    expect(html).toContain('<title>&lt;t&gt;</title>');
    expect(html).toContain('<p>a &amp; &quot;b&quot; &lt;script&gt;</p>');
    expect(html).toContain('<a href="https://x.example/?a=1&amp;b=&quot;2&quot;">&lt;l&gt;&#39;</a>');
    expect(html).not.toContain('<script');
  });
});

describe('upstream github (default)', () => {
  it.each([undefined, 'github' as const])('sends every entry point to GitHub when upstream is %s', async mode => {
    await listen(mode);
    for (const [, path] of SIGN_IN_ENTRY_POINTS) {
      const res = await get(path);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location')!);
      expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
      expect([...location.searchParams.keys()].sort()).toEqual(['client_id', 'redirect_uri', 'scope', 'state']);
      expect(location.searchParams.get('client_id')).toBe('gh-client');
      expect(location.searchParams.get('redirect_uri')).toBe(`${ISSUER}/github/callback`);
      expect(location.searchParams.get('scope')).toBe('read:user');
    }
    // ZITADEL is never contacted.
    expect(zitadel.requests).toEqual([]);
  });

  it('ignores an upstream choice on /login', async () => {
    await listen(undefined);
    const res = await get(`/login?returnTo=${encodeURIComponent('/catalog')}&upstream=zitadel`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).origin).toBe('https://github.com');
    expect(zitadel.requests).toEqual([]);
  });

  it('does not serve the ZITADEL callback', async () => {
    await listen(undefined);
    const res = await get('/zitadel/callback?code=z-code&state=0123456789abcdef', {
      Cookie: `${LOGIN_STATE_COOKIE_PREFIX}0123456789abcdef=1`,
    });
    await expectRefused(res, 404);
    expect(zitadel.requests).toEqual([]);
  });

  it('stores a GitHub sign-in without upstream data and completes it', async () => {
    await listen(undefined);
    const started = await start();
    expect(await knex('oidc_pending_auths').first()).toMatchObject({
      state: started.state,
      upstream: null,
      nonce: null,
      code_verifier: null,
    });
    const res = await get(`/github/callback?code=gh-code&state=${started.state}`, { Cookie: started.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://ovk-openclaw.mctl.ai/');
    expect(await sessionCount()).toBe(1);
  });
});

describe('upstream configuration', () => {
  it.each(['zitadel' as const, 'both' as const])('fails startup when %s is selected without a client', mode => {
    expect(() => createRouter({ ...routerOptions(mode), zitadel: undefined })).toThrow(/oidcProvider.zitadel/);
  });

  it.each([
    'http://auth.mctl.ai',
    'https://auth.mctl.ai/',
    'https://auth.mctl.ai?x=1',
    'https://auth.mctl.ai#x',
    'https://user@auth.mctl.ai',
    'auth.mctl.ai',
    '',
  ])('fails startup on issuer %j', issuer => {
    expect(() =>
      createRouter({
        ...routerOptions('zitadel'),
        zitadel: { issuer, clientId: ZITADEL_CLIENT_ID, clientSecret: ZITADEL_CLIENT_SECRET },
      }),
    ).toThrow(/oidcProvider.zitadel.issuer/);
  });

  it.each([
    { clientId: '', clientSecret: ZITADEL_CLIENT_SECRET },
    { clientId: ZITADEL_CLIENT_ID, clientSecret: '' },
  ])('fails startup on an empty client credential', credentials => {
    expect(() =>
      createRouter({ ...routerOptions('zitadel'), zitadel: { issuer: ZITADEL_ISSUER, ...credentials } }),
    ).toThrow(/clientId and clientSecret/);
  });

  it('does not need a ZITADEL client while upstream is github', () => {
    expect(() => createRouter(routerOptions('github'))).not.toThrow();
  });
});

describe('upstream zitadel', () => {
  beforeEach(() => listen('zitadel'));

  it.each(SIGN_IN_ENTRY_POINTS)('sends %s to ZITADEL with state, nonce and PKCE', async (_name, path) => {
    const res = await get(path);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(`${ZITADEL_ISSUER}/oauth/v2/authorize`);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      response_type: 'code',
      client_id: ZITADEL_CLIENT_ID,
      redirect_uri: ZITADEL_CALLBACK,
      scope: 'openid',
      state: expect.stringMatching(/^[A-Za-z0-9-]{16,128}$/),
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      code_challenge_method: 'S256',
    });
    const state = location.searchParams.get('state')!;
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0].startsWith(`${LOGIN_STATE_COOKIE_PREFIX}${state}=1;`)).toBe(true);
    expectHostOnly(cookies[0]);

    // The nonce and the verifier of that challenge stay server-side.
    const row = await knex('oidc_pending_auths').where({ state }).first();
    expect(row.upstream).toBe('zitadel');
    expect(row.nonce).toBe(location.searchParams.get('nonce'));
    expect(pkceChallenge(row.code_verifier)).toBe(location.searchParams.get('code_challenge'));
    expect(res.headers.get('location')).not.toContain(row.code_verifier);
  });

  it('uses a fresh state, nonce and verifier for every sign-in', async () => {
    const a = await start();
    const b = await start();
    for (const param of ['state', 'nonce', 'code_challenge']) {
      expect(a.authorize.searchParams.get(param)).not.toBe(b.authorize.searchParams.get(param));
    }
  });

  it.each(SIGN_IN_ENTRY_POINTS)(
    'signs a mapped member in from %s with a host-only session',
    async (_name, path, returnTo) => {
      const started = await start(path);
      const res = await finish(started);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(returnTo);
      const cookies = res.headers.getSetCookie();
      expect(cookies).toHaveLength(2);
      expect(cookies[0].startsWith(`${OIDC_SESSION_COOKIE}=`)).toBe(true);
      expect(cookies[1].startsWith(`${started.cookie.split('=')[0]}=;`)).toBe(true);
      cookies.forEach(expectHostOnly);

      // The session belongs to the claim's login, lowercased: the same user
      // id a GitHub sign-in yields.
      const sessionId = cookies[0].split(';')[0].slice(OIDC_SESSION_COOKIE.length + 1);
      expect((await store.getSession(sessionId))?.userId).toBe('mashkovd');
      expect(userExistsCalls).toEqual(['mashkovd']);
    },
  );

  it('redeems the code as a confidential client with the PKCE verifier', async () => {
    const started = await start();
    await finish(started);
    expect(zitadel.tokenRequests).toHaveLength(1);
    const [{ headers, body }] = zitadel.tokenRequests;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from(`${ZITADEL_CLIENT_ID}:${ZITADEL_CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'z-code',
      redirect_uri: ZITADEL_CALLBACK,
      code_verifier: expect.any(String),
    });
    expect(pkceChallenge(body.get('code_verifier')!)).toBe(started.authorize.searchParams.get('code_challenge'));
  });

  it('lets the signed-in browser obtain a Dex code', async () => {
    const started = await start(DEX_AUTHORIZE);
    const signedIn = await finish(started);
    const session = signedIn.headers.getSetCookie()[0].split(';')[0];
    const res = await get(DEX_AUTHORIZE, { Cookie: session });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(DEX_CALLBACK);
    expect(location.searchParams.get('code')).toBeTruthy();
    expect(location.searchParams.get('state')).toBe('dex-state');
  });

  it('refuses a mapped user who is not a member of any team', async () => {
    members = new Set();
    const res = await finish(await start());
    await expectRefused(res, 403);
    expect(res.text).toContain('not a member of any team');
    expect(userExistsCalls).toEqual(['mashkovd']);
  });

  it('refuses a token without the GitHub login claim', async () => {
    zitadel.idToken = nonce => signIdToken(idTokenClaims(nonce, { [GITHUB_LOGIN_CLAIM]: undefined }));
    const res = await finish(await start());
    await expectRefused(res, 403);
    expect(res.text).toContain('not linked to a portal user');
    // Membership is not even consulted: there is no user to look up.
    expect(userExistsCalls).toEqual([]);
  });

  it('never falls back to e-mail, username or subject when the claim is missing', async () => {
    // Every other identifying claim names a member.
    zitadel.idToken = nonce =>
      signIdToken(
        idTokenClaims(nonce, {
          [GITHUB_LOGIN_CLAIM]: undefined,
          sub: 'mashkovd',
          email: 'mashkovd@mctl.me',
          email_verified: true,
          preferred_username: 'mashkovd',
          name: 'mashkovd',
          github_login: 'mashkovd',
        }),
      );
    const res = await finish(await start());
    await expectRefused(res, 403);
    expect(userExistsCalls).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['an array', ['mashkovd']],
    ['a number', 1234],
    ['malformed', 'mashkovd@mctl.me'],
  ])('refuses a GitHub login claim that is %s', async (_name, value) => {
    zitadel.idToken = nonce => signIdToken(idTokenClaims(nonce, { [GITHUB_LOGIN_CLAIM]: value }));
    const res = await finish(await start());
    await expectRefused(res, 403);
    expect(userExistsCalls).toEqual([]);
  });

  it('refuses a token of another issuer', async () => {
    zitadel.idToken = nonce => signIdToken(idTokenClaims(nonce, { iss: 'https://evil.example' }));
    await expectRefused(await finish(await start()), 502);
    expect(userExistsCalls).toEqual([]);
  });

  it('refuses a token for another audience', async () => {
    zitadel.idToken = nonce => signIdToken(idTokenClaims(nonce, { aud: ['300000000000000009'], azp: undefined }));
    await expectRefused(await finish(await start()), 502);
    expect(userExistsCalls).toEqual([]);
  });

  it('refuses a token issued to another client of the same audience', async () => {
    zitadel.idToken = nonce => signIdToken(idTokenClaims(nonce, { azp: '300000000000000009' }));
    await expectRefused(await finish(await start()), 502);
    expect(userExistsCalls).toEqual([]);
  });

  it('refuses a token signed with a key ZITADEL does not publish', async () => {
    zitadel.idToken = nonce => signIdToken(idTokenClaims(nonce), { key: otherKey });
    await expectRefused(await finish(await start()), 502);
    expect(userExistsCalls).toEqual([]);
  });

  it('refuses an unsigned token', async () => {
    zitadel.idToken = async nonce => new jose.UnsecuredJWT(idTokenClaims(nonce)).setExpirationTime('5m').encode();
    await expectRefused(await finish(await start()), 502);
    expect(userExistsCalls).toEqual([]);
  });

  it('refuses an expired token', async () => {
    zitadel.idToken = nonce =>
      signIdToken(idTokenClaims(nonce), { expiresIn: Math.floor(Date.now() / 1000) - 3600 });
    await expectRefused(await finish(await start()), 502);
    expect(userExistsCalls).toEqual([]);
  });

  it('refuses a token without a subject', async () => {
    zitadel.idToken = nonce => signIdToken(idTokenClaims(nonce, { sub: undefined }));
    await expectRefused(await finish(await start()), 502);
  });

  it('refuses a token minted for another sign-in (nonce mismatch)', async () => {
    zitadel.idToken = () => signIdToken(idTokenClaims('nonce-of-another-sign-in'));
    await expectRefused(await finish(await start()), 502);
    expect(userExistsCalls).toEqual([]);
  });

  it('refuses a token without a nonce', async () => {
    zitadel.idToken = () => signIdToken(idTokenClaims('', { nonce: undefined }));
    await expectRefused(await finish(await start()), 502);
    expect(userExistsCalls).toEqual([]);
  });

  it('refuses when the code exchange fails', async () => {
    zitadel.tokenStatus = 400;
    await expectRefused(await finish(await start()), 502);
  });

  it('refuses a token response without an ID token', async () => {
    zitadel.idToken = async () => '';
    await expectRefused(await finish(await start()), 502);
  });

  it('picks up a rotated signing key', async () => {
    await finish(await start());
    expect(await sessionCount()).toBe(1);
    // ZITADEL now signs with a key published after the first fetch.
    zitadel.keys = [signingJwk, rotatedJwk];
    zitadel.idToken = nonce => signIdToken(idTokenClaims(nonce), { key: rotatedKey, kid: 'key-2' });
    const res = await finish(await start());
    expect(res.status).toBe(302);
    expect(await sessionCount()).toBe(2);
  });

  it('refuses a callback from a browser that did not start the sign-in', async () => {
    const started = await start();
    for (const cookie of ['', `${LOGIN_STATE_COOKIE_PREFIX}another-state-0123456789=1`, `${started.cookie}0`]) {
      const res = await get(`/zitadel/callback?code=z-code&state=${started.state}`, cookie ? { Cookie: cookie } : {});
      await expectRefused(res, 400);
    }
    // Nothing was redeemed, and the pending sign-in is still intact.
    expect(zitadel.tokenRequests).toEqual([]);
    expect(await pendingCount()).toBe(1);
  });

  it('refuses a state it never issued', async () => {
    const state = 'never-issued-0123456789';
    const res = await get(`/zitadel/callback?code=z-code&state=${state}`, {
      Cookie: `${LOGIN_STATE_COOKIE_PREFIX}${state}=1`,
    });
    await expectRefused(res, 400);
    expect(zitadel.tokenRequests).toEqual([]);
  });

  it('accepts a state only once', async () => {
    const started = await start();
    expect((await finish(started)).status).toBe(302);
    const again = await finish(started);
    expect(again.status).toBe(400);
    expect(zitadel.tokenRequests).toHaveLength(1);
    expect(await sessionCount()).toBe(1);
  });

  it('refuses an expired sign-in', async () => {
    const started = await start();
    await knex('oidc_pending_auths').update({ expires_at: Date.now() - 1 });
    await expectRefused(await finish(started), 400);
    expect(zitadel.tokenRequests).toEqual([]);
  });

  it('refuses a pending sign-in that carries no nonce or verifier', async () => {
    for (const column of ['nonce', 'code_verifier']) {
      const started = await start();
      await knex('oidc_pending_auths').where({ state: started.state }).update({ [column]: null });
      await expectRefused(await finish(started), 400);
    }
    expect(zitadel.tokenRequests).toEqual([]);
  });

  it('refuses a pending sign-in of another upstream even if it carries a nonce and verifier', async () => {
    for (const upstream of ['github', null, 'ZITADEL']) {
      const started = await start();
      await knex('oidc_pending_auths').where({ state: started.state }).update({ upstream });
      await expectRefused(await finish(started), 400);
    }
    expect(zitadel.tokenRequests).toEqual([]);
  });

  it('refuses a callback without a code or a state', async () => {
    const started = await start();
    for (const query of [`state=${started.state}`, 'code=z-code', '']) {
      await expectRefused(await get(`/zitadel/callback?${query}`, { Cookie: started.cookie }), 400);
    }
  });

  it('reports an upstream error without echoing it', async () => {
    const started = await start();
    const res = await get(
      `/zitadel/callback?error=${encodeURIComponent('<script>alert(1)</script>')}&state=${started.state}`,
      { Cookie: started.cookie },
    );
    await expectRefused(res, 400);
    expect(res.text).not.toContain('alert(1)');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('no longer serves the GitHub callback', async () => {
    const started = await start();
    const res = await get(`/github/callback?code=gh-code&state=${started.state}`, { Cookie: started.cookie });
    await expectRefused(res, 404);
    // The pending ZITADEL sign-in was not consumed by the attempt.
    expect(await pendingCount()).toBe(1);
  });

  it('ignores an upstream choice on /login', async () => {
    const res = await get(`/login?returnTo=${encodeURIComponent('/catalog')}&upstream=github`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).origin).toBe(ZITADEL_ISSUER);
  });

  it('does not start a sign-in for a browser that already has a session', async () => {
    await store.saveSession('portal-session', 'mashkovd', Date.now() + 60_000);
    const res = await get(DEX_AUTHORIZE, { Cookie: `${OIDC_SESSION_COOKIE}=portal-session` });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).origin).toBe('https://ops.mctl.ai');
    expect(zitadel.requests).toEqual([]);
  });
});

describe('ZITADEL discovery', () => {
  beforeEach(() => listen('zitadel'));

  async function expectUnavailable() {
    const res = await get(SIGN_IN_ENTRY_POINTS[0][1]);
    expect(res.status).toBe(502);
    expect(res.headers.get('location')).toBeNull();
    // A sign-in that could not start leaves nothing behind.
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await pendingCount()).toBe(0);
  }

  it('refuses a discovery document of another issuer', async () => {
    zitadel.discovery = { ...(zitadel.discovery as object), issuer: 'https://evil.example' };
    await expectUnavailable();
  });

  it.each(['authorization_endpoint', 'token_endpoint', 'jwks_uri'])(
    'refuses a %s on another origin',
    async endpoint => {
      zitadel.discovery = { ...(zitadel.discovery as object), [endpoint]: 'https://evil.example/x' };
      await expectUnavailable();
    },
  );

  it.each(['authorization_endpoint', 'token_endpoint', 'jwks_uri'])('refuses a missing %s', async endpoint => {
    zitadel.discovery = { ...(zitadel.discovery as object), [endpoint]: undefined };
    await expectUnavailable();
  });

  it('refuses an http endpoint on the issuer host', async () => {
    zitadel.discovery = { ...(zitadel.discovery as object), token_endpoint: 'http://auth.mctl.ai/oauth/v2/token' };
    await expectUnavailable();
  });

  it('treats a failed read as an error and reads again on the next sign-in', async () => {
    const good = zitadel.discovery;
    zitadel.discovery = 503;
    await expectUnavailable();
    zitadel.discovery = good;
    const res = await get(SIGN_IN_ENTRY_POINTS[0][1]);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).origin).toBe(ZITADEL_ISSUER);
  });

  it('reads discovery once it has succeeded', async () => {
    await start();
    await start();
    expect(zitadel.requests.filter(u => u.endsWith('/.well-known/openid-configuration'))).toHaveLength(1);
  });
});

describe('upstream both', () => {
  beforeEach(() => listen('both'));

  it.each(SIGN_IN_ENTRY_POINTS)('offers both upstreams at %s without starting either', async (_name, path, returnTo) => {
    const res = await get(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await pendingCount()).toBe(0);
    expect(zitadel.requests).toEqual([]);

    const hrefs = [...res.text.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
    expect(hrefs).toHaveLength(2);
    expect(hrefs.map(h => new URL(h).searchParams.get('upstream'))).toEqual(['zitadel', 'github']);
    for (const href of hrefs) {
      const url = new URL(href);
      expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/login`);
      expect(url.searchParams.get('returnTo')).toBe(returnTo);
    }
  });

  it('never offers a returnTo outside the allowlist', async () => {
    const res = await get(`/login?returnTo=${encodeURIComponent('https://evil.example/"><script>')}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('evil.example');
    expect(res.text).not.toContain('<script');
    const hrefs = [...res.text.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
    expect(hrefs.map(h => new URL(h).searchParams.get('returnTo'))).toEqual(['/', '/']);
  });

  it('starts ZITADEL from its link and signs the member in', async () => {
    const started = await start(`/login?returnTo=${encodeURIComponent('/catalog')}&upstream=zitadel`);
    expect(started.authorize.origin).toBe(ZITADEL_ISSUER);
    const res = await finish(started);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/catalog');
  });

  it('starts GitHub from its link and signs the member in', async () => {
    const started = await start(`/login?returnTo=${encodeURIComponent('/catalog')}&upstream=github`);
    expect(started.authorize.origin).toBe('https://github.com');
    const res = await get(`/github/callback?code=gh-code&state=${started.state}`, { Cookie: started.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/catalog');
    expect(await sessionCount()).toBe(1);
  });

  it.each(['', 'evil', 'ZITADEL', 'github,zitadel'])('offers the choice again for upstream=%j', async choice => {
    const res = await get(`/login?returnTo=${encodeURIComponent('/catalog')}&upstream=${encodeURIComponent(choice)}`);
    expect(res.status).toBe(200);
    expect(await pendingCount()).toBe(0);
  });

  it('refuses a GitHub-started state at the ZITADEL callback', async () => {
    const started = await start(`/login?returnTo=${encodeURIComponent('/catalog')}&upstream=github`);
    const res = await finish(started);
    await expectRefused(res, 400);
    expect(zitadel.tokenRequests).toEqual([]);
  });

  it('refuses a ZITADEL-started state at the GitHub callback', async () => {
    const started = await start(`/login?returnTo=${encodeURIComponent('/catalog')}&upstream=zitadel`);
    const res = await get(`/github/callback?code=gh-code&state=${started.state}`, { Cookie: started.cookie });
    await expectRefused(res, 400);
    // GitHub was never asked to redeem anything.
    expect(zitadel.requests.filter(u => new URL(u).hostname !== 'auth.mctl.ai')).toEqual([]);
  });

  it('skips the choice for a browser that already has a session', async () => {
    await store.saveSession('portal-session', 'mashkovd', Date.now() + 60_000);
    const res = await get(`/login?returnTo=${encodeURIComponent('/catalog')}`, {
      Cookie: `${OIDC_SESSION_COOKIE}=portal-session`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/catalog');
  });
});

describe('pending sign-in storage', () => {
  it('adds the upstream columns to a table created before they existed', async () => {
    const legacy = knexLib({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    try {
      await legacy.schema.createTable('oidc_pending_auths', t => {
        t.string('state', 128).primary().notNullable();
        t.text('return_to').notNullable();
        t.bigInteger('expires_at').notNullable();
      });
      const expiresAt = Date.now() + 60_000;
      await legacy('oidc_pending_auths').insert({ state: 'old-state', return_to: '/old', expires_at: expiresAt });

      const migrated = new OidcStore(legacy, logger, false);
      await migrated.init();
      // Idempotent: a second pod starting against the migrated table.
      await new OidcStore(legacy, logger, false).init();

      // A row written before the migration is a GitHub sign-in.
      expect(await migrated.consumePendingAuth('old-state')).toEqual({
        returnTo: '/old',
        expiresAt,
        upstream: 'github',
        nonce: undefined,
        codeVerifier: undefined,
      });
      await migrated.savePendingAuth('new-state', '/new', expiresAt, { nonce: 'n', codeVerifier: 'v' });
      expect(await migrated.consumePendingAuth('new-state')).toEqual({
        returnTo: '/new',
        expiresAt,
        upstream: 'zitadel',
        nonce: 'n',
        codeVerifier: 'v',
      });
      expect(await migrated.consumePendingAuth('new-state')).toBeUndefined();
    } finally {
      await legacy.destroy();
    }
  });
});
