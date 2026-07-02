import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createRouter, staticTokenEquals, RouterOptions } from './router';

// /backstage/catalog.yaml serves PII (contact emails, member lists) and is
// gated on the landing token via this comparison; it is also the fallback
// static-token path in resolveAuth. Guard both directions.
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

  it('serves catalog YAML for the correct query token', async () => {
    const base = await startApp(token);
    const res = await fetch(
      `${base}/backstage/catalog.yaml?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/yaml');
    const body = await res.text();
    expect(body).toContain('kind: Group');
    expect(body).toContain('name: labs');
    expect(body).toContain('alice');
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
