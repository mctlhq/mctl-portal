import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import type { Knex } from 'knex';
import { authorizeForTeam, createRouter, isWorkflowCaller, resolveCallerId, RouterOptions } from './router';
import { MctlApiError } from './mctlApiClient';

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
// directly above against authorizeForTeam). The data layer is now a
// DomainsClient (mctl-api gateway) rather than a local CustomDomainStore,
// injected the same way — a plain object of jest mocks via RouterOptions.
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
    domains?: Partial<Record<string, jest.Mock>>;
  }): Promise<{ base: string; domains: Record<string, jest.Mock> }> {
    const domains = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'new-id', status: 'pending' }),
      verify: jest.fn().mockResolvedValue({ verified: false, expected_record: 'x', expected_value: 'y' }),
      remove: jest.fn().mockResolvedValue({ status: 'deleted' }),
      ...opts.domains,
    };
    const options = {
      logger: noopLogger,
      domains,
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
          domains,
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

  // T3: anonymous call rejected before any upstream call.
  it('rejects an anonymous GET /domains with 401 before any upstream call', async () => {
    const { base, domains } = await startApp({ as: 'none' });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(401);
    expect(domains.list).not.toHaveBeenCalled();
  });

  // T1: member of team gets the unchanged response.
  it('allows a member of the team to list its domains (T1)', async () => {
    const { base, domains } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'viewer' } },
    });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(200);
    expect(domains.list).toHaveBeenCalledWith('acme', undefined);
  });

  // T2: authenticated non-member is denied without an upstream call.
  it('denies a non-member GET /domains with 403 (T2)', async () => {
    const { base, domains } = await startApp({
      as: 'user',
      userId: 'bob',
      memberships: { 'other-co:bob': { role: 'viewer' } },
    });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(403);
    expect(domains.list).not.toHaveBeenCalled();
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

  // T5: non-member POST is denied and nothing is created upstream.
  it('denies POST /domains from a non-member with 403 and no upstream create (T5)', async () => {
    const { base, domains } = await startApp({
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
    expect(domains.create).not.toHaveBeenCalled();
  });

  // POST /domains forwards actor as the authenticated caller, not anything
  // spoofable from the request body.
  it('forces the create actor to the authenticated caller regardless of the request body', async () => {
    const { base, domains } = await startApp({
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
    expect(domains.create).toHaveBeenCalledWith(
      expect.objectContaining({ team: 'acme', service: 'web', domain: 'example.com', actor: 'carol' }),
    );
  });

  // T6: non-member verify is denied; no upstream verify call happens.
  it('denies POST /domains/:id/verify from a non-member with 403 (T6)', async () => {
    const { base, domains } = await startApp({
      as: 'user',
      userId: 'bob',
      memberships: { 'other-co:bob': { role: 'viewer' } },
    });
    const res = await fetch(`${base}/domains/d1/verify?team=acme`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(domains.verify).not.toHaveBeenCalled();
  });

  // T7: own-tenant delete flow is unchanged, once the id genuinely appears
  // in that team's own domain list (the ownership check added below).
  it('allows a member to delete their own tenant domain (T7)', async () => {
    const { base, domains } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'owner' } },
      domains: { list: jest.fn().mockResolvedValue([{ id: 'd1', team: 'acme' }]) },
    });
    const res = await fetch(`${base}/domains/d1?team=acme`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(domains.remove).toHaveBeenCalledWith('d1', 'acme');
  });

  // T8: a nonexistent id surfaces mctl-api's own 404 unchanged, once the
  // ownership check itself has already been satisfied (the id is genuinely
  // in the caller's team's list, but mctl-api rejects the delete anyway —
  // e.g. a race where it was already removed).
  it('returns 404 for DELETE of a nonexistent id, per mctl-api\'s own 404 (T8)', async () => {
    const { base } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'owner' } },
      domains: {
        list: jest.fn().mockResolvedValue([{ id: 'missing', team: 'acme' }]),
        remove: jest.fn().mockRejectedValue(new MctlApiError(404, 'domain not found')),
      },
    });
    const res = await fetch(`${base}/domains/missing?team=acme`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  // Cross-tenant IDOR guard: a genuine member of the team they name must
  // still be denied when the id in the URL belongs to a different team's
  // domain. Before this check, authorizeForTeam only proved the caller
  // belongs to the team they *named* — not that they may touch this
  // specific id — and mctl-api's own ?team= check cannot be relied on to
  // catch the mismatch, because this plugin's bearer token is an
  // admin-tier service credential that clears mctl-api's per-team check
  // entirely (see MctlApiDomainsClient's doc comment on `verify`/`remove`).
  it('denies DELETE of an id that does not belong to the caller-supplied team, even for a genuine member of that team', async () => {
    const { base, domains } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'owner' } },
      // carol really is a member of acme, but acme's own domain list does
      // not contain 'team-b-domain' — it belongs to some other team.
      domains: { list: jest.fn().mockResolvedValue([{ id: 'd1', team: 'acme' }]) },
    });
    const res = await fetch(`${base}/domains/team-b-domain?team=acme`, { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(domains.remove).not.toHaveBeenCalled();
  });

  it('denies verify of an id that does not belong to the caller-supplied team, even for a genuine member of that team', async () => {
    const { base, domains } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'owner' } },
      domains: { list: jest.fn().mockResolvedValue([{ id: 'd1', team: 'acme' }]) },
    });
    const res = await fetch(`${base}/domains/team-b-domain/verify?team=acme`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(domains.verify).not.toHaveBeenCalled();
  });

  // Same workflow tier applies to GET /domains per the reviewed proposal
  // decision (wft-add-custom-domain.yaml historically called this route).
  it('allows a service credential to list domains without tenant membership', async () => {
    const { base } = await startApp({ as: 'service', memberships: {} });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(200);
  });

  it('denies a non-member user deleting another tenant domain even with an explicit ?team=', async () => {
    const { base, domains } = await startApp({
      as: 'user',
      userId: 'bob',
      memberships: { 'other-co:bob': { role: 'viewer' } },
    });
    const res = await fetch(`${base}/domains/d1?team=acme`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(domains.remove).not.toHaveBeenCalled();
  });

  it('rejects verify/delete missing the now-required team query param with 400, no upstream call', async () => {
    const { base, domains } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'owner' } },
    });
    const verifyRes = await fetch(`${base}/domains/d1/verify`, { method: 'POST' });
    expect(verifyRes.status).toBe(400);
    const deleteRes = await fetch(`${base}/domains/d1`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(400);
    expect(domains.verify).not.toHaveBeenCalled();
    expect(domains.remove).not.toHaveBeenCalled();
  });

  // T5 (upstream failure gating, distinct from the T5 gating test above):
  // an upstream 5xx/network failure on GET /domains must surface as a
  // readable 502, never a silent 200 with an empty array.
  it('returns 502 (not 200 with an empty array) when mctl-api fails on GET /domains', async () => {
    const { base } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'owner' } },
      domains: { list: jest.fn().mockRejectedValue(new MctlApiError(502, 'mctl-api upstream error 500 at /api/v1/domains')) },
    });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain('mctl-api');
  });

  it('returns 502 when the upstream call throws a plain (non-MctlApiError) failure', async () => {
    const { base } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'owner' } },
      domains: { list: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) },
    });
    const res = await fetch(`${base}/domains?team=acme`);
    expect(res.status).toBe(502);
  });

  // T6: a 409 from mctl-api on POST /domains reaches the caller as 409 with
  // mctl-api's own message, not collapsed into a generic 500.
  it('surfaces an upstream 409 on POST /domains as 409 with mctl-api\'s message', async () => {
    const { base } = await startApp({
      as: 'user',
      userId: 'carol',
      memberships: { 'acme:carol': { role: 'owner' } },
      domains: {
        create: jest.fn().mockRejectedValue(new MctlApiError(409, 'mctl-api 409 at /api/v1/domains: domain already registered')),
      },
    });
    const res = await fetch(`${base}/domains`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: 'acme', service: 'web', domain: 'example.com' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('domain already registered');
  });

  // T7 (activate retirement): the route stays registered but always answers
  // 410 and never reaches the domains client, for either caller tier.
  it.each(['user', 'service'] as const)(
    'POST /domains/:id/activate is retired (410, no client call) for a %s caller',
    async as => {
      const { base, domains } = await startApp({
        as,
        userId: as === 'user' ? 'carol' : undefined,
        memberships: as === 'user' ? { 'acme:carol': { role: 'owner' } } : {},
      });
      const res = await fetch(`${base}/domains/d1/activate`, { method: 'POST' });
      expect(res.status).toBe(410);
      expect(domains.list).not.toHaveBeenCalled();
      expect(domains.create).not.toHaveBeenCalled();
      expect(domains.verify).not.toHaveBeenCalled();
      expect(domains.remove).not.toHaveBeenCalled();
    },
  );
});

// T8 (guard): pins that the store-backed implementation (Node's dns module,
// the custom_domains table) is fully gone from this plugin's source, not
// just from the files this change happened to touch.
describe('gateway migration guard (T8)', () => {
  const srcDir = path.join(__dirname);

  function readAllSources(): string {
    return fs
      .readdirSync(srcDir)
      .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map(f => fs.readFileSync(path.join(srcDir, f), 'utf8'))
      .join('\n');
  }

  it('never imports Node\'s dns module', () => {
    expect(readAllSources()).not.toMatch(/from ['"]dns['"]/);
  });

  it('never references the retired custom_domains table', () => {
    expect(readAllSources()).not.toContain('custom_domains');
  });
});
