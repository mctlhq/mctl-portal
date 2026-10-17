import { CustomerDeletionConflictError } from './customerDeletionSchema';
import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createRouter, staticTokenEquals, RouterOptions } from './router';
import { CreatorPrincipalError } from './creatorPrincipal';
import { CustomerHasTenantError, TenantExistsError } from './tenantStore';
import { ZitadelCustomerError } from './zitadelCustomer';

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
      httpAuth: {
        credentials: jest.fn().mockRejectedValue(new Error('no creds')),
      },
      userInfo: { getUserInfo: jest.fn() },
      store: {
        listAll: jest.fn().mockResolvedValue([
          {
            name: 'labs',
            displayName: 'Labs',
            contactEmail: 'owner@example.com',
          },
        ]),
        listAllMembers: jest
          .fn()
          .mockResolvedValue([
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
      httpAuth: {
        credentials: jest.fn().mockRejectedValue(new Error('no creds')),
      },
      userInfo: { getUserInfo: jest.fn() },
      store: {
        listAll: jest.fn().mockResolvedValue([
          {
            name: 'labs',
            displayName: 'Labs',
            contactEmail: 'owner@example.com',
          },
        ]),
        findByName: jest.fn().mockImplementation(async (name: string) =>
          name === 'labs'
            ? {
                name: 'labs',
                displayName: 'Labs',
                contactEmail: 'owner@example.com',
              }
            : undefined,
        ),
        upsert: jest.fn().mockResolvedValue(undefined),
        addMember: jest.fn().mockResolvedValue(undefined),
        listAllMembers: jest.fn().mockResolvedValue([]),
        listMembers: jest
          .fn()
          .mockResolvedValue([{ userId: 'alice', role: 'owner' }]),
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
    expect(
      (await fetch(`${base}/tenants/labs/members`, { headers })).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/tenants/labs`, { method: 'DELETE', headers }))
        .status,
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
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };

  function startApp(
    resolveCreatorPrincipal?: (login: string) => Promise<string>,
  ): Promise<string> {
    const options = {
      logger,
      httpAuth: {
        credentials: jest.fn().mockRejectedValue(new Error('no creds')),
      },
      userInfo: { getUserInfo: jest.fn() },
      store: {
        findByName: jest.fn().mockResolvedValue(undefined),
        upsert,
        addMember,
      },
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
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        tenantName: 'acme',
        displayName: 'Acme',
        ...extra,
      }),
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
    expect((await create(base, { creatorUserId: 'Octo-Cat' })).status).toBe(
      202,
    );
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
    for (const creatorUserId of [
      'octo cat',
      'a:b',
      'x'.repeat(40),
      'a-'.repeat(20) + 'a',
      42,
    ]) {
      expect((await create(base, { creatorUserId })).status).toBe(400);
    }
    expect(resolve).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('refuses a named creator when resolution is not configured', async () => {
    const base = await startApp(undefined);
    expect((await create(base, { creatorUserId: 'octocat' })).status).toBe(503);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('not configured'),
    );
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(addMember).not.toHaveBeenCalled();
  });

  it('refuses when the principal cannot be resolved', async () => {
    const base = await startApp(
      jest.fn().mockRejectedValue(new CreatorPrincipalError(503, 'down')),
    );
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
      jest
        .fn()
        .mockRejectedValue(
          new CreatorPrincipalError(403, 'not allowed', 'principal_disabled'),
        ),
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
  const TENANT = {
    name: 'labs',
    displayName: 'Labs',
    contactEmail: 'owner@example.com',
  };
  const MEMBERS: Record<string, string> = {
    'labs:carol': 'viewer',
    'admins:root': 'owner',
  };

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
          const type =
            caller === 'service'
              ? 'service'
              : caller.startsWith('user:')
              ? 'user'
              : '';
          if (!type || (opts?.allow && !opts.allow.includes(type))) {
            throw new Error('not allowed');
          }
          return type === 'user'
            ? {
                principal: {
                  type,
                  userEntityRef: `user:default/${caller.slice(5)}`,
                },
              }
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
        findByName: jest.fn(async (name: string) =>
          name === 'labs' ? TENANT : undefined,
        ),
        upsert: jest.fn().mockResolvedValue(undefined),
        addMember: jest.fn().mockResolvedValue(undefined),
        listMembers: jest
          .fn()
          .mockResolvedValue([{ userId: 'carol', role: 'viewer' }]),
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
    const headers = {
      'x-test-caller': 'service',
      'content-type': 'application/json',
    };
    expect((await fetch(`${base}/tenants`, { headers })).status).toBe(403);
    expect(
      (await fetch(`${base}/tenants/labs/members`, { headers })).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/tenants/labs`, { method: 'DELETE', headers }))
        .status,
    ).toBe(403);
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
    expect(
      (
        await fetch(`${base}/tenants`, {
          headers: { 'x-test-caller': 'user:stranger' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/tenants`, {
          headers: { 'x-test-caller': 'user:carol' },
        })
      ).status,
    ).toBe(403);
    const admin = await fetch(`${base}/tenants`, {
      headers: { 'x-test-caller': 'user:root' },
    });
    expect(admin.status).toBe(200);
    expect((await admin.json()).tenants).toEqual([TENANT]);
  });

  it('shows a non-member only that a tenant exists', async () => {
    const base = await startApp();
    const res = await fetch(`${base}/tenants/labs`, {
      headers: { 'x-test-caller': 'user:stranger' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tenant).toEqual({ name: 'labs' });
    expect(JSON.stringify(body)).not.toContain('owner@example.com');
  });

  // The same shape TenantSync holds values.yaml members to: a looser one
  // would invite someone the next sync skips.
  it.each([['a--b'], ['-ab'], ['ab-'], ['prn_01m45dr1gwc87109eh88vbjx25']])(
    'refuses to invite %p, which is not a GitHub login',
    async userId => {
      const base = await startApp();
      const res = await fetch(`${base}/tenants/labs/members`, {
        method: 'POST',
        headers: {
          'x-test-caller': 'user:root',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ userId, role: 'developer' }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Invalid GitHub username format');
    },
  );

  it('shows members and admins the full tenant', async () => {
    const base = await startApp();
    for (const caller of ['user:carol', 'user:root']) {
      const res = await fetch(`${base}/tenants/labs`, {
        headers: { 'x-test-caller': caller },
      });
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
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        child: jest.fn(),
      },
      httpAuth: {
        credentials: jest.fn().mockRejectedValue(new Error('no creds')),
      },
      userInfo: { getUserInfo: jest.fn() },
      store: {
        listAll: jest.fn().mockResolvedValue([]),
        listAllMembers: jest.fn().mockResolvedValue([]),
      },
      argoClient: {},
      argoNamespace: 'argo-workflows',
      getGithubToken: jest.fn(),
      rateLimits: { read: 1, write: 1 },
    } as unknown as RouterOptions;
    const app = express();
    app.use(createRouter(options));
    return new Promise(resolve => {
      server = app.listen(0, () =>
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`),
      );
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
      fetch(`${base}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
    expect((await call()).status).not.toBe(429);
    expect((await call()).status).toBe(429);
  });

  it.each(['/health', '/config'])('%s is not limited', async route => {
    const base = await startApp();
    for (let i = 0; i < 3; i++)
      expect((await fetch(`${base}${route}`)).status).toBe(200);
  });
});

// Stage C2: the landing page creates a workspace for a self-service customer
// from the site's ZITADEL ID token. mctl-api resolves it (purpose create);
// the owner entry is keyed by principal, never by the login the token names.
describe('self-service customers create their workspace by principal', () => {
  const token = 'landing-secret-token';
  const BOB = 'prn_01M45DR1GWC87109EH88VBJX25';
  let server: Server | undefined;
  const submitWorkflow = jest.fn().mockResolvedValue('create-tenant-abc');
  const upsert = jest.fn().mockResolvedValue(undefined);
  const addMember = jest.fn().mockResolvedValue(undefined);
  const createCustomerTenant = jest.fn().mockResolvedValue(undefined);
  const isTenantDeleting = jest.fn().mockResolvedValue(false);
  const deleteTenant = jest.fn().mockResolvedValue(undefined);
  const memberTenant: Record<string, string> = {};
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
  // Bob registered the login `alice` after Alice, a login-keyed member of
  // labs, gave it up.
  const bob = { principalId: BOB, githubId: '77', githubLogin: 'alice' };

  function startApp(
    resolveZitadelCustomer?: (
      idToken: string,
      purpose: string,
    ) => Promise<unknown>,
    caller?: string,
    workflowBaseUrl?: string,
  ): Promise<string> {
    const options = {
      logger,
      httpAuth: {
        credentials: jest.fn(async (_req: any, opts?: { allow?: string[] }) => {
          if (caller && opts?.allow?.includes('user')) {
            return {
              principal: {
                type: 'user',
                userEntityRef: `user:default/${caller}`,
              },
            };
          }
          throw new Error('no creds');
        }),
      },
      userInfo: {
        getUserInfo: jest.fn(async (c: any) => ({
          ownershipEntityRefs: [c.principal.userEntityRef],
        })),
      },
      store: {
        isTenantDeleting,
        findByName: jest.fn(async (name: string) =>
          name === 'labs' ? { name } : undefined,
        ),
        upsert,
        addMember,
        createCustomerTenant,
        delete: deleteTenant,
        getMemberTenant: jest.fn(async (userId: string) =>
          memberTenant[userId]
            ? { tenantName: memberTenant[userId], role: 'owner' }
            : undefined,
        ),
        getMemberByTenant: jest.fn(async (tenant: string, userId: string) =>
          tenant === 'admins' && userId === 'root'
            ? { role: 'owner' }
            : undefined,
        ),
      },
      argoClient: { submitWorkflow },
      argoNamespace: 'argo-workflows',
      getGithubToken: jest.fn(),
      landingPageToken: token,
      resolveCreatorPrincipal: jest
        .fn()
        .mockResolvedValue('prn_01M39HRB7JRXZ2PHW5VVB695YZ'),
      resolveZitadelCustomer,
      workflowBaseUrl,
    } as unknown as RouterOptions;
    const app = express();
    app.use(createRouter(options));
    return new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
  }

  const post = (
    base: string,
    path: string,
    body: Record<string, unknown>,
    landing = true,
  ) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        ...(landing ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const create = (
    base: string,
    extra: Record<string, unknown>,
    landing = true,
  ) =>
    post(
      base,
      '/tenants',
      {
        tenantName: 'bobs',
        displayName: 'Bobs',
        contactEmail: 'alice@example.com',
        ...extra,
      },
      landing,
    );
  const params = () => submitWorkflow.mock.calls[0][0].parameters as string[];

  afterEach(done => {
    submitWorkflow.mockReset().mockResolvedValue('create-tenant-abc');
    upsert.mockClear();
    addMember.mockClear();
    createCustomerTenant.mockReset().mockResolvedValue(undefined);
    deleteTenant.mockClear();
    isTenantDeleting.mockReset().mockResolvedValue(false);
    for (const k of Object.keys(memberTenant)) delete memberTenant[k];
    if (server) {
      server.close(() => done());
      server = undefined;
    } else {
      done();
    }
  });

  it.each([undefined, '', 'invalid', `${'x'.repeat(250)}@example.com`])(
    'refuses a customer without a valid private contact: %s',
    async contactEmail => {
      const base = await startApp(jest.fn().mockResolvedValue(bob));
      const response = await create(base, {
        creatorIdToken: 'site-id-token',
        contactEmail,
      });
      expect(response.status).toBe(400);
      expect(createCustomerTenant).not.toHaveBeenCalled();
      expect(submitWorkflow).not.toHaveBeenCalled();
    },
  );

  it('uses the configured workflow hostname in the acceptance response', async () => {
    const base = await startApp(
      jest.fn().mockResolvedValue(bob),
      undefined,
      'https://workflows.example.test/',
    );
    const response = await create(base, { creatorIdToken: 'site-id-token' });
    expect(response.status).toBe(202);
    expect((await response.json()).workflowUrl).toBe(
      'https://workflows.example.test/workflows/argo-workflows/create-tenant-abc',
    );
  });

  it('keys the owner by principal and passes the login only for display', async () => {
    const resolve = jest.fn().mockResolvedValue(bob);
    const base = await startApp(resolve);
    expect(
      (await create(base, { creatorIdToken: 'site-id-token' })).status,
    ).toBe(202);
    expect(resolve).toHaveBeenCalledWith('site-id-token', 'create');
    expect(params()).toEqual(
      expect.arrayContaining([
        'creator_user_id=alice',
        `creator_principal_id=${BOB}`,
        'creator_catalog_key=principal',
      ]),
    );
    expect(params().filter(p => p.startsWith('contact_email='))).toEqual([
      'contact_email=',
    ]);
    // Written with the tenant, before the workflow: not upsert + addMember.
    expect(createCustomerTenant).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bobs' }),
      expect.objectContaining({
        tenantName: 'bobs',
        userId: BOB.toLowerCase(),
        role: 'owner',
        catalogKey: 'principal',
        principalId: BOB,
        login: 'alice',
      }),
    );
    expect(createCustomerTenant.mock.invocationCallOrder[0]).toBeLessThan(
      submitWorkflow.mock.invocationCallOrder[0],
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(addMember).not.toHaveBeenCalled();
  });

  it('keeps the legacy landing creator login-keyed', async () => {
    const base = await startApp(jest.fn());
    expect((await create(base, { creatorUserId: 'carol' })).status).toBe(202);
    expect(params()).toContain('creator_catalog_key=login');
    expect(addMember).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'carol', catalogKey: 'login' }),
    );
  });

  it('refuses a customer who already has a workspace without submitting a workflow', async () => {
    createCustomerTenant.mockRejectedValue(
      new CustomerHasTenantError('This account already has a workspace'),
    );
    const base = await startApp(jest.fn().mockResolvedValue(bob));
    const r = await create(base, { creatorIdToken: 'site-id-token' });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('creator_has_tenant');
    expect(upsert).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses creation and availability for a name frozen by deletion', async () => {
    isTenantDeleting.mockResolvedValue(true);
    const base = await startApp(jest.fn().mockResolvedValue(bob));
    const availability = await post(base, '/tenants/availability', { name: 'bobs', creatorIdToken: 'site-id-token' });
    expect(await availability.json()).toEqual({ name: 'bobs', available: false, reason: 'name_taken' });
    const created = await create(base, { creatorIdToken: 'site-id-token' });
    expect(created.status).toBe(409);
    expect((await created.json()).code).toBe('name_taken');
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('gives a taken name the code name_taken, as availability does', async () => {
    const base = await startApp(jest.fn().mockResolvedValue(bob));
    const r = await post(base, '/tenants', {
      tenantName: 'labs',
      displayName: 'Labs',
      creatorIdToken: 'site-id-token',
    });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe('name_taken');
    expect(createCustomerTenant).not.toHaveBeenCalled();
  });

  it('refuses a name taken since the existence check without submitting a workflow', async () => {
    createCustomerTenant.mockRejectedValue(
      new TenantExistsError("Tenant 'bobs' already exists"),
    );
    const base = await startApp(jest.fn().mockResolvedValue(bob));
    const r = await create(base, { creatorIdToken: 'site-id-token' });
    expect(r.status).toBe(409);
    // The same reason POST /tenants/availability gives.
    expect((await r.json()).code).toBe('name_taken');
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it("releases the customer's reservation when the workflow cannot be submitted", async () => {
    submitWorkflow.mockRejectedValue(new Error('argo down'));
    const base = await startApp(jest.fn().mockResolvedValue(bob));
    expect(
      (await create(base, { creatorIdToken: 'site-id-token' })).status,
    ).toBe(500);
    expect(deleteTenant).toHaveBeenCalledWith('bobs');
  });

  it.each([
    [
      'mctl-api refuses the customer',
      new ZitadelCustomerError('refused', 'no', 'principal_disabled'),
      403,
    ],
    [
      'mctl-api is unavailable',
      new ZitadelCustomerError('unavailable', 'down'),
      503,
    ],
    ['the resolver throws something else', new Error('boom'), 503],
  ])('writes nothing when %s', async (_name, err, status) => {
    const base = await startApp(jest.fn().mockRejectedValue(err));
    expect(
      (await create(base, { creatorIdToken: 'site-id-token' })).status,
    ).toBe(status);
    expect(upsert).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('logs a resolver failure it does not model', async () => {
    logger.error.mockClear();
    const base = await startApp(
      jest.fn().mockRejectedValue(new TypeError('boom')),
    );
    expect(
      (await create(base, { creatorIdToken: 'site-id-token' })).status,
    ).toBe(503);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('TypeError: boom'),
    );
  });

  it('writes nothing when customer resolution is not configured', async () => {
    const base = await startApp(undefined);
    expect(
      (await create(base, { creatorIdToken: 'site-id-token' })).status,
    ).toBe(503);
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a token together with a login, or a token that is not a string', async () => {
    const resolve = jest.fn().mockResolvedValue(bob);
    const base = await startApp(resolve);
    expect(
      (await create(base, { creatorIdToken: 't', creatorUserId: 'alice' }))
        .status,
    ).toBe(400);
    expect((await create(base, { creatorIdToken: ['t'] })).status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
    expect(submitWorkflow).not.toHaveBeenCalled();
  });

  it('accepts creatorIdToken from the landing page only', async () => {
    const resolve = jest.fn().mockResolvedValue(bob);
    const base = await startApp(resolve, 'root');
    expect(
      (await create(base, { creatorIdToken: 'site-id-token' }, false)).status,
    ).toBe(403);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('lets a portal admin name only themself as creator', async () => {
    const base = await startApp(jest.fn(), 'root');
    expect(
      (await create(base, { creatorUserId: 'someone-else' }, false)).status,
    ).toBe(400);
    expect(submitWorkflow).not.toHaveBeenCalled();
    expect((await create(base, { creatorUserId: 'Root' }, false)).status).toBe(
      202,
    );
    expect(params()).toEqual(
      expect.arrayContaining([
        'creator_user_id=Root',
        'creator_catalog_key=login',
      ]),
    );
  });

  describe('POST /tenants/availability', () => {
    it('answers for a resolvable customer and a free name', async () => {
      const resolve = jest.fn().mockResolvedValue(bob);
      const base = await startApp(resolve);
      const r = await post(base, '/tenants/availability', {
        name: 'bobs',
        creatorIdToken: 'site-id-token',
      });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ name: 'bobs', available: true });
      expect(resolve).toHaveBeenCalledWith('site-id-token', 'create');
    });

    it('reports a taken name and an existing workspace', async () => {
      const base = await startApp(jest.fn().mockResolvedValue(bob));
      expect(
        await (
          await post(base, '/tenants/availability', {
            name: 'labs',
            creatorIdToken: 't',
          })
        ).json(),
      ).toEqual({ name: 'labs', available: false, reason: 'name_taken' });
      memberTenant[BOB.toLowerCase()] = 'first';
      expect(
        await (
          await post(base, '/tenants/availability', {
            name: 'bobs',
            creatorIdToken: 't',
          })
        ).json(),
      ).toEqual({
        name: 'bobs',
        available: false,
        reason: 'creator_has_tenant',
      });
    });

    it('answers a refused customer before the name', async () => {
      const base = await startApp(
        jest
          .fn()
          .mockRejectedValue(
            new ZitadelCustomerError('refused', 'no', 'customer_conflict'),
          ),
      );
      const r = await post(base, '/tenants/availability', {
        name: 'bobs',
        creatorIdToken: 't',
      });
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe('customer_conflict');
    });

    it('validates its input and serves the landing page only', async () => {
      const resolve = jest.fn().mockResolvedValue(bob);
      const base = await startApp(resolve, 'root');
      expect(
        (
          await post(base, '/tenants/availability', {
            name: 'Bad_Name',
            creatorIdToken: 't',
          })
        ).status,
      ).toBe(400);
      expect(
        (await post(base, '/tenants/availability', { name: 'bobs' })).status,
      ).toBe(400);
      expect(
        (
          await post(
            base,
            '/tenants/availability',
            { name: 'bobs', creatorIdToken: 't' },
            false,
          )
        ).status,
      ).toBe(403);
      expect(resolve).not.toHaveBeenCalled();
    });
  });
});


describe('POST /internal/tenants/:name/cleanup', () => {
  let server: Server;
  let base: string;
  const cleanup = jest.fn();
  beforeEach(async () => {
    cleanup.mockReset().mockResolvedValue(undefined);
    const app = express();
    app.use(createRouter({
      logger: { warn: jest.fn(), info: jest.fn() } as any,
      httpAuth: { credentials: jest.fn(async (req: express.Request) => {
        const subject = req.header('x-test-service');
        if (!subject) throw new Error('No service credential');
        return { principal: { type: 'service', subject } };
      }) } as any,
      userInfo: {} as any, store: {} as any, argoClient: {} as any,
      argoNamespace: 'argo-workflows', getGithubToken: async () => 'unused',
      cleanupDeletedTenant: cleanup,
    }));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const post = (service?: string, name = 'acme', body = {}) => fetch(`${base}/internal/tenants/${name}/cleanup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(service ? { 'x-test-service': service } : {}) }, body: JSON.stringify(body),
  });
  it.each([undefined, 'plugin:tenant-management', 'external:landing', 'external:other', 'mctl-api'])('refuses %s without touching state', async service => {
    expect((await post(service)).status).toBe(403);
    expect(cleanup).not.toHaveBeenCalled();
  });
  it.each(['external:mctl-api'])('accepts only the workflow caller %s', async service => {
    const res = await post(service);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: 'acme', cleaned: true, scope: 'workspace' });
    expect(cleanup).toHaveBeenCalledWith('acme', undefined, undefined);
  });
  it('reports an unobserved cleanup as incomplete', async () => {
    cleanup.mockRejectedValueOnce(new Error('GitHub read failed'));
    expect((await post('external:mctl-api')).status).toBe(503);
  });
  it('refuses protected tenants and malformed customer identities', async () => {
    expect((await post('external:mctl-api', 'admins')).status).toBe(400);
    expect((await post('external:mctl-api', 'acme', { principal_id: 'not-a-principal', login: 'alice' })).status).toBe(400);
    expect((await post('external:mctl-api', 'acme', { login: 'alice' })).status).toBe(400);
    expect(cleanup).not.toHaveBeenCalled();
  });
});


describe('customer lifecycle private route', () => {
 let server: Server;
 let base: string;
 const pid = 'prn_01M45DR1GWC87109EH88VBJX25';
 const freeze = jest.fn();
 const release = jest.fn();
 beforeEach(async () => {
  freeze.mockReset().mockResolvedValue(undefined); release.mockReset().mockResolvedValue(undefined);
  const app = express();
  app.use(createRouter({
   logger: { warn: jest.fn(), info: jest.fn() } as any,
   httpAuth: { credentials: async (req: express.Request) => ({ principal: { type: 'service', subject: req.header('x-test-service') } }) } as any,
   userInfo: {} as any, store: { freezeCustomerDeletion: freeze, releaseCustomerDeletion: release } as any,
   argoClient: {} as any, argoNamespace: 'argo-workflows', getGithubToken: async () => 'unused',
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 });
 afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
 const post = (stage = 'prepare', service = 'external:mctl-api', body = { principal_id: pid, login: 'alice' }) => fetch(`${base}/internal/tenants/acme/customer-deletion/${stage}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-service': service }, body: JSON.stringify(body) });
 it.each(['mctl-api', 'plugin:tenant-management', 'external:other'])('refuses %s without changes', async subject => {
  expect((await post('prepare', subject)).status).toBe(403); expect(freeze).not.toHaveBeenCalled();
 });
 it('dispatches only validated lifecycle stages', async () => {
  expect((await post()).status).toBe(200); expect(freeze).toHaveBeenCalledWith('acme',pid,'alice');
  expect((await post('release')).status).toBe(200); expect(release).toHaveBeenCalledWith('acme',pid);
  expect((await post('bogus')).status).toBe(400);
  expect((await post('prepare','external:mctl-api',{ principal_id: 'invalid', login: 'alice' })).status).toBe(400);
 });
 it('distinguishes invariant conflicts from unavailable storage', async () => {
  freeze.mockRejectedValueOnce(new CustomerDeletionConflictError('ownership conflict'));
  expect((await post()).status).toBe(409);
  freeze.mockRejectedValueOnce(new Error('database unavailable'));
  expect((await post()).status).toBe(503);
 });
});
