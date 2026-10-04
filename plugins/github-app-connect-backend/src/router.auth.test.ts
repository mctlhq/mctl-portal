import type { Knex } from 'knex';
import type { Router } from 'express';
import crypto from 'crypto';
import express from 'express';
import { AddressInfo } from 'net';
import { auditAdminBypass, checkTeamAccess, createRouter, encryptState, RouterOptions } from './router';

jest.mock('./bindingLookup', () => ({ isRepoBoundToTeam: jest.fn() }));
// eslint-disable-next-line import/first
import { isRepoBoundToTeam } from './bindingLookup';

let fetchMock: jest.SpyInstance;

beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchMock.mockRestore();
});

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
    async credentials(req: any, opts?: { allow?: string[] }) {
      const service = req.headers['x-test-service'];
      if (service) {
        if (opts?.allow && !opts.allow.includes('service')) throw new Error('service not allowed');
        return { principal: { type: 'service', subject: service } };
      }
      const userId = req.headers['x-test-user'];
      if (!userId) {
        throw new Error('no credentials on request');
      }
      if (opts?.allow && !opts.allow.includes('user')) throw new Error('user not allowed');
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
    findByTeamAndRepo: jest.fn().mockResolvedValue(undefined),
    findVerifiedInstallationsByTeam: jest.fn().mockResolvedValue([]),
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

  // Regression tests for the round-1 review fixes (commit 26a9a74):
  // identity binding and login-shape validation on the `user` param.
  it('returns 403 when a member passes someone else\'s user param (identity mismatch)', async () => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' }, 'nfc:mallory': { role: 'viewer' } });
    const { status } = await dispatch(router, 'POST', '/repos/sync?team=nfc&user=carol', {
      'x-test-user': 'mallory',
    });
    expect(status).toBe(403);
  });

  it('returns 400 for a user param that is not a GitHub login shape (org-path injection)', async () => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const { status } = await dispatch(
      router,
      'POST',
      `/repos/sync?team=nfc&user=${encodeURIComponent('../orgs/victim-org')}`,
      { 'x-test-user': 'carol' },
    );
    expect(status).toBe(400);
  });
});

describe('GET /repo-tags', () => {
  const connected = { installation_id: 777, team_id: 'nfc', repo_full_name: 'acme/private-api' };

  it('returns 401 with no credentials', async () => {
    const { router } = buildRouter({});
    const { status } = await dispatch(router, 'GET', '/repo-tags?team=nfc&repo=mctlhq/mctl-web');
    expect(status).toBe(401);
  });

  it('returns 403 for an authenticated non-member of the team', async () => {
    const { router } = buildRouter({});
    const { status } = await dispatch(router, 'GET', '/repo-tags?team=nfc&repo=mctlhq/mctl-web', {
      'x-test-user': 'someone-with-no-tenant-membership',
    });
    expect(status).toBe(403);
  });

  it('returns 400 without a team', async () => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const { status } = await dispatch(router, 'GET', '/repo-tags?repo=mctlhq/mctl-web', {
      'x-test-user': 'carol',
    });
    expect(status).toBe(400);
  });

  it("reads a repo connected to the caller's team with that connection's installation", async () => {
    const { router } = buildRouter(
      { 'nfc:carol': { role: 'viewer' } },
      { findByTeamAndRepo: jest.fn().mockResolvedValue(connected) },
    );
    const { status, body } = await dispatch(router, 'GET', '/repo-tags?team=nfc&repo=acme/private-api', {
      'x-test-user': 'carol',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ tags: ['v1.2.3'] });
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls).toContain('https://api.github.com/app/installations/777/access_tokens');
  });

  it('refuses a private repo not connected to the team and never mints an App token', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      /\/repos\/acme\/private-api$/.test(url)
        ? { ok: true, status: 200, json: async () => ({ private: true }) }
        : githubFetchStub(url),
    );
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const { status } = await dispatch(router, 'GET', '/repo-tags?team=nfc&repo=acme/private-api', {
      'x-test-user': 'carol',
    });
    expect(status).toBe(404);
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(u => /\/access_tokens$/.test(u) || /\/app\/installations/.test(u))).toBe(false);
  });

  it('reads a public repo not connected to the team without App credentials', async () => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const { status, body } = await dispatch(router, 'GET', '/repo-tags?team=nfc&repo=mctlhq/mctl-web', {
      'x-test-user': 'carol',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ tags: ['v1.2.3'] });
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(u => /\/access_tokens$/.test(u))).toBe(false);
  });

  it('lets a platform admin read through the repo owner\'s installation', async () => {
    const { router } = buildRouter({ 'admins:root': { role: 'owner' } });
    const { status } = await dispatch(router, 'GET', '/repo-tags?team=nfc&repo=acme/private-api', {
      'x-test-user': 'root',
    });
    expect(status).toBe(200);
    const calls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(calls).toContain('https://api.github.com/app/installations/555/access_tokens');
  });

  // Regression tests for REPO_FULL_NAME_RE: charset injection AND the
  // round-2 finding that dot-only segments (`..`) survive a plain charset
  // check and let WHATWG URL normalization shift the GitHub API path.
  it.each([
    '../foo',
    'foo/..',
    'foo/.',
    './foo',
    '../..',
    'mctlhq/mctl-gitops/actions/secrets?',
    'owner/repo?x=1',
    'owner',
  ])('returns 400 for malformed repo param %s', async repo => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const { status } = await dispatch(
      router,
      'GET',
      `/repo-tags?team=nfc&repo=${encodeURIComponent(repo)}`,
      { 'x-test-user': 'carol' },
    );
    expect(status).toBe(400);
  });

  it('still accepts a dotted but legitimate repo name', async () => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const { status } = await dispatch(router, 'GET', `/repo-tags?team=nfc&repo=${encodeURIComponent('mctlhq/a.b.c')}`, {
      'x-test-user': 'carol',
    });
    expect(status).toBe(200);
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

  // Regression for the round-1 path-traversal fix: TEAM_OR_SERVICE_RE must
  // reject values that would escape platform-gitops/services/<team>/<service>/
  // in the Contents API path (`service=../team-b/other-service` class).
  it.each([
    ['team', `/service-config?team=${encodeURIComponent('../team-b')}&service=api`],
    ['service', `/service-config?team=nfc&service=${encodeURIComponent('../team-b/other')}`],
    ['service dot', `/service-config?team=nfc&service=..`],
    ['service slash', `/service-config?team=nfc&service=${encodeURIComponent('a/b')}`],
  ])('returns 400 for a traversal-shaped %s param even for a member', async (_label, path) => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    const { status } = await dispatch(router, 'GET', path, { 'x-test-user': 'carol' });
    expect(status).toBe(400);
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

// ── Installation binding ────────────────────────────────────────────────────
// /callback is unauthenticated and installation ids are small integers, so a
// connection may only be recorded for a portal-minted state whose user is
// shown to control the installation. Each test below names the old behaviour
// it would have accepted.

const STATE_SECRET = crypto.createHash('sha256').update(TEST_PRIVATE_KEY).digest('hex');

type Account = { login: string; type: 'User' | 'Organization' };

// permissions: "<repo>" -> GitHub's permission string, or an HTTP status to answer with.
function bindingStub(options: {
  accounts: Record<number, Account>;
  repos?: string[];
  permissions?: Record<string, string | number>;
}) {
  return async (url: string) => {
    const inst = url.match(/\/app\/installations\/(\d+)$/);
    if (inst) {
      const account = options.accounts[Number(inst[1])];
      return account
        ? { ok: true, status: 200, json: async () => ({ id: Number(inst[1]), account }) }
        : { ok: false, status: 404, json: async () => ({}) };
    }
    if (/\/installation\/repositories/.test(url)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ repositories: (options.repos ?? []).map(full_name => ({ full_name })) }),
      };
    }
    const perm = url.match(/\/repos\/([^/]+\/[^/]+)\/collaborators\/carol\/permission$/);
    if (perm) {
      const answer = options.permissions?.[perm[1]] ?? 404;
      if (typeof answer === 'number') {
        return { ok: answer < 300, status: answer, json: async () => ({ message: 'x' }) };
      }
      return { ok: true, status: 200, json: async () => (answer === 'malformed' ? {} : { permission: answer }) };
    }
    return githubFetchStub(url);
  };
}

const ACCOUNTS: Record<number, Account> = {
  11: { login: 'carol', type: 'User' },
  22: { login: 'victim-org', type: 'Organization' },
  33: { login: 'mallory', type: 'User' },
};

function popupState(team: string, user: string) {
  return encodeURIComponent(encryptState({ popup: true, team, user, nonce: 'n' }, STATE_SECRET));
}

describe('GET /callback binding', () => {
  it('records nothing for a plain popup:<team> state (old code bound any installation to that team)', async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: ACCOUNTS, repos: ['victim-org/private'] }));
    const { router, store } = buildRouter({});
    const { body } = await dispatch(router, 'GET', '/callback?installation_id=22&state=popup:nfc');
    expect(body.redirect).toMatch(/popup-done$/);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('records nothing for a direct install without state (old code stored every repo)', async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: ACCOUNTS, repos: ['victim-org/private'] }));
    const { router, store } = buildRouter({});
    await dispatch(router, 'GET', '/callback?installation_id=22&setup_action=install');
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("binds the state user's own installation to the state's team", async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: ACCOUNTS, repos: ['carol/app'] }));
    const { router, store } = buildRouter({});
    const { body } = await dispatch(router, 'GET', `/callback?installation_id=11&state=${popupState('nfc', 'carol')}`);
    expect(body.redirect).toMatch(/popup-done$/);
    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ team_id: 'nfc', repo_full_name: 'carol/app', installation_id: 11, created_by: 'popup:carol' }),
    );
  });

  it("refuses another user's personal installation", async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: ACCOUNTS, repos: ['mallory/app'] }));
    const { router, store } = buildRouter({});
    await dispatch(router, 'GET', `/callback?installation_id=33&state=${popupState('nfc', 'carol')}`);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('refuses an organization installation whose repos the user cannot read', async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: ACCOUNTS, repos: ['victim-org/private'] }));
    const { router, store } = buildRouter({});
    await dispatch(router, 'GET', `/callback?installation_id=22&state=${popupState('nfc', 'carol')}`);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('refuses an install-url state replayed with a victim installation that can see the repo', async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: ACCOUNTS, repos: ['victim-org/private'] }));
    const { router, store } = buildRouter({});
    const state = encodeURIComponent(
      encryptState({ team: 'nfc', service: 'api', repo: 'victim-org/private', user: 'carol', nonce: 'n' }, STATE_SECRET),
    );
    const { body } = await dispatch(router, 'GET', `/callback?installation_id=22&state=${state}`);
    expect(body.redirect).toMatch(/status=error/);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('binds only the organization repos the user can read', async () => {
    fetchMock.mockImplementation(
      bindingStub({
        accounts: ACCOUNTS,
        repos: ['victim-org/shared', 'victim-org/secret'],
        permissions: { 'victim-org/shared': 'read', 'victim-org/secret': 'none' },
      }),
    );
    const { router, store } = buildRouter({});
    await dispatch(router, 'GET', `/callback?installation_id=22&state=${popupState('nfc', 'carol')}`);
    expect(store.upsert).toHaveBeenCalledTimes(1);
    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ team_id: 'nfc', repo_full_name: 'victim-org/shared', created_by: 'popup:carol' }),
    );
  });

  it.each([
    ['the App may not read permissions (403)', 403],
    ['GitHub errors (502)', 502],
    ['the answer is malformed', 'malformed'],
  ])('refuses the whole binding when %s', async (_label, answer) => {
    fetchMock.mockImplementation(
      bindingStub({
        accounts: ACCOUNTS,
        repos: ['victim-org/shared', 'victim-org/other'],
        permissions: { 'victim-org/shared': 'write', 'victim-org/other': answer },
      }),
    );
    const { router, store } = buildRouter({});
    await dispatch(router, 'GET', `/callback?installation_id=22&state=${popupState('nfc', 'carol')}`);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('refuses when the installation cannot be looked up', async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: {}, repos: ['carol/app'] }));
    const { router, store } = buildRouter({});
    await dispatch(router, 'GET', `/callback?installation_id=11&state=${popupState('nfc', 'carol')}`);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('rejects a state that does not decrypt', async () => {
    const { router, store } = buildRouter({});
    const { status } = await dispatch(router, 'GET', '/callback?installation_id=11&state=deadbeef:00');
    expect(status).toBe(400);
    expect(store.upsert).not.toHaveBeenCalled();
  });
});

describe('GET /popup-state', () => {
  it('returns 401 with no credentials and 403 for a non-member', async () => {
    const { router } = buildRouter({});
    expect((await dispatch(router, 'GET', '/popup-state?team=nfc')).status).toBe(401);
    expect((await dispatch(router, 'GET', '/popup-state?team=nfc', { 'x-test-user': 'bob' })).status).toBe(403);
  });

  it('mints a state bound to the team and the calling user', async () => {
    const { router } = buildRouter({ 'nfc:carol': { role: 'developer' } });
    const { status, body } = await dispatch(router, 'GET', '/popup-state?team=nfc', { 'x-test-user': 'carol' });
    expect(status).toBe(200);
    const { decryptState } = jest.requireActual('./router');
    expect(decryptState(body.state, STATE_SECRET)).toMatchObject({ popup: true, team: 'nfc', user: 'carol' });
    expect(body.url).toContain(encodeURIComponent(body.state));
  });
});

describe('GET /repo-access without cross-team fallbacks', () => {
  it("does not report another team's connection for the same repo (old code returned it)", async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: ACCOUNTS, repos: ['victim-org/private'] }));
    const { router } = buildRouter(
      { 'nfc:carol': { role: 'viewer' } },
      {
        findByRepo: jest.fn().mockResolvedValue([
          { team_id: 'karabu', service_id: '_auto', repo_full_name: 'victim-org/private', installation_id: 22 },
        ]),
      },
    );
    const { body } = await dispatch(router, 'GET', '/repo-access?team=nfc&service=api&repo=victim-org/private', {
      'x-test-user': 'carol',
    });
    expect(body.status).not.toBe('connected');
  });

  it("does not bind a repo through its owner's installation (old code auto-saved it)", async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: ACCOUNTS, repos: ['mctlhq/api'] }));
    const { router, store } = buildRouter({ 'nfc:carol': { role: 'viewer' } });
    await dispatch(router, 'GET', '/repo-access?team=nfc&service=api&repo=mctlhq/api', { 'x-test-user': 'carol' });
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it("reports the team's own connection", async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: ACCOUNTS, repos: ['carol/app'] }));
    const { router } = buildRouter(
      { 'nfc:carol': { role: 'viewer' } },
      {
        findByTeamAndRepo: jest.fn().mockResolvedValue({
          team_id: 'nfc', service_id: '_auto', repo_full_name: 'carol/app', installation_id: 11,
        }),
      },
    );
    const { body } = await dispatch(router, 'GET', '/repo-access?team=nfc&service=api&repo=carol/app', {
      'x-test-user': 'carol',
    });
    expect(body).toEqual({ status: 'connected', method: 'github_app', installation_id: 11 });
  });
});

describe('POST /repos/sync carries over only verified bindings', () => {
  it('drops installations bound only by unverified rows', async () => {
    // carol has no personal installation; the only source would be an unverified row.
    const stub = bindingStub({ accounts: ACCOUNTS, repos: ['victim-org/private'] });
    fetchMock.mockImplementation(async (url: string) =>
      /\/(users|orgs)\/carol\/installation$/.test(url)
        ? { ok: false, status: 404, json: async () => ({}) }
        : stub(url),
    );
    const { router, store } = buildRouter(
      { 'nfc:carol': { role: 'developer' } },
      {
        findInstallationsByTeam: jest.fn().mockResolvedValue([22]),
        findVerifiedInstallationsByTeam: jest.fn().mockResolvedValue([]),
      },
    );
    const { body } = await dispatch(router, 'POST', '/repos/sync?team=nfc&user=carol', { 'x-test-user': 'carol' });
    expect(body.repos).not.toContain('victim-org/private');
    expect(store.upsert).not.toHaveBeenCalledWith(expect.objectContaining({ installation_id: 22 }));
  });

  it('keeps verified bindings and records the syncing user', async () => {
    fetchMock.mockImplementation(bindingStub({ accounts: ACCOUNTS, repos: ['victim-org/private'] }));
    const { router, store } = buildRouter(
      { 'nfc:carol': { role: 'developer' } },
      { findVerifiedInstallationsByTeam: jest.fn().mockResolvedValue([22]) },
    );
    const { body } = await dispatch(router, 'POST', '/repos/sync?team=nfc&user=carol', { 'x-test-user': 'carol' });
    expect(body.repos).toContain('victim-org/private');
    expect(store.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ installation_id: 22, created_by: 'sync:carol' }),
    );
  });
});

describe('POST /webhook signature check', () => {
  it('answers 401, not 500, for a signature of the wrong length', async () => {
    const { router } = buildRouter({}, {}, { webhookSecret: 'whsec' });
    const app = express();
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    try {
      const { port } = server.address() as AddressInfo;
      fetchMock.mockRestore();
      const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=short' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise(r => server.close(r));
      fetchMock = jest.spyOn(globalThis, 'fetch');
    }
  });
});

describe('GET /repo-binding', () => {
  const bound = isRepoBoundToTeam as jest.Mock;

  beforeEach(() => bound.mockReset().mockResolvedValue(true));

  it('answers the configured external principal', async () => {
    const { router } = buildRouter({}, {}, { bindingCheckSubject: 'mctl-api-repo-binding' });
    const { status, body } = await dispatch(router, 'GET', '/repo-binding?team=labs&repo=acme/api', {
      'x-test-service': 'external:mctl-api-repo-binding',
    });
    expect(status).toBe(200);
    expect(body).toEqual({ team: 'labs', repo: 'acme/api', bound: true });
    expect(bound).toHaveBeenCalledWith(expect.anything(), false, 'labs', 'acme/api');
  });

  it.each([
    ['another external principal', { 'x-test-service': 'external:mctl-api' }, 403],
    ['a plugin principal', { 'x-test-service': 'plugin:scaffolder' }, 403],
    ['a signed-in user, even an admin', { 'x-test-user': 'root' }, 401],
    ['no credentials', {}, 401],
  ])('refuses %s', async (_label, headers, code) => {
    const { router } = buildRouter({ 'admins:root': { role: 'owner' } }, {}, { bindingCheckSubject: 'mctl-api-repo-binding' });
    const { status } = await dispatch(router, 'GET', '/repo-binding?team=labs&repo=acme/api', headers as any);
    expect(status).toBe(code);
    expect(bound).not.toHaveBeenCalled();
  });

  it('refuses everyone when no subject is configured', async () => {
    const { router } = buildRouter({});
    const { status } = await dispatch(router, 'GET', '/repo-binding?team=labs&repo=acme/api', {
      'x-test-service': 'external:',
    });
    expect(status).toBe(403);
  });

  it.each(['team=../x&repo=acme/api', 'team=labs&repo=acme', 'team=labs&repo=../..'])('rejects malformed %s', async q => {
    const { router } = buildRouter({}, {}, { bindingCheckSubject: 'mctl-api-repo-binding' });
    const { status } = await dispatch(router, 'GET', `/repo-binding?${q}`, {
      'x-test-service': 'external:mctl-api-repo-binding',
    });
    expect(status).toBe(400);
    expect(bound).not.toHaveBeenCalled();
  });
});
