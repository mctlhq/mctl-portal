import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createRouter, staticTokenEquals, RouterOptions } from './router';

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
