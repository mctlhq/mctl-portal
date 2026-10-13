import type { Knex } from 'knex';
import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createRouter, RouterOptions } from './router';

// The k8s client reads any namespace with the backend's cluster-wide
// credentials, so these routes must only answer for the caller's own tenant.

// Mirrors getTenantMember's real query shape: db('tenant_members')
// [.withSchema(...) on Postgres].where({ tenant_name, user_id }).first()
function fakeDb(memberships: Record<string, string>): Knex {
  const db = jest.fn((_table: string) => {
    const builder: any = {
      withSchema: jest.fn().mockReturnThis(),
      where(cond: { tenant_name: string; user_id: string }) {
        builder._cond = cond;
        return builder;
      },
      async first() {
        const role = memberships[`${builder._cond.tenant_name}:${builder._cond.user_id}`];
        return role
          ? { tenant_name: builder._cond.tenant_name, user_id: builder._cond.user_id, role }
          : undefined;
      },
    };
    return builder;
  });
  return db as unknown as Knex;
}

const MEMBERSHIPS = {
  'labs:carol': 'viewer',
  'admins:root': 'owner',
  'admins:dave': 'viewer',
};

const noopLogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };

let server: Server | undefined;
let k8sClient: { getNamespaceUsage: jest.Mock; getPodUsage: jest.Mock };

function startApp(
  caller: { type: 'user' | 'service'; userRef?: string },
  rateLimits?: RouterOptions['rateLimits'],
): Promise<string> {
  k8sClient = {
    getNamespaceUsage: jest.fn(async (ns: string) => ({ namespace: ns })),
    getPodUsage: jest.fn(async (ns: string) => [{ namespace: ns, name: 'pod-0' }]),
  };
  const options = {
    logger: noopLogger,
    httpAuth: {
      credentials: jest.fn(async (_req: unknown, opts?: { allow?: string[] }) => {
        if (opts?.allow && !opts.allow.includes(caller.type)) {
          throw Object.assign(new Error(`${caller.type} credentials not allowed`), {
            name: 'NotAllowedError',
          });
        }
        return { principal: { type: caller.type, userEntityRef: caller.userRef } };
      }),
    },
    userInfo: {
      getUserInfo: jest.fn(async () => ({
        userEntityRef: caller.userRef,
        ownershipEntityRefs: caller.userRef ? [caller.userRef] : [],
      })),
    },
    db: fakeDb(MEMBERSHIPS),
    isPostgres: false,
    k8sClient,
    rateLimits,
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
  if (server) {
    server.close(() => done());
    server = undefined;
  } else {
    done();
  }
});

describe.each(['usage', 'pods'])('GET /namespaces/:ns/%s', route => {
  const k8sCall = () =>
    route === 'usage' ? k8sClient.getNamespaceUsage : k8sClient.getPodUsage;

  it('refuses a signed-in user who is not a member of the tenant', async () => {
    const base = await startApp({ type: 'user', userRef: 'user:default/stranger' });
    const res = await fetch(`${base}/namespaces/admins/${route}`);
    expect(res.status).toBe(403);
    expect(k8sCall()).not.toHaveBeenCalled();
  });

  it("refuses a tenant member asking for another tenant's namespace", async () => {
    const base = await startApp({ type: 'user', userRef: 'user:default/carol' });
    const res = await fetch(`${base}/namespaces/admins/${route}`);
    expect(res.status).toBe(403);
    expect(k8sCall()).not.toHaveBeenCalled();
  });

  it('refuses a non-owner of the admins tenant outside admins', async () => {
    const base = await startApp({ type: 'user', userRef: 'user:default/dave' });
    const res = await fetch(`${base}/namespaces/labs/${route}`);
    expect(res.status).toBe(403);
    expect(k8sCall()).not.toHaveBeenCalled();
  });

  it('refuses service credentials', async () => {
    const base = await startApp({ type: 'service' });
    const res = await fetch(`${base}/namespaces/labs/${route}`);
    expect(res.status).toBe(401);
    expect(k8sCall()).not.toHaveBeenCalled();
  });

  it('refuses user credentials that carry no user entity', async () => {
    const base = await startApp({ type: 'user' });
    const res = await fetch(`${base}/namespaces/labs/${route}`);
    expect(res.status).toBe(401);
    expect(k8sCall()).not.toHaveBeenCalled();
  });

  it('serves any member of the tenant, whatever the role', async () => {
    const base = await startApp({ type: 'user', userRef: 'user:default/carol' });
    const res = await fetch(`${base}/namespaces/labs/${route}`);
    expect(res.status).toBe(200);
    expect(k8sCall()).toHaveBeenCalledWith('labs');
  });

  it('serves platform admins in any namespace', async () => {
    const base = await startApp({ type: 'user', userRef: 'user:default/root' });
    const res = await fetch(`${base}/namespaces/monitoring/${route}`);
    expect(res.status).toBe(200);
    expect(k8sCall()).toHaveBeenCalledWith('monitoring');
  });
});

describe.each(['usage', 'pods'])('GET /namespaces/:ns/%s rate limit', route => {
  it('answers 429 once the caller spends its budget', async () => {
    const base = await startApp({ type: 'user', userRef: 'user:default/carol' }, { read: 1, write: 1 });
    expect((await fetch(`${base}/namespaces/labs/${route}`)).status).toBe(200);
    expect((await fetch(`${base}/namespaces/labs/${route}`)).status).toBe(429);
  });
});
