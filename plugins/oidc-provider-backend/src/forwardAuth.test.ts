import express from 'express';
import { AddressInfo } from 'net';
import { Server } from 'http';
import knexLib, { Knex } from 'knex';
import { KeyStore } from './keyStore';
import { OidcStore } from './oidcStore';
import {
  buildHostOnlyCookie,
  createRouter,
  FORWARD_AUTH_CALLBACK_PATH,
  FORWARD_AUTH_SESSION_COOKIE,
  FORWARD_AUTH_STATE_COOKIE,
  sanitizeReturnPath,
} from './router';
import { OIDC_SESSION_COOKIE } from './sessionAuth';

// End-to-end tests of the browser session cookies over real HTTP: the portal
// session must stay on the portal host, and a forward-auth protected host
// must only ever accept its own host-bound session.

const ISSUER = 'https://app.mctl.ai/api/oidc-provider';
const ROLES: Record<string, string> = {
  'mashkovd/admins': 'owner',
  'mashkovd/ovk': 'member',
};

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
    },
    keyStore: {} as KeyStore,
    issuer: ISSUER,
    clients: [],
    githubClientId: 'gh-client',
    githubClientSecret: 'gh-secret',
    store,
    forwardAuthHosts: [{ tenant: 'admins', service: 'temporal-web', host: 'temporal.mctl.ai' }],
  });
  const app = express();
  app.use('/api/oidc-provider', router);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/oidc-provider`;
});

afterEach(async () => {
  global.fetch = realFetch;
  await new Promise(resolve => server.close(resolve));
  await knex.destroy();
});

function get(path: string, headers: Record<string, string> = {}): Promise<globalThis.Response> {
  return realFetch(`${base}${path}`, { headers, redirect: 'manual' });
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
  opts: { uri?: string; cookie?: string } = {},
): Promise<globalThis.Response> {
  const headers: Record<string, string> = {
    'X-Forwarded-Host': host,
    'X-Forwarded-Uri': opts.uri ?? '/',
    'X-Forwarded-Proto': 'https',
  };
  if (opts.cookie) headers.Cookie = opts.cookie;
  return get(`/forward-auth?tenant=${tenant}&service=${service}`, headers);
}

function cookieValue(res: globalThis.Response, name: string): string | undefined {
  const line = res.headers.getSetCookie().find(c => c.startsWith(`${name}=`));
  return line?.split(';')[0].slice(name.length + 1);
}

// Runs the whole redirect flow for one protected host and returns the
// host session cookie value it ends with.
async function signInToHost(tenant: string, service: string, host: string, uri = '/'): Promise<{
  sessionCookie: string;
  finalLocation: string;
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

describe('portal session cookie', () => {
  it('is host-only after GitHub sign-in even when returnTo is a tenant host', async () => {
    const login = await get(`/login?returnTo=${encodeURIComponent('https://ovk-openclaw.mctl.ai/')}`);
    const state = new URL(login.headers.get('location')!).searchParams.get('state')!;

    global.fetch = jest.fn(async (input: any) => {
      const url = String(input);
      if (url.startsWith('https://github.com/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gh-token' }));
      }
      if (url.startsWith('https://api.github.com/user')) {
        return new Response(JSON.stringify({ login: 'mashkovd' }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any;

    const callback = await get(`/github/callback?code=gh-code&state=${state}`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('https://ovk-openclaw.mctl.ai/');
    const cookies = callback.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    expect(cookies[0].startsWith(`${OIDC_SESSION_COOKIE}=`)).toBe(true);
    expectHostOnly(cookies[0]);
  });

  it('is not re-issued by /login for a tenant returnTo', async () => {
    const portal = await portalSession();
    const res = await get(`/login?returnTo=${encodeURIComponent('https://ovk-openclaw.mctl.ai/')}`, {
      Cookie: `${OIDC_SESSION_COOKIE}=${portal}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('is not re-issued by /tenant-login', async () => {
    const portal = await portalSession();
    const res = await get('/tenant-login?tenant=ovk&service=openclaw', {
      Cookie: `${OIDC_SESSION_COOKIE}=${portal}`,
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://ovk-openclaw.mctl.ai/');
    expect(res.headers.getSetCookie()).toEqual([]);
  });

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

  it('sets the host session cookie host-only and clears the state cookie', async () => {
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
    expect(cookies).toHaveLength(2);
    cookies.forEach(expectHostOnly);
    expect(cookies.find(c => c.startsWith(`${FORWARD_AUTH_STATE_COOKIE}=;`))).toContain('Max-Age=0');
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
