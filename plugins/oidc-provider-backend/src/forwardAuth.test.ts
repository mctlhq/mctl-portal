import express from 'express';
import { AddressInfo } from 'net';
import http, { Server } from 'http';
import knexLib, { Knex } from 'knex';
import { KeyStore } from './keyStore';
import { OidcStore } from './oidcStore';
import {
  buildHostOnlyCookie,
  createRouter,
  FORWARD_AUTH_CALLBACK_PATH,
  FORWARD_AUTH_SESSION_COOKIE,
  FORWARD_AUTH_STATE_COOKIE,
  LOGIN_STATE_COOKIE_PREFIX,
  parseHostname,
  sanitizeReturnPath,
  validateForwardAuthHosts,
} from './router';
import { OIDC_SESSION_COOKIE } from './sessionAuth';

// End-to-end tests of the browser session cookies over real HTTP: the portal
// session must stay on the portal host, and a forward-auth protected host
// must only ever accept its own host-bound session.

const ISSUER = 'https://app.mctl.ai/api/oidc-provider';
const DEX_CALLBACK = 'https://ops.mctl.ai/api/dex/callback';
const DEX_AUTHORIZE = `/authorize?response_type=code&client_id=dex&redirect_uri=${encodeURIComponent(
  DEX_CALLBACK,
)}&state=dex-state`;
// What vault-secrets' openclaw intake page sends to /login: an absolute
// portal URL, which also ends in .mctl.ai.
const VAULT_INTAKE_RETURN_TO =
  'https://app.mctl.ai/api/vault-secrets/openclaw/intake?team=ovk&service=openclaw';
// Every browser entry point that can lead to the portal session cookie.
const SIGN_IN_ENTRY_POINTS: Array<[string, string]> = [
  ['/login for a tenant returnTo (old forward-auth path)', `/login?returnTo=${encodeURIComponent('https://ovk-openclaw.mctl.ai/')}`],
  ['/login for the vault-secrets intake returnTo', `/login?returnTo=${encodeURIComponent(VAULT_INTAKE_RETURN_TO)}`],
  ['/tenant-login', '/tenant-login?tenant=ovk&service=openclaw'],
  ['/authorize (Dex)', DEX_AUTHORIZE],
  [
    '/forward-auth/authorize',
    '/forward-auth/authorize?tenant=ovk&service=openclaw&host=ovk-openclaw.mctl.ai&state=0123456789abcdef',
  ],
];
const DEFAULT_ROLES: Record<string, string> = {
  'mashkovd/admins': 'owner',
  'mashkovd/ovk': 'member',
  'mashkovd/labs': 'owner',
  'mashkovd/claude': 'owner',
  'mashkovd/a': 'owner',
};
let ROLES: Record<string, string>;
let TENANTS: Set<string>;

const realFetch = global.fetch;
let server: Server;
let base: string;
let knex: Knex;
let store: OidcStore;

beforeAll(() => {
  // createRouter schedules a cleanup interval; keep it from holding Jest open.
  jest.spyOn(global, 'setInterval').mockImplementation((() => 0) as any);
});

beforeEach(async () => {
  ROLES = { ...DEFAULT_ROLES };
  TENANTS = new Set(['admins', 'ovk', 'labs', 'claude', 'a']);
  knex = knexLib({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
  const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any;
  store = new OidcStore(knex, logger, false);
  await store.init();
  const router = createRouter({
    logger,
    membership: {
      getUserGroups: async () => [],
      userExists: async () => true,
      getUserRole: async (userId, tenant) => ROLES[`${userId}/${tenant}`] ?? null,
      tenantExists: async tenant => TENANTS.has(tenant),
    },
    keyStore: {} as KeyStore,
    issuer: ISSUER,
    clients: [{ clientId: 'dex', clientSecret: 'dex-secret', redirectUris: [DEX_CALLBACK] }],
    githubClientId: 'gh-client',
    githubClientSecret: 'gh-secret',
    store,
    forwardAuthHosts: [
      { tenant: 'admins', service: 'temporal-web', host: 'temporal.mctl.ai' },
      { tenant: 'labs', service: 'claude-remote', host: 'claude-remote.mctl.ai' },
    ],
  });
  const app = express();
  app.use('/api/oidc-provider', router);
  // Bind 127.0.0.1 explicitly: with the default dual-stack bind, another
  // process can hold the same port on 127.0.0.1 and answer instead.
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oidc-provider`;
});

afterEach(async () => {
  global.fetch = realFetch;
  await new Promise(resolve => server.close(resolve));
  await knex.destroy();
});

interface TestResponse {
  status: number;
  text: string;
  headers: { get(name: string): string | null; getSetCookie(): string[] };
}

// Requests are top-level browser navigations unless a test says otherwise.
// Plain node:http, because fetch overwrites Sec-Fetch-Mode with "cors". No
// agent, so a kept-alive socket can never reach a previous test's server.
// An empty header value means "leave the header out".
function get(path: string, headers: Record<string, string> = {}): Promise<TestResponse> {
  const merged: Record<string, string> = { 'Sec-Fetch-Mode': 'navigate', ...headers };
  const sent = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== ''));
  return new Promise((resolve, reject) => {
    http
      .get(`${base}${path}`, { headers: sent, agent: false }, res => {
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

async function portalSession(userId = 'mashkovd'): Promise<string> {
  const sessionId = `portal-${Math.random().toString(36).slice(2)}`;
  await store.saveSession(sessionId, userId, Date.now() + 60 * 60 * 1000);
  return sessionId;
}

// What Traefik sends to /forward-auth for a browser request to `host`.
function forwardAuth(
  tenant: string,
  service: string,
  host: string,
  opts: { uri?: string; cookie?: string; headers?: Record<string, string> } = {},
): Promise<TestResponse> {
  const headers: Record<string, string> = {
    'X-Forwarded-Host': host,
    'X-Forwarded-Uri': opts.uri ?? '/',
    'X-Forwarded-Proto': 'https',
    ...opts.headers,
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  return get(
    `/forward-auth?tenant=${encodeURIComponent(tenant)}&service=${encodeURIComponent(service)}`,
    headers,
  );
}

function cookieValue(res: TestResponse, name: string): string | undefined {
  const line = res.headers.getSetCookie().find(c => c.startsWith(`${name}=`));
  return line?.split(';')[0].slice(name.length + 1);
}

// Runs the whole redirect flow for one protected host and returns the
// host session cookie value it ends with.
async function signInToHost(tenant: string, service: string, host: string, uri = '/'): Promise<{
  sessionCookie: string;
  finalLocation: string;
  portal: string;
}> {
  const start = await forwardAuth(tenant, service, host, { uri });
  expect(start.status).toBe(302);
  const state = cookieValue(start, FORWARD_AUTH_STATE_COOKIE)!;
  const authorize = new URL(start.headers.get('location')!);

  const portal = await portalSession();
  const issued = await get(`/forward-auth/authorize${authorize.search}`, {
    Cookie: `${OIDC_SESSION_COOKIE}=${portal}`,
  });
  expect(issued.status).toBe(302);
  const callback = new URL(issued.headers.get('location')!);

  const done = await forwardAuth(tenant, service, host, {
    uri: `${callback.pathname}${callback.search}`,
    cookie: `${FORWARD_AUTH_STATE_COOKIE}=${state}`,
  });
  expect(done.status).toBe(302);
  return {
    sessionCookie: `${FORWARD_AUTH_SESSION_COOKIE}=${cookieValue(done, FORWARD_AUTH_SESSION_COOKIE)}`,
    finalLocation: done.headers.get('location')!,
    portal,
  };
}

function expectHostOnly(setCookie: string) {
  expect(setCookie).not.toMatch(/;\s*domain=/i);
  expect(setCookie).toMatch(/^__Host-/);
  expect(setCookie).toContain('; Path=/');
  expect(setCookie).toContain('; Secure');
  expect(setCookie).toContain('; HttpOnly');
  expect(setCookie).toContain('; SameSite=Lax');
}

function mockGitHub(login = 'mashkovd') {
  global.fetch = jest.fn(async (input: any) => {
    const url = String(input);
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gh-token' }));
    }
    if (url.startsWith('https://api.github.com/user')) {
      return new Response(JSON.stringify({ login }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as any;
}

describe('portal session cookie', () => {
  it.each(SIGN_IN_ENTRY_POINTS)('is host-only after GitHub sign-in started by %s', async (_name, path) => {
    const start = await get(path);
    expect(start.status).toBe(302);
    const github = new URL(start.headers.get('location')!);
    expect(github.origin).toBe('https://github.com');
    const githubState = github.searchParams.get('state')!;
    const loginCookie = `${LOGIN_STATE_COOKIE_PREFIX}${githubState}`;
    const startCookies = start.headers.getSetCookie();
    expect(startCookies).toHaveLength(1);
    expect(startCookies[0].startsWith(`${loginCookie}=1;`)).toBe(true);
    expectHostOnly(startCookies[0]);

    mockGitHub();
    const callback = await get(`/github/callback?code=gh-code&state=${githubState}`, {
      Cookie: `${loginCookie}=1`,
    });
    expect(callback.status).toBe(302);
    const cookies = callback.headers.getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0].startsWith(`${OIDC_SESSION_COOKIE}=`)).toBe(true);
    expect(cookies[1].startsWith(`${loginCookie}=;`)).toBe(true);
    cookies.forEach(expectHostOnly);
    expect(cookies.some(c => c.startsWith('oidc_session='))).toBe(false);
  });

  it.each(SIGN_IN_ENTRY_POINTS)(
    'is never re-issued for an already signed-in browser by %s',
    async (_name, path) => {
      const portal = await portalSession();
      const res = await get(path, { Cookie: `${OIDC_SESSION_COOKIE}=${portal}` });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location')!).origin).not.toBe('https://github.com');
      expect(res.headers.getSetCookie()).toEqual([]);
    },
  );

  it('sends /tenant-login to the tenant host without a cookie', async () => {
    const portal = await portalSession();
    const res = await get('/tenant-login?tenant=ovk&service=openclaw', {
      Cookie: `${OIDC_SESSION_COOKIE}=${portal}`,
    });
    expect(res.headers.get('location')).toBe('https://ovk-openclaw.mctl.ai/');
  });

  it.each(SIGN_IN_ENTRY_POINTS)(
    'ignores a session tossed onto .mctl.ai under the legacy name at %s',
    async (_name, path) => {
      // A sibling host can still set a non-prefixed cookie for the parent
      // domain; the browser refuses that for a __Host- name. Even a valid
      // session id sent under the legacy name must count as signed out.
      const portal = await portalSession();
      const res = await get(path, { Cookie: `oidc_session=${portal}` });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
    },
  );

  it('builds every cookie without a Domain attribute', () => {
    const cookie = buildHostOnlyCookie('__Host-x', 'v', 60);
    expect(cookie).toBe('__Host-x=v; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60');
    expectHostOnly(cookie);
  });
});

describe('forward-auth', () => {
  it('does not accept the portal session cookie on a protected host', async () => {
    const portal = await portalSession();
    for (const cookie of [`${OIDC_SESSION_COOKIE}=${portal}`, `oidc_session=${portal}`]) {
      const res = await forwardAuth('admins', 'openclaw', 'admins-openclaw.mctl.ai', { cookie });
      expect(res.status).toBe(302);
      expect(res.headers.get('x-forwarded-user')).toBeNull();
    }
  });

  it('refuses a host that is not registered for the tenant and service', async () => {
    for (const host of ['evil.mctl.ai', 'ovk-openclaw.mctl.ai', 'app.mctl.ai', '']) {
      const res = await forwardAuth('admins', 'openclaw', host);
      expect(res.status).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it('starts sign-in with a host-only state cookie and a redirect to the portal', async () => {
    const res = await forwardAuth('admins', 'openclaw', 'admins-openclaw.mctl.ai', { uri: '/chat?x=1' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/forward-auth/authorize`);
    expect(location.searchParams.get('host')).toBe('admins-openclaw.mctl.ai');
    expect(location.searchParams.get('returnPath')).toBe('/chat?x=1');
    const [stateCookie] = res.headers.getSetCookie();
    expectHostOnly(stateCookie);
    expect(cookieValue(res, FORWARD_AUTH_STATE_COOKIE)).toBe(location.searchParams.get('state'));
  });

  it('completes sign-in with a host-bound session and authorizes it', async () => {
    const { sessionCookie, finalLocation } = await signInToHost(
      'admins',
      'openclaw',
      'admins-openclaw.mctl.ai',
      '/chat?x=1',
    );
    expect(finalLocation).toBe('https://admins-openclaw.mctl.ai/chat?x=1');

    const res = await forwardAuth('admins', 'openclaw', 'admins-openclaw.mctl.ai', { cookie: sessionCookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-forwarded-user')).toBe('mashkovd');
    expect(res.headers.get('x-mctl-team-role')).toBe('owner');
  });

  it('sets the host session cookie host-only and leaves the state cookie alone', async () => {
    const start = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    const state = cookieValue(start, FORWARD_AUTH_STATE_COOKIE)!;
    const issued = await get(`/forward-auth/authorize${new URL(start.headers.get('location')!).search}`, {
      Cookie: `${OIDC_SESSION_COOKIE}=${await portalSession()}`,
    });
    const callback = new URL(issued.headers.get('location')!);
    expect(callback.origin).toBe('https://ovk-openclaw.mctl.ai');
    expect(callback.pathname).toBe(FORWARD_AUTH_CALLBACK_PATH);

    const done = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', {
      uri: `${callback.pathname}${callback.search}`,
      cookie: `${FORWARD_AUTH_STATE_COOKIE}=${state}`,
    });
    const cookies = done.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0].startsWith(`${FORWARD_AUTH_SESSION_COOKIE}=`)).toBe(true);
    expectHostOnly(cookies[0]);
  });

  it('rejects a host session on any other tenant, service or host', async () => {
    const { sessionCookie } = await signInToHost('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    const elsewhere: Array<[string, string, string]> = [
      ['admins', 'openclaw', 'admins-openclaw.mctl.ai'],
      ['ovk', 'other', 'ovk-other.mctl.ai'],
      ['admins', 'temporal-web', 'temporal.mctl.ai'],
    ];
    for (const [tenant, service, host] of elsewhere) {
      const res = await forwardAuth(tenant, service, host, { cookie: sessionCookie });
      expect(res.status).toBe(302);
      expect(res.headers.get('x-forwarded-user')).toBeNull();
    }
  });

  it('binds a session to the exact alias host it was issued on', async () => {
    const { sessionCookie } = await signInToHost('admins', 'temporal-web', 'temporal.mctl.ai');
    const same = await forwardAuth('admins', 'temporal-web', 'temporal.mctl.ai', { cookie: sessionCookie });
    expect(same.status).toBe(200);
    const canonical = await forwardAuth('admins', 'temporal-web', 'admins-temporal-web.mctl.ai', {
      cookie: sessionCookie,
    });
    expect(canonical.status).toBe(302);
  });

  it('ignores a host session tossed onto .mctl.ai under a non-prefixed name', async () => {
    const { sessionCookie } = await signInToHost('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    const hostSessionId = sessionCookie.split('=')[1];
    const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', {
      cookie: `mctl_forward_auth=${hostSessionId}; x${FORWARD_AUTH_SESSION_COOKIE}=${hostSessionId}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('x-forwarded-user')).toBeNull();
  });

  it('does not accept a host session as the portal session', async () => {
    const { sessionCookie } = await signInToHost('admins', 'openclaw', 'admins-openclaw.mctl.ai');
    const hostSessionId = sessionCookie.split('=')[1];
    const res = await get(
      '/forward-auth/authorize?tenant=admins&service=openclaw&host=admins-openclaw.mctl.ai&state=0123456789abcdef',
      { Cookie: `${OIDC_SESSION_COOKIE}=${hostSessionId}` },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
  });
});

describe('forward-auth callback', () => {
  async function issueCode(tenant: string, service: string, host: string) {
    const start = await forwardAuth(tenant, service, host);
    const state = cookieValue(start, FORWARD_AUTH_STATE_COOKIE)!;
    const issued = await get(`/forward-auth/authorize${new URL(start.headers.get('location')!).search}`, {
      Cookie: `${OIDC_SESSION_COOKIE}=${await portalSession()}`,
    });
    const callback = new URL(issued.headers.get('location')!);
    return { state, uri: `${callback.pathname}${callback.search}`, code: callback.searchParams.get('code')! };
  }

  it('rejects a callback without the matching state cookie', async () => {
    const { uri } = await issueCode('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    for (const cookie of [undefined, `${FORWARD_AUTH_STATE_COOKIE}=00000000-0000-0000-0000-000000000000`]) {
      const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { uri, cookie });
      expect(res.status).toBe(400);
      expect(cookieValue(res, FORWARD_AUTH_SESSION_COOKIE)).toBeUndefined();
    }
  });

  it('accepts a code only once', async () => {
    const { uri, state } = await issueCode('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    const cookie = `${FORWARD_AUTH_STATE_COOKIE}=${state}`;
    expect((await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { uri, cookie })).status).toBe(302);
    expect((await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { uri, cookie })).status).toBe(400);
  });

  it('rejects a code redeemed for another tenant or host', async () => {
    const { uri, state } = await issueCode('admins', 'openclaw', 'admins-openclaw.mctl.ai');
    const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', {
      uri,
      cookie: `${FORWARD_AUTH_STATE_COOKIE}=${state}`,
    });
    expect(res.status).toBe(400);
    expect(cookieValue(res, FORWARD_AUTH_SESSION_COOKIE)).toBeUndefined();
  });

  it('rejects an expired code', async () => {
    const { uri, state, code } = await issueCode('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    await knex('oidc_forward_auth_codes').where({ code }).update({ expires_at: Date.now() - 1 });
    const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', {
      uri,
      cookie: `${FORWARD_AUTH_STATE_COOKIE}=${state}`,
    });
    expect(res.status).toBe(400);
  });
});

describe('forward-auth authorize', () => {
  it('refuses an unregistered host without issuing a code', async () => {
    const portal = await portalSession();
    for (const host of ['evil.mctl.ai', 'evil.example', 'ovk-openclaw.mctl.ai']) {
      const res = await get(
        `/forward-auth/authorize?tenant=admins&service=openclaw&host=${host}&state=0123456789abcdef`,
        { Cookie: `${OIDC_SESSION_COOKIE}=${portal}` },
      );
      expect(res.status).toBe(400);
    }
    expect(await knex('oidc_forward_auth_codes').count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it('refuses a user who is not a member of the tenant', async () => {
    const portal = await portalSession('stranger');
    const res = await get(
      '/forward-auth/authorize?tenant=admins&service=openclaw&host=admins-openclaw.mctl.ai&state=0123456789abcdef',
      { Cookie: `${OIDC_SESSION_COOKIE}=${portal}` },
    );
    expect(res.status).toBe(403);
  });

  it('sends a browser without a portal session to GitHub and back here', async () => {
    const res = await get(
      '/forward-auth/authorize?tenant=admins&service=openclaw&host=admins-openclaw.mctl.ai&state=0123456789abcdef',
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
  });
});

describe('sanitizeReturnPath', () => {
  it('keeps a same-host path', () => {
    expect(sanitizeReturnPath('/chat?x=1')).toBe('/chat?x=1');
  });

  it('drops anything that could leave the host or loop on the callback', () => {
    for (const value of [
      '',
      'https://evil.example/',
      '//evil.example',
      '/\\evil.example',
      '/\t/evil.example',
      FORWARD_AUTH_CALLBACK_PATH,
      `${FORWARD_AUTH_CALLBACK_PATH}?code=x`,
    ]) {
      expect(sanitizeReturnPath(value)).toBe('/');
    }
  });
});

async function startGitHubSignIn(path = DEX_AUTHORIZE): Promise<{ state: string; cookie: string }> {
  const start = await get(path);
  const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
  return { state, cookie: `${LOGIN_STATE_COOKIE_PREFIX}${state}=1` };
}

describe('GitHub sign-in is bound to the browser that started it', () => {
  it('rejects a callback without the login state cookie (login CSRF)', async () => {
    const { state } = await startGitHubSignIn();
    mockGitHub('attacker');
    const res = await get(`/github/callback?code=gh-code&state=${state}`);
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a login state cookie for a different sign-in', async () => {
    const first = await startGitHubSignIn();
    const second = await startGitHubSignIn();
    mockGitHub();
    const res = await get(`/github/callback?code=gh-code&state=${first.state}`, { Cookie: second.cookie });
    expect(res.status).toBe(400);
  });

  it('lets sign-ins started in parallel tabs both complete', async () => {
    const first = await startGitHubSignIn();
    const second = await startGitHubSignIn();
    const jar = `${first.cookie}; ${second.cookie}`;
    mockGitHub();
    expect((await get(`/github/callback?code=a&state=${second.state}`, { Cookie: jar })).status).toBe(302);
    expect((await get(`/github/callback?code=b&state=${first.state}`, { Cookie: jar })).status).toBe(302);
  });
});

describe('protected host validation (no open redirect)', () => {
  const codeCount = async () => Number((await knex('oidc_forward_auth_codes').count({ n: '*' }))[0].n);

  const BAD_SERVICES = [
    'x.evil.example/',
    'x@evil.example/',
    'x#',
    'x?y',
    'x.y',
    'x\\evil.example',
    'x%2fevil.example',
    'x%40evil.example',
    'x%23',
    'x/',
    '-x',
    'x-',
  ];

  it.each(BAD_SERVICES)('authorize refuses service %j without issuing a code', async service => {
    const portal = await portalSession();
    for (const host of [`ovk-${service}.mctl.ai`, 'ovk-x.evil.example/.mctl.ai', 'evil.example']) {
      const res = await get(
        `/forward-auth/authorize?tenant=ovk&service=${encodeURIComponent(service)}&host=${encodeURIComponent(
          host,
        )}&state=0123456789abcdef`,
        { Cookie: `${OIDC_SESSION_COOKIE}=${portal}` },
      );
      expect(res.status).toBe(400);
    }
    expect(await codeCount()).toBe(0);
  });

  it.each(BAD_SERVICES)('authorize refuses tenant %j without issuing a code', async tenant => {
    const portal = await portalSession();
    const res = await get(
      `/forward-auth/authorize?tenant=${encodeURIComponent(tenant)}&service=openclaw&host=${encodeURIComponent(
        `${tenant}-openclaw.mctl.ai`,
      )}&state=0123456789abcdef`,
      { Cookie: `${OIDC_SESSION_COOKIE}=${portal}` },
    );
    expect(res.status).toBe(400);
    expect(await codeCount()).toBe(0);
  });

  const BAD_HOSTS = [
    'ovk-openclaw.mctl.ai/',
    'ovk-openclaw.mctl.ai/x',
    'ovk-openclaw.mctl.ai:443',
    'ovk-openclaw.mctl.ai:8443',
    'user@ovk-openclaw.mctl.ai',
    'evil.example@ovk-openclaw.mctl.ai',
    'ovk-openclaw.mctl.ai#',
    'ovk-openclaw.mctl.ai?',
    'ovk-openclaw.mctl.ai\\',
    'ovk-openclaw.mctl.ai%2f',
    'ovk-openclaw%2emctl.ai',
    'ovk-openclaw.mctl.ai.',
    'ovk-openclaw.mctl.ai.evil.example',
  ];

  it.each(BAD_HOSTS)('authorize refuses host %j for a valid pair', async host => {
    const portal = await portalSession();
    const res = await get(
      `/forward-auth/authorize?tenant=ovk&service=openclaw&host=${encodeURIComponent(host)}&state=0123456789abcdef`,
      { Cookie: `${OIDC_SESSION_COOKIE}=${portal}` },
    );
    expect(res.status).toBe(400);
    expect(await codeCount()).toBe(0);
  });

  it.each(BAD_HOSTS)('forward-auth refuses forwarded host %j', async host => {
    const res = await forwardAuth('ovk', 'openclaw', host);
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it.each(BAD_SERVICES)('forward-auth refuses service %j', async service => {
    const res = await forwardAuth('ovk', service, `ovk-${service}.mctl.ai`);
    expect([400, 403]).toContain(res.status);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it.each([
    ['evil.example/', 'x'],
    ['evil.example#', 'x'],
    ['x@evil.example', 'x'],
    ['ovk', 'x.evil.example/'],
    ['ovk', 'x\\evil'],
  ])('/tenant-login refuses tenant %j service %j before storing a returnTo', async (tenant, service) => {
    const res = await get(
      `/tenant-login?tenant=${encodeURIComponent(tenant)}&service=${encodeURIComponent(service)}`,
    );
    expect(res.status).toBe(400);
    expect(res.text).toBe('Invalid tenant or service');
    expect(res.headers.get('location')).toBeNull();
    expect(await knex('oidc_pending_auths').count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it('accepts a host given in upper case and binds the lowercase hostname', async () => {
    const { finalLocation } = await signInToHost('ovk', 'openclaw', 'OVK-OpenClaw.mctl.ai');
    expect(finalLocation).toBe('https://ovk-openclaw.mctl.ai/');
  });

  it('refuses a canonical host that another existing tenant could own', async () => {
    // tenant "a" + service "b-c" and tenant "a-b" + service "c" share a-b-c.mctl.ai
    const portal = await portalSession();
    const url = '/forward-auth/authorize?tenant=a&service=b-c&host=a-b-c.mctl.ai&state=0123456789abcdef';
    TENANTS.add('a-b');
    expect((await get(url, { Cookie: `${OIDC_SESSION_COOKIE}=${portal}` })).status).toBe(400);
    TENANTS.delete('a-b');
    expect((await get(url, { Cookie: `${OIDC_SESSION_COOKIE}=${portal}` })).status).toBe(302);
  });

  it('treats a configured alias as belonging only to its own pair', async () => {
    // claude-remote.mctl.ai is also the canonical join of tenant "claude" + service "remote".
    const portal = await portalSession();
    const res = await get(
      '/forward-auth/authorize?tenant=claude&service=remote&host=claude-remote.mctl.ai&state=0123456789abcdef',
      { Cookie: `${OIDC_SESSION_COOKIE}=${portal}` },
    );
    expect(res.status).toBe(400);
    expect((await forwardAuth('claude', 'remote', 'claude-remote.mctl.ai')).status).toBe(403);
    expect((await forwardAuth('labs', 'claude-remote', 'claude-remote.mctl.ai')).status).toBe(302);
  });
});

describe('parseHostname', () => {
  it('accepts a plain hostname, lowercased', () => {
    expect(parseHostname('Ovk-Openclaw.mctl.ai')).toBe('ovk-openclaw.mctl.ai');
  });

  it.each([
    '', 'a.mctl.ai/', 'a.mctl.ai:443', 'u@a.mctl.ai', 'a.mctl.ai#x', 'a.mctl.ai?x', 'a.mctl.ai\\x',
    'a%2emctl.ai', 'a.mctl.ai.', 'a b.mctl.ai',
  ])('rejects %j', value => {
    expect(parseHostname(value)).toBeNull();
  });
});

describe('validateForwardAuthHosts', () => {
  const ok = { tenant: 'admins', service: 'temporal-web', host: 'temporal.mctl.ai' };

  it('accepts a well-formed list', () => {
    expect(validateForwardAuthHosts([ok], ISSUER)).toEqual([ok]);
  });

  it.each([
    ['a duplicate host', [ok, { ...ok, tenant: 'ovk' }]],
    ['a host with a path', [{ ...ok, host: 'temporal.mctl.ai/x' }]],
    ['a host outside the base domain', [{ ...ok, host: 'temporal.evil.example' }]],
    ['the portal host', [{ ...ok, host: 'app.mctl.ai' }]],
    ['an upper-case host', [{ ...ok, host: 'Temporal.mctl.ai' }]],
    ['a non-label service', [{ ...ok, service: 'x.evil' }]],
    ['a non-label tenant', [{ ...ok, tenant: 'a/b' }]],
  ])('refuses %s', (_name, hosts) => {
    expect(() => validateForwardAuthHosts(hosts as any, ISSUER)).toThrow();
  });
});

describe('forward-auth sign-in is started only by navigations', () => {
  it.each([
    [{ 'Sec-Fetch-Mode': 'cors' }],
    [{ 'Sec-Fetch-Mode': 'no-cors' }],
    [{ 'Sec-Fetch-Mode': 'websocket' }],
    [{ 'Sec-Fetch-Mode': '', Accept: 'application/json' }],
    [{ 'Sec-Fetch-Mode': '', Accept: '*/*' }],
  ])('answers %j with 401 and no cookie', async headers => {
    const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { headers });
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('treats a request without Sec-Fetch-Mode that accepts HTML as a navigation', async () => {
    const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', {
      headers: { 'Sec-Fetch-Mode': '', Accept: 'text/html,application/xhtml+xml' },
    });
    expect(res.status).toBe(302);
  });

  it('keeps an existing state cookie instead of overwriting it', async () => {
    const state = '11111111-2222-3333-4444-555555555555';
    const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', {
      cookie: `${FORWARD_AUTH_STATE_COOKIE}=${state}`,
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('state')).toBe(state);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('lets two tabs that started sign-in in parallel both complete', async () => {
    const first = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { uri: '/one' });
    const state = cookieValue(first, FORWARD_AUTH_STATE_COOKIE)!;
    const jar = `${FORWARD_AUTH_STATE_COOKIE}=${state}`;
    const second = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { uri: '/two', cookie: jar });
    const portal = await portalSession();
    for (const start of [second, first]) {
      const issued = await get(`/forward-auth/authorize${new URL(start.headers.get('location')!).search}`, {
        Cookie: `${OIDC_SESSION_COOKIE}=${portal}`,
      });
      const callback = new URL(issued.headers.get('location')!);
      const done = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', {
        uri: `${callback.pathname}${callback.search}`,
        cookie: jar,
      });
      expect(done.status).toBe(302);
      // A browser would apply any change to the state cookie before the next tab's callback.
      const stateUpdate = done.headers.getSetCookie().find(c => c.startsWith(`${FORWARD_AUTH_STATE_COOKIE}=`));
      expect(stateUpdate).toBeUndefined();
    }
  });

  it.each(['short', 'not/a/state', 'x'.repeat(200)])(
    'replaces a malformed state cookie %j instead of reusing it',
    async bad => {
      const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', {
        cookie: `${FORWARD_AUTH_STATE_COOKIE}=${bad}`,
      });
      expect(res.status).toBe(302);
      const state = new URL(res.headers.get('location')!).searchParams.get('state');
      expect(state).not.toBe(bad);
      expect(cookieValue(res, FORWARD_AUTH_STATE_COOKIE)).toBe(state);
    },
  );
});

describe('cookie-authenticated code minting needs a top-level navigation', () => {
  it.each(['cors', 'no-cors', 'same-origin'])('/forward-auth/authorize refuses Sec-Fetch-Mode %s', async mode => {
    const portal = await portalSession();
    const res = await get(
      '/forward-auth/authorize?tenant=ovk&service=openclaw&host=ovk-openclaw.mctl.ai&state=0123456789abcdef',
      { Cookie: `${OIDC_SESSION_COOKIE}=${portal}`, 'Sec-Fetch-Mode': mode },
    );
    expect(res.status).toBe(403);
    expect(await knex('oidc_forward_auth_codes').count({ n: '*' })).toEqual([{ n: 0 }]);
  });

  it.each(['cors', 'no-cors'])('Dex /authorize refuses Sec-Fetch-Mode %s', async mode => {
    const portal = await portalSession();
    const res = await get(DEX_AUTHORIZE, { Cookie: `${OIDC_SESSION_COOKIE}=${portal}`, 'Sec-Fetch-Mode': mode });
    expect(res.status).toBe(403);
    expect(await knex('oidc_codes').count({ n: '*' })).toEqual([{ n: 0 }]);
  });
});

describe('forward-auth binding and lifetime', () => {
  async function issueCode(tenant: string, service: string, host: string) {
    const start = await forwardAuth(tenant, service, host);
    const state = cookieValue(start, FORWARD_AUTH_STATE_COOKIE)!;
    const issued = await get(`/forward-auth/authorize${new URL(start.headers.get('location')!).search}`, {
      Cookie: `${OIDC_SESSION_COOKIE}=${await portalSession()}`,
    });
    const callback = new URL(issued.headers.get('location')!);
    return { state, code: callback.searchParams.get('code')! };
  }

  const callbackUri = (code: string, state: string) =>
    `${FORWARD_AUTH_CALLBACK_PATH}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

  it('rejects a code presented with a different state, even with a matching cookie', async () => {
    const { code } = await issueCode('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    const other = '99999999-9999-9999-9999-999999999999';
    const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', {
      uri: callbackUri(code, other),
      cookie: `${FORWARD_AUTH_STATE_COOKIE}=${other}`,
    });
    expect(res.status).toBe(400);
    expect(cookieValue(res, FORWARD_AUTH_SESSION_COOKIE)).toBeUndefined();
  });

  it('rejects a code for an alias redeemed on the canonical host of the same pair', async () => {
    const { code, state } = await issueCode('admins', 'temporal-web', 'temporal.mctl.ai');
    const res = await forwardAuth('admins', 'temporal-web', 'admins-temporal-web.mctl.ai', {
      uri: callbackUri(code, state),
      cookie: `${FORWARD_AUTH_STATE_COOKIE}=${state}`,
    });
    expect(res.status).toBe(400);
    expect(cookieValue(res, FORWARD_AUTH_SESSION_COOKIE)).toBeUndefined();
  });

  it('rejects a code redeemed under another tenant and service on the same hostname', async () => {
    // tenant "a" + service "b-c" and tenant "a-b" + service "c" share a-b-c.mctl.ai
    const { code, state } = await issueCode('a', 'b-c', 'a-b-c.mctl.ai');
    const res = await forwardAuth('a-b', 'c', 'a-b-c.mctl.ai', {
      uri: callbackUri(code, state),
      cookie: `${FORWARD_AUTH_STATE_COOKIE}=${state}`,
    });
    expect(res.status).toBe(400);
    expect(cookieValue(res, FORWARD_AUTH_SESSION_COOKIE)).toBeUndefined();
  });

  it('redeems a code exactly once under concurrent callbacks', async () => {
    const { code, state } = await issueCode('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    const opts = { uri: callbackUri(code, state), cookie: `${FORWARD_AUTH_STATE_COOKIE}=${state}` };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', opts)),
    );
    expect(results.map(r => r.status).sort()).toEqual([302, 400, 400, 400, 400]);
    expect(await knex('oidc_forward_auth_sessions').count({ n: '*' })).toEqual([{ n: 1 }]);
  });

  // Rows written directly, so each check is the only thing that differs.
  async function hostSession(overrides: Record<string, unknown>): Promise<string> {
    const portal = await portalSession();
    const id = `host-${Math.random().toString(36).slice(2)}`;
    await knex('oidc_forward_auth_sessions').insert({
      session_id: id,
      user_id: 'mashkovd',
      portal_session_id: portal,
      tenant: 'ovk',
      service: 'openclaw',
      host: 'ovk-openclaw.mctl.ai',
      expires_at: Date.now() + 60_000,
      ...overrides,
    });
    return `${FORWARD_AUTH_SESSION_COOKIE}=${id}`;
  }

  it('accepts a matching session row (control)', async () => {
    const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { cookie: await hostSession({}) });
    expect(res.status).toBe(200);
  });

  it.each([
    ['tenant', { tenant: 'labs' }],
    ['service', { service: 'other' }],
    ['host', { host: 'other-openclaw.mctl.ai' }],
    ['expiry', { expires_at: Date.now() - 1 }],
    ['user (portal session belongs to someone else)', { user_id: 'someone-else' }],
    ['portal session (deleted)', { portal_session_id: 'gone' }],
  ])('rejects a session row whose %s does not match', async (_name, overrides) => {
    const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', {
      cookie: await hostSession(overrides),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('x-forwarded-user')).toBeNull();
  });

  it('re-checks tenant membership on every request', async () => {
    const { sessionCookie } = await signInToHost('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    expect((await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { cookie: sessionCookie })).status).toBe(200);
    delete ROLES['mashkovd/ovk'];
    const res = await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { cookie: sessionCookie });
    expect(res.status).toBe(403);
    expect(res.headers.get('x-forwarded-user')).toBeNull();
  });

  it('expires a host session at its expiry time', async () => {
    const { sessionCookie } = await signInToHost('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    await knex('oidc_forward_auth_sessions').update({ expires_at: Date.now() - 1 });
    expect((await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { cookie: sessionCookie })).status).toBe(302);
  });

  it('revokes host sessions when their portal session is deleted', async () => {
    const { sessionCookie, portal } = await signInToHost('ovk', 'openclaw', 'ovk-openclaw.mctl.ai');
    expect((await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { cookie: sessionCookie })).status).toBe(200);
    await knex('oidc_sessions').where({ session_id: portal }).delete();
    expect((await forwardAuth('ovk', 'openclaw', 'ovk-openclaw.mctl.ai', { cookie: sessionCookie })).status).toBe(302);
  });
});
