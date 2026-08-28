import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import type { Knex } from 'knex';
import { authorizeForTeam, createRouter, isWorkflowCaller, resolveCallerId, RouterOptions } from './router';

// Mirrors getTenantMember's real query shape: db('tenant_members')
// [.withSchema(...) on Postgres].where({ tenant_name, user_id }).first()
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

// authorizeForTeam gates every /domains* route below. This exercises the
// admin bypass and the case-mismatch handling directly, without any
// Express req/res.
describe('authorizeForTeam', () => {
  it('grants an admins-tenant owner access to a team they are not a member of', async () => {
    const db = fakeDb({ 'admins:alice': { role: 'owner' } });
    const result = await authorizeForTeam(db, false, 'alice', 'acme');
    expect(result).toEqual({ ok: true });
  });

  it('grants a genuine team member access', async () => {
    const db = fakeDb({ 'acme:carol': { role: 'viewer' } });
    const result = await authorizeForTeam(db, false, 'carol', 'acme');
    expect(result).toEqual({ ok: true });
  });

  it('denies a non-admin who is not a member of the team', async () => {
    const db = fakeDb({});
    const result = await authorizeForTeam(db, false, 'bob', 'acme');
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Access denied: not a member of team 'acme'",
    });
  });

  it('resolves a case-mismatched userId against a lowercase stored user_id (T10)', async () => {
    // GitHub login 'Alice' vs. tenant_members.user_id 'alice'.
    const db = fakeDb({ 'acme:alice': { role: 'viewer' } });
    const result = await authorizeForTeam(db, false, 'Alice', 'acme');
    expect(result).toEqual({ ok: true });
  });
});

describe('resolveCallerId', () => {
  it('returns the userId extracted from ownershipEntityRefs', async () => {
    const httpAuth = { credentials: jest.fn().mockResolvedValue({ principal: 'user' }) } as any;
    const userInfo = {
      getUserInfo: jest.fn().mockResolvedValue({ ownershipEntityRefs: ['user:default/alice'] }),
    } as any;
    const result = await resolveCallerId({} as any, httpAuth, userInfo);
    expect(result).toEqual({ userId: 'alice' });
  });

  it('returns 401 when no valid user credential is present', async () => {
    const httpAuth = { credentials: jest.fn().mockRejectedValue(new Error('no creds')) } as any;
    const userInfo = { getUserInfo: jest.fn() } as any;
    const result = await resolveCallerId({} as any, httpAuth, userInfo);
    expect(result).toEqual({ status: 401, error: 'Authentication required' });
  });

  it('returns 401 when the credential carries no user:default ownership ref', async () => {
    const httpAuth = { credentials: jest.fn().mockResolvedValue({ principal: 'user' }) } as any;
    const userInfo = {
      getUserInfo: jest.fn().mockResolvedValue({ ownershipEntityRefs: ['group:default/acme'] }),
    } as any;
    const result = await resolveCallerId({} as any, httpAuth, userInfo);
    expect(result).toEqual({ status: 401, error: 'Authentication required' });
  });
});

describe('isWorkflowCaller', () => {
  it('accepts the workflow external-access identity', async () => {
    const httpAuth = {
      credentials: jest.fn().mockResolvedValue({ principal: { type: 'service', subject: 'external:mctl-api' } }),
    } as any;
    expect(await isWorkflowCaller({} as any, httpAuth)).toBe(true);
  });

  it('accepts the bare configured subject form', async () => {
    const httpAuth = {
      credentials: jest.fn().mockResolvedValue({ principal: { type: 'service', subject: 'mctl-api' } }),
    } as any;
    expect(await isWorkflowCaller({} as any, httpAuth)).toBe(true);
  });

  it('rejects other backend plugins\' plugin-to-plugin credentials', async () => {
    const httpAuth = {
      credentials: jest.fn().mockResolvedValue({ principal: { type: 'service', subject: 'plugin:vault-secrets' } }),
    } as any;
    expect(await isWorkflowCaller({} as any, httpAuth)).toBe(false);
  });

  it('rejects a service credential with no subject', async () => {
    const httpAuth = { credentials: jest.fn().mockResolvedValue({ principal: 'service' }) } as any;
    expect(await isWorkflowCaller({} as any, httpAuth)).toBe(false);
  });

  it('rejects when no service credential is present', async () => {
    const httpAuth = { credentials: jest.fn().mockRejectedValue(new Error('no creds')) } as any;
    expect(await isWorkflowCaller({} as any, httpAuth)).toBe(false);
  });
});

// Full-router tests: gates T1-T9 end to end (case-mismatch T10 is covered
// directly above against authorizeForTeam).
describe('createRouter tenant ownership gating', () => {
  let server: Server | undefined;

  const noopLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
  noopLogger.child.mockReturnValue(noopLogger);

  // Simulates httpAuth.credentials(): 'user' resolves only for allow:['user'],
  // 'service' only for allow:['service'], 'none' always rejects (anonymous).
  function makeHttpAuth(as: 'user' | 'service' | 'none') {
    return {
      credentials: jest.fn(async (_req: unknown, opts: { allow: string[] }) => {
        if (as !== 'none' && opts.allow.includes(as)) {
          // Service credentials carry the workflow's external-access
          // subject, matching what isWorkflowCaller's allowlist expects.
          return as === 'service'
            ? { principal: { type: 'service', subject: 'external:mctl-api' } }
            : { principal: as };
        }
        throw new Error('no matching credential');
      }),
    };
  }

  function makeUserInfo(userId: string | undefined) {
    return {
      getUserInfo: jest.fn().mockResolvedValue({
        ownershipEntityRefs: userId ? [`user:default/${userId}`] : [],
      }),
    };
  }

  function startApp(opts: {
    as: 'user' | 'service' | 'none';
    userId?: string;
    memberships?: Record<string, { role: string }>;
    store?: Partial<Record<string, jest.Mock>>;
  }): Promise<{ base: string; store: Record<string, jest.Mock> }> {
    const store = {
      list: jest.fn().mockResolvedValue([]),
      getByDomain: jest.fn().mockResolvedValue(undefined),
      getById: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      ...opts.store,
    };
    const options = {
      logger: noopLogger,
      store,
      httpAuth: makeHttpAuth(opts.as),
      userInfo: makeUserInfo(opts.userId),
      db: fakeDb(opts.memberships ?? {}),
      isPostgres: false,
    } as unknown as RouterOptions;
    const app = express();
    app.use(createRouter(options));
    return new Promise(resolve => {
      server = app.listen(0, () => {
        resolve({
          base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`,
          store,
        });
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

  // T3: anonymous call rejected before any DB call.
  it('rejects an anonymous GET /domains with 401 before any store call', async () => {
    const { base, store } = await startApp({ as: 'none' });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(401);
    expect(store.list).not.toHaveBeenCalled();
  });

  // T1: member of team gets the unchanged response.
  it('allows a member of the team to list its domains (T1)', async () => {
    const { base, store } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'viewer' } },
    });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(200);
    expect(store.list).toHaveBeenCalledWith('acme', undefined);
  });

  // T2: authenticated non-member is denied without a store call.
  it('denies a non-member GET /domains with 403 (T2)', async () => {
    const { base, store } = await startApp({
      as: 'user',
      userId: 'bob',
      memberships: { 'other-co:bob': { role: 'viewer' } },
    });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(403);
    expect(store.list).not.toHaveBeenCalled();
  });

  // T4: admins-tenant owner succeeds without an acme membership row.
  it('allows an admins-tenant owner to list a team they do not belong to (T4)', async () => {
    const { base } = await startApp({
      as: 'user',
      userId: 'alice',
      memberships: { 'admins:alice': { role: 'owner' } },
    });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(200);
  });

  // T5: non-member POST is denied and nothing is created.
  it('denies POST /domains from a non-member with 403 and no insert (T5)', async () => {
    const { base, store } = await startApp({
      as: 'user',
      userId: 'bob',
      memberships: {},
    });
    const res = await fetch(`${base}/domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: 'acme', service: 'web', domain: 'example.com' }),
    });
    expect(res.status).toBe(403);
    expect(store.create).not.toHaveBeenCalled();
  });

  // POST /domains sets created_by from the authenticated caller, not the body.
  it('forces created_by to the authenticated caller regardless of the request body', async () => {
    const { base, store } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'owner' } },
    });
    const res = await fetch(`${base}/domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team: 'acme',
        service: 'web',
        domain: 'example.com',
        created_by: 'someone-else',
      }),
    });
    expect(res.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ created_by: 'carol' }));
  });

  // T6: non-member verify is denied; no status update happens.
  it('denies POST /domains/:id/verify from a non-member with 403 (T6)', async () => {
    const { base, store } = await startApp({
      as: 'user',
      userId: 'bob',
      memberships: { 'other-co:bob': { role: 'viewer' } },
      store: {
        getById: jest.fn().mockResolvedValue({
          id: 'd1',
          team: 'acme',
          service: 'web',
          domain: 'example.com',
          auto_domain: 'acme-web.mctl.ai',
        }),
      },
    });
    const res = await fetch(`${base}/domains/d1/verify`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(store.updateStatus).not.toHaveBeenCalled();
  });

  // T7: own-tenant delete flow is unchanged.
  it('allows a member to delete their own tenant domain (T7)', async () => {
    const { base, store } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'owner' } },
      store: {
        getById: jest.fn().mockResolvedValue({
          id: 'd1',
          team: 'acme',
          service: 'web',
          domain: 'example.com',
        }),
      },
    });
    const res = await fetch(`${base}/domains/d1`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(store.delete).toHaveBeenCalledWith('d1');
  });

  // T8: existence check ordering preserved — 404 for a missing id.
  it('returns 404 for DELETE of a nonexistent id for an authenticated caller (T8)', async () => {
    const { base } = await startApp({ as: 'user', userId: 'carol', memberships: {} });
    const res = await fetch(`${base}/domains/missing`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // T9: the workflow's service credential activates without any tenant_members row.
  it('allows a service credential to activate with no tenant_members rows at all (T9)', async () => {
    const { base, store } = await startApp({
      as: 'service',
      memberships: {},
      store: {
        getById: jest.fn().mockResolvedValue({
          id: 'd1',
          team: 'acme',
          service: 'web',
          domain: 'example.com',
        }),
      },
    });
    const res = await fetch(`${base}/domains/d1/activate`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(store.updateStatus).toHaveBeenCalledWith('d1', 'active');
  });

  // Same workflow tier applies to GET /domains per the reviewed proposal
  // decision (wft-add-custom-domain.yaml calls both routes).
  it('allows a service credential to list domains without tenant membership', async () => {
    const { base } = await startApp({ as: 'service', memberships: {} });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(200);
  });

  it('denies a non-member user activating another tenant domain', async () => {
    const { base, store } = await startApp({
      as: 'user',
      userId: 'bob',
      memberships: { 'other-co:bob': { role: 'viewer' } },
      store: {
        getById: jest.fn().mockResolvedValue({
          id: 'd1',
          team: 'acme',
          service: 'web',
          domain: 'example.com',
        }),
      },
    });
    const res = await fetch(`${base}/domains/d1/activate`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(store.updateStatus).not.toHaveBeenCalled();
  });
});
