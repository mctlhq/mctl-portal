import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createRouter, staticTokenEquals, RouterOptions } from './router';
import { CreatorPrincipalError } from './creatorPrincipal';

// /backstage/catalog.yaml serves PII (contact emails, member lists) and is
// gated on a Bearer landing token. Query-string tokens must not work.
describe('staticTokenEquals', () => {
  const token = 'k'.repeat(48);

  it('accepts the exact configured token', () => {
    expect(staticTokenEquals(token, token)).toBe(true);
  });

  it.each([
    ['wrong value of same length', 'x'.repeat(48)],
    ['prefix of the token', token.slice(0, 47)],
    ['token with suffix', `${token}k`],
    ['empty string', ''],
  ])('rejects %s', (_name, provided) => {
    expect(staticTokenEquals(provided, token)).toBe(false);
  });

  it('rejects when the caller sends nothing', () => {
    expect(staticTokenEquals(undefined, token)).toBe(false);
  });

  it('rejects everything when no token is configured (never open by accident)', () => {
    expect(staticTokenEquals(token, undefined)).toBe(false);
    expect(staticTokenEquals('', undefined)).toBe(false);
    expect(staticTokenEquals(undefined, undefined)).toBe(false);
    expect(staticTokenEquals(undefined, '')).toBe(false);
  });
});

describe('GET /backstage/catalog.yaml', () => {
  const token = 'catalog-secret-token';
  let server: Server | undefined;

  const noopLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
  noopLogger.child.mockReturnValue(noopLogger);

  function startApp(landingPageToken: string | undefined): Promise<string> {
    const options = {
      logger: noopLogger,
      // Only the catalog handler is exercised; auth services must not be hit.
      httpAuth: { credentials: jest.fn().mockRejectedValue(new Error('no creds')) },
      userInfo: { getUserInfo: jest.fn() },
      store: {
        listAll: jest.fn().mockResolvedValue([
          { name: 'labs', displayName: 'Labs', contactEmail: 'owner@example.com' },
        ]),
        listAllMembers: jest.fn().mockResolvedValue([
          { tenantName: 'labs', userId: 'alice', role: 'owner' },
        ]),
      },
      argoClient: {},
      argoNamespace: 'argo-workflows',
      getGithubToken: jest.fn(),
      landingPageToken,
    } as unknown as RouterOptions;
    const app = express();
    app.use(createRouter(options));
    return new Promise(resolve => {
      server = app.listen(0, () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
  }

  afterEach(done => {
    if (server) {
      server.close(() => done());
      server = undefined;
    } else {
      done();
    }
  });

  it('returns 503 when no landing token is configured', async () => {
    const base = await startApp(undefined);
    const res = await fetch(`${base}/backstage/catalog.yaml`);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('owner@example.com');
  });

  it('returns 401 without a token', async () => {
    const base = await startApp(token);
    const res = await fetch(`${base}/backstage/catalog.yaml`);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('owner@example.com');
  });

  it('returns 401 for a wrong query token and a wrong bearer token', async () => {
    const base = await startApp(token);
    const byQuery = await fetch(`${base}/backstage/catalog.yaml?token=wrong`);
    expect(byQuery.status).toBe(401);
    const byHeader = await fetch(`${base}/backstage/catalog.yaml`, {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(byHeader.status).toBe(401);
  });

  it('rejects the correct token in the query string', async () => {
    const base = await startApp(token);
    const res = await fetch(
      `${base}/backstage/catalog.yaml?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('owner@example.com');
  });

  it('serves catalog YAML for the correct bearer token', async () => {
    const base = await startApp(token);
    const res = await fetch(`${base}/backstage/catalog.yaml`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('owner@example.com');
  });
});

describe('landing-page token is not platform admin', () => {
  const token = 'landing-secret-token';
  let server: Server | undefined;
  const submitWorkflow = jest.fn().mockResolvedValue('create-tenant-abc');

  const noopLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
  noopLogger.child.mockReturnValue(noopLogger);

  function startApp(): Promise<string> {
    const options = {
      logger: noopLogger,
      httpAuth: { credentials: jest.fn().mockRejectedValue(new Error('no creds')) },
      userInfo: { getUserInfo: jest.fn() },
      store: {
        listAll: jest.fn().mockResolvedValue([
          { name: 'labs', displayName: 'Labs', contactEmail: 'owner@example.com' },
        ]),
        findByName: jest.fn().mockImplementation(async (name: string) =>
          name === 'labs'
            ? { name: 'labs', displayName: 'Labs', contactEmail: 'owner@example.com' }
            : undefined,
        ),
        upsert: jest.fn().mockResolvedValue(undefined),
        addMember: jest.fn().mockResolvedValue(undefined),
        listAllMembers: jest.fn().mockResolvedValue([]),
        listMembers: jest.fn().mockResolvedValue([{ userId: 'alice', role: 'owner' }]),
        getMemberByTenant: jest.fn(),
      },
      argoClient: { submitWorkflow },
      argoNamespace: 'argo-workflows',
      getGithubToken: jest.fn(),
      landingPageToken: token,
    } as unknown as RouterOptions;
    const app = express();
    app.use(createRouter(options));
    return new Promise(resolve => {
      server = app.listen(0, () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
  }

  afterEach(done => {
    submitWorkflow.mockClear();
    if (server) {
      server.close(() => done());
      server = undefined;
    } else {
      done();
    }
  });

  it('allows POST /tenants and GET /tenants/:name without PII', async () => {
    const base = await startApp();
    const created = await fetch(`${base}/tenants`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tenantName: 'acme', displayName: 'Acme' }),
    });
    expect(created.status).toBe(202);
    expect(submitWorkflow).toHaveBeenCalled();

    const check = await fetch(`${base}/tenants/labs`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(check.status).toBe(200);
    const body = await check.json();
    expect(body.tenant).toEqual({ name: 'labs' });
    expect(JSON.stringify(body)).not.toContain('owner@example.com');
  });

  it('cannot list tenants, members, or delete', async () => {
    const base = await startApp();
    const headers = { authorization: `Bearer ${token}` };
    expect((await fetch(`${base}/tenants`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/tenants/labs/members`, { headers })).status).toBe(403);
    expect(
      (await fetch(`${base}/tenants/labs`, { method: 'DELETE', headers })).status,
    ).toBe(403);
  });
});

// POST /tenants keys the owner entry by principal (mctl-api#377): a request
// naming a creator gets the creator's principal from mctl-api first, and is
// refused with nothing written when it cannot.
describe('POST /tenants resolves the creator principal', () => {
  const token = 'landing-secret-token';
  const PID = 'prn_01M39HRB7JRXZ2PHW5VVB695YZ';
  let server: Server | undefined;
  const submitWorkflow = jest.fn().mockResolvedValue('create-tenant-abc');
  const upsert = jest.fn().mockResolvedValue(undefined);
  const addMember = jest.fn().mockResolvedValue(undefined);
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn() };

  function startApp(resolveCreatorPrincipal?: (login: string) => Promise<string>): Promise<string> {
    const options = {
      logger,
      httpAuth: { credentials: jest.fn().mockRejectedValue(new Error('no creds')) },
      userInfo: { getUserInfo: jest.fn() },
      store: { findByName: jest.fn().mockResolvedValue(undefined), upsert, addMember },
      argoClient: { submitWorkflow },
      argoNamespace: 'argo-workflows',
      getGithubToken: jest.fn(),
      landingPageToken: token,
      resolveCreatorPrincipal,
    } as unknown as RouterOptions;
    const app = express();
    app.use(createRouter(options));
    return new Promise(resolve => {
      server = app.listen(0, () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
  }

  const create = (base: string, extra: Record<string, unknown>) =>
    fetch(`${base}/tenants`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantName: 'acme', displayName: 'Acme', ...extra }),
    });

  const params = () => submitWorkflow.mock.calls[0][0].parameters as string[];

  afterEach(done => {
    submitWorkflow.mockClear();
    upsert.mockClear();
    addMember.mockClear();
    if (server) {
      server.close(() => done());
      server = undefined;
    } else {
      done();
    }
  });

  it('passes the creator principal to create-tenant', async () => {
    const resolve = jest.fn().mockResolvedValue(PID);
    const base = await startApp(resolve);
    expect((await create(base, { creatorUserId: 'Octo-Cat' })).status).toBe(202);
    expect(resolve).toHaveBeenCalledWith('Octo-Cat');
    expect(params()).toContain('creator_user_id=Octo-Cat');
    expect(params()).toContain(`creator_principal_id=${PID}`);
  });

  it('sends no principal when no creator is named', async () => {
    const resolve = jest.fn();
    const base = await startApp(resolve);
    expect((await create(base, {})).status).toBe(202);
    expect(resolve).not.toHaveBeenCalled();
    expect(params()).toContain('creator_principal_id=');
  });

  it('refuses a creator that is not a GitHub login', async () => {
    const resolve = jest.fn().mockResolvedValue(PID);
    const base = await startApp(resolve);
    for (const creatorUserId of ['octo cat', 'a:b', 'x'.repeat(40), 'a-'.repeat(20) + 'a', 42]) {
      expect((await create(base, { creatorUserId })).status).toBe(400);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a named creator when resolution is not configured', async () => {
    const base = await startApp(undefined);
    expect((await create(base, { creatorUserId: 'octocat' })).status).toBe(503);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not configured'));
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(addMember).not.toHaveBeenCalled();
  });

  it('refuses when the principal cannot be resolved', async () => {
    const base = await startApp(jest.fn().mockRejectedValue(new CreatorPrincipalError(503, 'down')));
    expect((await create(base, { creatorUserId: 'octocat' })).status).toBe(503);
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('treats an unexpected resolver error as unresolved', async () => {
    const base = await startApp(jest.fn().mockRejectedValue(new Error('boom')));
    expect((await create(base, { creatorUserId: 'octocat' })).status).toBe(503);
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('answers 403 for a disabled or refused creator', async () => {
    const base = await startApp(
      jest.fn().mockRejectedValue(new CreatorPrincipalError(403, 'not allowed', 'principal_disabled')),
    );
    const res = await create(base, { creatorUserId: 'octocat' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('principal_disabled');
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

// Callers are identified by the x-test-caller header: "service" for a
// Backstage service credential, "user:<id>" for a signed-in user.
describe('tenant data is scoped to members, admins and real users', () => {
  let server: Server | undefined;
  const submitWorkflow = jest.fn().mockResolvedValue('wf');
  const TENANT = { name: 'labs', displayName: 'Labs', contactEmail: 'owner@example.com' };
  const MEMBERS: Record<string, string> = { 'labs:carol': 'viewer', 'admins:root': 'owner' };

  const noopLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
  noopLogger.child.mockReturnValue(noopLogger);

  function startApp(): Promise<string> {
    const options = {
      logger: noopLogger,
      httpAuth: {
        credentials: jest.fn(async (req: any, opts?: { allow?: string[] }) => {
          const caller = String(req.headers['x-test-caller'] ?? '');
          const type = caller === 'service' ? 'service' : caller.startsWith('user:') ? 'user' : '';
          if (!type || (opts?.allow && !opts.allow.includes(type))) {
            throw new Error('not allowed');
          }
          return type === 'user'
            ? { principal: { type, userEntityRef: `user:default/${caller.slice(5)}` } }
            : { principal: { type, subject: 'plugin:scaffolder' } };
        }),
      },
      userInfo: {
        getUserInfo: jest.fn(async (c: any) => ({
          userEntityRef: c.principal.userEntityRef,
          ownershipEntityRefs: [c.principal.userEntityRef],
        })),
      },
      store: {
        listAll: jest.fn().mockResolvedValue([TENANT]),
        findByName: jest.fn(async (name: string) => (name === 'labs' ? TENANT : undefined)),
        upsert: jest.fn().mockResolvedValue(undefined),
        addMember: jest.fn().mockResolvedValue(undefined),
        listMembers: jest.fn().mockResolvedValue([{ userId: 'carol', role: 'viewer' }]),
        getMemberByTenant: jest.fn(async (tenant: string, userId: string) => {
          const role = MEMBERS[`${tenant}:${userId}`];
          return role ? { tenantName: tenant, userId, role } : undefined;
        }),
      },
      argoClient: { submitWorkflow },
      argoNamespace: 'argo-workflows',
      getGithubToken: jest.fn(),
      landingPageToken: undefined,
    } as unknown as RouterOptions;
    const app = express();
    app.use(createRouter(options));
    return new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
  }

  afterEach(done => {
    submitWorkflow.mockClear();
    if (server) {
      server.close(() => done());
      server = undefined;
    } else {
      done();
    }
  });

  it('does not treat a service credential as platform admin', async () => {
    const base = await startApp();
    const headers = { 'x-test-caller': 'service', 'content-type': 'application/json' };
    expect((await fetch(`${base}/tenants`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/tenants/labs/members`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/tenants/labs`, { method: 'DELETE', headers })).status).toBe(403);
    const created = await fetch(`${base}/tenants`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tenantName: 'acme', displayName: 'Acme' }),
    });
    expect(created.status).toBe(403);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('lists tenants only for platform admins', async () => {
    const base = await startApp();
    expect((await fetch(`${base}/tenants`, { headers: { 'x-test-caller': 'user:stranger' } })).status).toBe(403);
    expect((await fetch(`${base}/tenants`, { headers: { 'x-test-caller': 'user:carol' } })).status).toBe(403);
    const admin = await fetch(`${base}/tenants`, { headers: { 'x-test-caller': 'user:root' } });
    expect(admin.status).toBe(200);
    expect((await admin.json()).tenants).toEqual([TENANT]);
  });

  it('shows a non-member only that a tenant exists', async () => {
    const base = await startApp();
    const res = await fetch(`${base}/tenants/labs`, { headers: { 'x-test-caller': 'user:stranger' } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant).toEqual({ name: 'labs' });
    expect(JSON.stringify(body)).not.toContain('owner@example.com');
  });

  it('shows members and admins the full tenant', async () => {
    const base = await startApp();
    for (const caller of ['user:carol', 'user:root']) {
      const res = await fetch(`${base}/tenants/labs`, { headers: { 'x-test-caller': caller } });
      expect((await res.json()).tenant).toEqual(TENANT);
    }
  });
});

describe('rate limits', () => {
  let server: Server | undefined;

  afterEach(done => {
    if (server) {
      server.close(() => done());
      server = undefined;
    } else {
      done();
    }
  });

  // Unauthenticated callers get a cheap 401, so the second call shows
  // whether the limiter ran in front of the handler.
  function startApp(): Promise<string> {
    const options = {
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn() },
      httpAuth: { credentials: jest.fn().mockRejectedValue(new Error('no creds')) },
      userInfo: { getUserInfo: jest.fn() },
      store: { listAll: jest.fn().mockResolvedValue([]), listAllMembers: jest.fn().mockResolvedValue([]) },
      argoClient: {},
      argoNamespace: 'argo-workflows',
      getGithubToken: jest.fn(),
      rateLimits: { read: 1, write: 1 },
    } as unknown as RouterOptions;
    const app = express();
    app.use(createRouter(options));
    return new Promise(resolve => {
      server = app.listen(0, () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
    });
  }

  it.each([
    ['GET', '/check-user?username=octocat'],
    ['GET', '/tenants'],
    ['GET', '/tenants/labs'],
    ['POST', '/tenants'],
    ['DELETE', '/tenants/labs'],
    ['GET', '/me/tenant'],
    ['GET', '/tenants/labs/members'],
    ['POST', '/tenants/labs/members'],
    ['DELETE', '/tenants/labs/members/alice'],
    ['PUT', '/tenants/labs/members/alice/role'],
  ])('%s %s is limited', async (method, route) => {
    const base = await startApp();
    const call = () =>
      fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
    expect((await call()).status).not.toBe(429);
    expect((await call()).status).toBe(429);
  });

  it.each(['/health', '/config'])('%s is not limited', async route => {
    const base = await startApp();
    for (let i = 0; i < 3; i++) expect((await fetch(`${base}${route}`)).status).toBe(200);
  });
});
