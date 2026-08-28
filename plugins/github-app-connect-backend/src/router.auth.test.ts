import type { Knex } from 'knex';
import type { Router } from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';
import { auditAdminBypass, checkTeamAccess, createRouter, RouterOptions } from './router';

jest.mock('node-fetch', () => jest.fn());

const fetchMock = fetch as unknown as jest.Mock;

// findInstallation/getInstallationToken sign a real JWT with this key (RS256),
// so it must be an actual RSA private key, not an arbitrary string, for any
// "member/admin reaches the route's business logic" test to get past that
// signing step instead of throwing.
const { privateKey: TEST_PRIVATE_KEY } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

// Generic stand-ins for the GitHub REST endpoints the router hits after the
// auth gate passes. Keeps the auth-focused tests below from making real
// network calls while still letting a "member"/"admin" request reach a 200.
function githubFetchStub(url: string): { ok: boolean; status: number; json: () => Promise<any>; text?: () => Promise<string> } {
  if (/\/installation$/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ id: 555, account: { type: 'User' } }) };
  }
  if (/\/access_tokens$/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ token: 'test-token' }) };
  }
  if (/\/tags\?/.test(url)) {
    return { ok: true, status: 200, json: async () => [{ name: 'v1.2.3' }] };
  }
  if (/\/installation\/repositories/.test(url)) {
    return { ok: true, status: 200, json: async () => ({ repositories: [] }) };
  }
  if (/\/contents\//.test(url)) {
    return { ok: true, status: 200, json: async () => ({}), text: async () => 'env:\n  FOO: "bar"\n' };
  }
  if (/^https:\/\/api\.github\.com\/repos\//.test(url)) {
    return { ok: true, status: 200, json: async () => ({ private: false }) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
}

// Mirrors vault-secrets-backend/src/router.test.ts's fakeDb: emulates the
// query shape getTenantMember/isAdminUser issue against tenant_members
// (db('tenant_members')[.withSchema(...)].where({tenant_name,user_id}).first()).
function fakeDb(memberships: Record<string, { role: string }>): Knex {
  const db = jest.fn((_table: string) => {
    const builder: any = {
      withSchema: jest.fn().mockReturnThis(),
      where(cond: { tenant_name: string; user_id: string }) {
        builder._cond = cond;
        return builder;
      },
      async first() {
        const key = `${builder._cond.tenant_name}:${builder._cond.user_id}`;
        const role = memberships[key]?.role;
        return role
          ? { tenant_name: builder._cond.tenant_name, user_id: builder._cond.user_id, role }
          : undefined;
      },
    };
    return builder;
  });
  return db as unknown as Knex;
}

// Test double for HttpAuthService.credentials: resolves an identity from the
// `x-test-user` header, or rejects (mirroring an anonymous/invalid request)
// when the header is absent.
function fakeHttpAuth() {
  return {
    async credentials(req: any) {
      const userId = req.headers['x-test-user'];
      if (!userId) {
        throw new Error('no credentials on request');
      }
      return { principal: { type: 'user', userEntityRef: `user:default/${userId}` } };
    },
  } as any;
}

function fakeUserInfo() {
  return {
    async getUserInfo(credentials: any) {
      return { ownershipEntityRefs: [credentials.principal.userEntityRef] };
    },
  } as any;
}

function fakeStore(overrides: Record<string, jest.Mock> = {}) {
  return {
    findInstallationsByTeam: jest.fn().mockResolvedValue([]),
    findAllInstallations: jest.fn().mockResolvedValue([]),
    find: jest.fn().mockResolvedValue(undefined),
    findByRepo: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue(undefined),
    deleteByTeam: jest.fn().mockResolvedValue(0),
    ...overrides,
  } as any;
}

function fakeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;
}

function buildRouter(
  memberships: Record<string, { role: string }>,
  storeOverrides: Record<string, jest.Mock> = {},
  extra: Partial<RouterOptions> = {},
) {
  const logger = fakeLogger();
  const store = fakeStore(storeOverrides);
  const router = createRouter({
    logger,
    store,
    appSlug: 'test-app',
    appId: '1',
    privateKey: TEST_PRIVATE_KEY,
    baseUrl: 'https://portal.example.com',
    httpAuth: fakeHttpAuth(),
    userInfo: fakeUserInfo(),
    db: fakeDb(memberships),
    isPostgres: false,
    ...extra,
  });
  return { router, logger, store };
}

// Drives a request through the plain Express Router the same way
// httpRouter.use(router) would, without spinning up a real HTTP server or
// pulling in supertest (not a dependency of this package).
function dispatch(
  router: Router,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const [pathname, queryString] = path.split('?');
  const query: Record<string, string> = {};
  if (queryString) {
    for (const [k, v] of new URLSearchParams(queryString)) {
      query[k] = v;
    }
  }
  const req: any = {
    method,
    url: path,
    path: pathname,
    query,
    headers,
    params: {},
  };
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    const res: any = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(body: any) {
        resolve({ status: statusCode, body });
        return res;
      },
      send(body: any) {
        resolve({ status: statusCode, body });
        return res;
      },
      setHeader() {
        return res;
      },
      redirect(url: string) {
        resolve({ status: statusCode || 302, body: { redirect: url } });
        return res;
      },
    };
    router(req, res, (err?: any) => {
      if (err) reject(err);
      else reject(new Error(`unhandled: no route matched ${method} ${path}`));
    });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => githubFetchStub(url));
});

// checkTeamAccess is the local, independently-implemented equivalent of
// vault-secrets-backend's checkTenantRole (per the operator decision in
// tasks.md: compose getTenantMember/isAdminUser directly, do not import
// vault-secrets-backend's helper). Mirrors that file's admin-bypass suite.
describe('checkTeamAccess', () => {
  it('grants an admins-tenant owner access to a team they are not a member of', async () => {
    const db = fakeDb({ 'admins:alice': { role: 'owner' } });
    const result = await checkTeamAccess(db, false, 'nfc', 'alice');
    expect(result).toEqual({ ok: true, userId: 'alice', role: 'owner', viaAdminBypass: true });
  });

  it('marks a genuine team member as not having used the bypass', async () => {
    const db = fakeDb({ 'nfc:carol': { role: 'viewer' } });
    const result = await checkTeamAccess(db, false, 'nfc', 'carol');
    expect(result).toEqual({ ok: true, userId: 'carol', role: 'viewer', viaAdminBypass: false });
  });

  it('denies a non-admin who is not a member of the team', async () => {
    const db = fakeDb({});
    const result = await checkTeamAccess(db, false, 'nfc', 'bob');
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Access denied: not a member of team 'nfc'",
    });
  });
});

describe('auditAdminBypass', () => {
  it('logs when the admin-bypass path was used', () => {
    const logger = fakeLogger();
    auditAdminBypass(logger, '/repos', 'nfc', { userId: 'alice', viaAdminBypass: true }, 'quirestack-api');
    expect(logger.info).toHaveBeenCalledWith(
      'github-app-connect admin bypass',
      expect.objectContaining({
        audit: 'admin_bypass',
        route: '/repos',
        team: 'nfc',
        service: 'quirestack-api',
        user: 'alice',
        via_admin_bypass: true,
      }),
    );
  });

  it('stays silent for a genuine member read (not a bypass)', () => {
    const logger = fakeLogger();
    auditAdminBypass(logger, '/repos', 'nfc', { userId: 'carol', viaAdminBypass: false });
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('GET /repos', () => {
  it('returns 401 with no credentials', async () => {
    const { router } = buildRouter({});
    const { status, body } = await dispatch(router, 'GET', '/repos?team=nfc');
    expect(status).toBe(401);
    expect(body).toEqual({ error: 'Authentication required' });
  });

  it('returns 403 for an authenticated non-member', async () => {
    const { router } = buildRouter({});
    const { status } = await dispatch(router, 'GET', '/repos?team=nfc', { 'x-test-user': 'bob' });
    expect(status).toBe(403);
  });

  it('returns 200 with the existing response shape for a genuine team member', async () => {
    const { router, store } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const { status, body } = await dispatch(router, 'GET', '/repos?team=nfc', { 'x-test-user': 'carol' });
    expect(status).toBe(200);
    expect(body).toEqual({ repos: [] });
    expect(store.findInstallationsByTeam).toHaveBeenCalledWith('nfc');
  });

  it('lets an admins-tenant owner bypass membership and audits the read', async () => {
    const { router, logger } = buildRouter({ 'admins:alice': { role: 'owner' } });
    const { status } = await dispatch(router, 'GET', '/repos?team=nfc', { 'x-test-user': 'alice' });
    expect(status).toBe(200);
    expect(logger.info).toHaveBeenCalledWith(
      'github-app-connect admin bypass',
      expect.objectContaining({ route: '/repos', team: 'nfc', user: 'alice', via_admin_bypass: true }),
    );
  });

  it('400s a non-admin who omits team (drops the old all-installations fallback)', async () => {
    const { router } = buildRouter({});
    const { status, body } = await dispatch(router, 'GET', '/repos', { 'x-test-user': 'bob' });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Missing required param: team' });
  });

  it('preserves the all-installations fallback for a platform admin without team', async () => {
    const { router, store } = buildRouter({ 'admins:alice': { role: 'owner' } });
    const { status } = await dispatch(router, 'GET', '/repos', { 'x-test-user': 'alice' });
    expect(status).toBe(200);
    expect(store.findAllInstallations).toHaveBeenCalled();
  });
});

describe('POST /repos/sync', () => {
  it('returns 401 with no credentials', async () => {
    const { router } = buildRouter({});
    const { status } = await dispatch(router, 'POST', '/repos/sync?team=nfc&user=carol');
    expect(status).toBe(401);
  });

  it('returns 403 for an authenticated non-member', async () => {
    const { router } = buildRouter({});
    const { status } = await dispatch(router, 'POST', '/repos/sync?team=nfc&user=carol', {
      'x-test-user': 'bob',
    });
    expect(status).toBe(403);
  });

  it('returns 200 for a genuine team member', async () => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const { status, body } = await dispatch(router, 'POST', '/repos/sync?team=nfc&user=carol', {
      'x-test-user': 'carol',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ repos: [] });
  });
});

describe('GET /repo-tags', () => {
  it('returns 401 with no credentials', async () => {
    const { router } = buildRouter({});
    const { status } = await dispatch(router, 'GET', '/repo-tags?repo=mctlhq/mctl-web');
    expect(status).toBe(401);
  });

  it('serves any authenticated user regardless of team membership (no team param exists)', async () => {
    const { router } = buildRouter({});
    const { status, body } = await dispatch(router, 'GET', '/repo-tags?repo=mctlhq/mctl-web', {
      'x-test-user': 'someone-with-no-tenant-membership',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ tags: ['v1.2.3'] });
  });
});

describe('GET /install-status', () => {
  it('returns 401 with no credentials', async () => {
    const { router } = buildRouter({});
    const { status } = await dispatch(
      router,
      'GET',
      '/install-status?team=nfc&service=api&repo=mctlhq/api',
    );
    expect(status).toBe(401);
  });

  it('returns 403 for an authenticated non-member', async () => {
    const { router } = buildRouter({});
    const { status } = await dispatch(
      router,
      'GET',
      '/install-status?team=nfc&service=api&repo=mctlhq/api',
      { 'x-test-user': 'bob' },
    );
    expect(status).toBe(403);
  });

  it('returns 200 pending for a genuine team member', async () => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const { status, body } = await dispatch(
      router,
      'GET',
      '/install-status?team=nfc&service=api&repo=mctlhq/api',
      { 'x-test-user': 'carol' },
    );
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'pending' });
  });
});

describe('GET /repo-access, /install-url, /service-config', () => {
  it('all return 401 with no credentials', async () => {
    const { router } = buildRouter({});
    const cases = [
      '/repo-access?team=nfc&service=api&repo=mctlhq/api',
      '/install-url?team=nfc&service=api&repo=mctlhq/api',
      '/service-config?team=nfc&service=api',
    ];
    for (const path of cases) {
      const { status } = await dispatch(router, 'GET', path);
      expect(status).toBe(401);
    }
  });

  it('all return 403 for an authenticated non-member', async () => {
    const { router } = buildRouter({});
    const cases = [
      '/repo-access?team=nfc&service=api&repo=mctlhq/api',
      '/install-url?team=nfc&service=api&repo=mctlhq/api',
      '/service-config?team=nfc&service=api',
    ];
    for (const path of cases) {
      const { status } = await dispatch(router, 'GET', path, { 'x-test-user': 'bob' });
      expect(status).toBe(403);
    }
  });

  it('all return 200 for a genuine team member', async () => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const cases = [
      '/repo-access?team=nfc&service=api&repo=mctlhq/api',
      '/install-url?team=nfc&service=api&repo=mctlhq/api',
      '/service-config?team=nfc&service=api',
    ];
    for (const path of cases) {
      const { status } = await dispatch(router, 'GET', path, { 'x-test-user': 'carol' });
      expect(status).toBe(200);
    }
  });
});

// Regression: /callback, /popup-done, /webhook must stay reachable with zero
// Backstage credentials — they are gated solely by their own crypto checks
// (state-token decrypt / X-Hub-Signature-256 HMAC), unchanged by this
// proposal. See registerAuthPolicies in plugin.test.ts for the policy-level
// assertion that only these three remain unauthenticated.
describe('unaffected routes stay reachable without Backstage credentials', () => {
  it('/popup-done serves the static confirmation page', async () => {
    const { router } = buildRouter({});
    const { status } = await dispatch(router, 'GET', '/popup-done');
    expect(status).toBe(200);
  });

  it('/callback rejects a missing installation_id with its own 400, not an auth error', async () => {
    const { router } = buildRouter({});
    const { status, body } = await dispatch(router, 'GET', '/callback');
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'Missing installation_id' });
  });

  // /webhook itself is not exercised here: it is registered with
  // express.raw({type: 'application/json'}) ahead of the handler, which
  // needs a real readable stream (req.on('data'/'end')) that this
  // lightweight dispatch harness does not implement. Its HMAC gate is
  // unchanged by this proposal and remains listed unauthenticated by
  // registerAuthPolicies (see plugin.test.ts).
});
