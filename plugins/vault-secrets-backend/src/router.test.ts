import type { Knex } from 'knex';
import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import fetch from 'node-fetch';
import {
  SLUG_RE,
  auditSecretRead,
  checkTenantRole,
  createRouter,
  databaseVaultPath,
  escapeHtml,
  renderOpenClawIntakePage,
  renderOpenClawSavedPage,
  RouterOptions,
  secretsVaultPath,
  vaultFetch,
} from './router';
import { staticTokenProvider } from './vaultAuth';

jest.mock('node-fetch', () => jest.fn());

const fetchMock = fetch as unknown as jest.Mock;

// team/service are interpolated into the intake HTML pages. These tests guard
// the two layers that prevent reflected XSS there: the kebab-case slug gate
// (rejected with 400 in both intake handlers) and the HTML escaping applied
// inside the render functions.
describe('SLUG_RE (intake slug validation)', () => {
  it.each(['labs', 'my-service', 'a', 'svc-2', 'a'.repeat(31)])(
    'accepts valid kebab-case slug %p',
    slug => {
      expect(SLUG_RE.test(slug)).toBe(true);
    },
  );

  it.each([
    '',
    'Labs', // uppercase
    '-labs', // leading hyphen
    'my_service', // underscore
    'a'.repeat(32), // too long
    'team/../other', // path traversal
    '"><script>alert(1)</script>', // XSS payload
    "x' onmouseover='alert(1)", // attribute breakout
    'team name', // whitespace
  ])('rejects invalid slug %p', slug => {
    expect(SLUG_RE.test(slug)).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('encodes all five HTML-significant characters', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes & first so entities are not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('leaves plain slugs untouched', () => {
    expect(escapeHtml('my-service')).toBe('my-service');
  });
});

// checkTenantRole gates 4 routes in this file: GET/POST /openclaw/intake
// (minimumRole 'owner') and, via requireTenantRole, GET .../database and
// GET .../secrets (minimumRole 'viewer'). This exercises the admin bypass
// added for platform admins (owner role in the 'admins' tenant), who should
// pass regardless of their membership in the target team.
describe('checkTenantRole (admin bypass)', () => {
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

  it('grants an admins-tenant owner access to a team they are not a member of', async () => {
    const db = fakeDb({ 'admins:alice': { role: 'owner' } });
    const result = await checkTenantRole(db, false, 'nfc', 'alice', 'viewer');
    expect(result).toEqual({
      ok: true,
      userId: 'alice',
      role: 'owner',
      viaAdminBypass: true,
    });
  });

  it('marks a genuine team member as not having used the bypass', async () => {
    const db = fakeDb({ 'nfc:carol': { role: 'viewer' } });
    const result = await checkTenantRole(db, false, 'nfc', 'carol', 'viewer');
    expect(result).toEqual({
      ok: true,
      userId: 'carol',
      role: 'viewer',
      viaAdminBypass: false,
    });
  });

  it('still denies a non-admin who is not a member of the team', async () => {
    const db = fakeDb({});
    const result = await checkTenantRole(db, false, 'nfc', 'bob', 'viewer');
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Access denied: not a member of team 'nfc'",
    });
  });

  // meetsMinimumRole / ROLE_RANK: viewer < developer < owner. These pin the
  // three-tier model documented in plugins/tenant-backend/src/types.ts:64
  // and used by the /database, /database/reveal, /secrets and
  // /secrets/reveal routes' minimumRole checks.
  it('lets a developer-role member pass a developer minimum', async () => {
    const db = fakeDb({ 'nfc:dave': { role: 'developer' } });
    const result = await checkTenantRole(db, false, 'nfc', 'dave', 'developer');
    expect(result).toEqual({
      ok: true,
      userId: 'dave',
      role: 'developer',
      viaAdminBypass: false,
    });
  });

  it('denies a viewer-role member a developer minimum', async () => {
    const db = fakeDb({ 'nfc:carol': { role: 'viewer' } });
    const result = await checkTenantRole(db, false, 'nfc', 'carol', 'developer');
    expect(result).toEqual({
      ok: false,
      status: 403,
      error: "Access denied: developer role required for team 'nfc'",
    });
  });

  it('lets an owner-role member pass every minimum, including developer', async () => {
    const db = fakeDb({ 'nfc:erin': { role: 'owner' } });
    const result = await checkTenantRole(db, false, 'nfc', 'erin', 'developer');
    expect(result).toEqual({
      ok: true,
      userId: 'erin',
      role: 'owner',
      viaAdminBypass: false,
    });
  });

  it('resolves the admin bypass to owner rank regardless of minimumRole', async () => {
    const db = fakeDb({ 'admins:alice': { role: 'owner' } });
    const viaViewer = await checkTenantRole(db, false, 'nfc', 'alice', 'viewer');
    const viaDeveloper = await checkTenantRole(db, false, 'nfc', 'alice', 'developer');
    const viaOwner = await checkTenantRole(db, false, 'nfc', 'alice', 'owner');
    expect(viaViewer).toEqual({ ok: true, userId: 'alice', role: 'owner', viaAdminBypass: true });
    expect(viaDeveloper).toEqual({ ok: true, userId: 'alice', role: 'owner', viaAdminBypass: true });
    expect(viaOwner).toEqual({ ok: true, userId: 'alice', role: 'owner', viaAdminBypass: true });
  });
});

// The /database route spent its whole life reading platform/teams/<team>/<app>/
// database, a prefix nothing ever wrote — provision-database writes to
// teams/<team>/<app>/database. These pin both paths to what the platform
// actually stores so the prefix can't creep back in.
describe('Vault KV paths', () => {
  it('builds the database path provision-database writes to', () => {
    expect(databaseVaultPath('nfc', 'quirestack-api')).toBe(
      'teams/nfc/quirestack-api/database',
    );
  });

  it('builds the service secrets path', () => {
    expect(secretsVaultPath('nfc', 'quirestack-api')).toBe('teams/nfc/quirestack-api');
  });

  it('never prefixes either path with platform/', () => {
    expect(databaseVaultPath('labs', 'mctl-telegram')).not.toMatch(/^platform\//);
    expect(secretsVaultPath('labs', 'mctl-telegram')).not.toMatch(/^platform\//);
  });

  it('keeps the database path under the secrets path, as the Vault policy assumes', () => {
    // vault-policy-backstage-teams-rw.hcl grants teams/+/+ and teams/+/+/*;
    // the database path must be a child of the service path to be covered.
    expect(
      databaseVaultPath('nfc', 'quirestack-api').startsWith(
        `${secretsVaultPath('nfc', 'quirestack-api')}/`,
      ),
    ).toBe(true);
  });
});

// Both credential routes hand out live secrets, and since the admin bypass
// landed a platform admin can read them for a tenant they don't belong to.
// The audit line is the only trace that read ever happened.
describe('auditSecretRead', () => {
  const fakeLogger = () => ({ info: jest.fn() } as any);

  it('records who read which tenant/service, flagging the admin bypass', () => {
    const logger = fakeLogger();
    auditSecretRead(logger, 'database', 'nfc', 'quirestack-api', {
      userId: 'alice',
      role: 'owner',
      viaAdminBypass: true,
    });
    expect(logger.info).toHaveBeenCalledWith(
      'vault-secrets read',
      expect.objectContaining({
        audit: 'secret_read',
        kind: 'database',
        team: 'nfc',
        app: 'quirestack-api',
        user: 'alice',
        via_admin_bypass: true,
      }),
    );
  });

  it('marks a genuine member read as not a bypass', () => {
    const logger = fakeLogger();
    auditSecretRead(logger, 'database', 'nfc', 'quirestack-api', {
      userId: 'carol',
      role: 'viewer',
      viaAdminBypass: false,
    });
    expect(logger.info).toHaveBeenCalledWith(
      'vault-secrets read',
      expect.objectContaining({ via_admin_bypass: false }),
    );
  });

  it('records secret key names but never values', () => {
    const logger = fakeLogger();
    auditSecretRead(
      logger,
      'secrets',
      'nfc',
      'quirestack-api',
      { userId: 'alice', role: 'owner', viaAdminBypass: true },
      ['BETTER_AUTH_SECRET'],
    );
    const meta = logger.info.mock.calls[0][1];
    expect(meta.secret_keys).toBe('BETTER_AUTH_SECRET');
    // Pin the exact payload shape: anything added here later is a deliberate
    // decision, not an accidental secret value riding along in the audit log.
    expect(Object.keys(meta).sort()).toEqual([
      'app',
      'audit',
      'kind',
      'role',
      'secret_keys',
      'team',
      'user',
      'via_admin_bypass',
    ]);
  });

  // The /secrets route answers 200 {} when the Vault path is absent, passing
  // Object.keys({}) here. That read still happened and still has to be
  // auditable — an empty key list must not collapse into "no secret_keys
  // field", which is how the database route signals something different.
  it('still records a read that returned no secrets at all', () => {
    const logger = fakeLogger();
    auditSecretRead(
      logger,
      'secrets',
      'nfc',
      'quirestack-api',
      { userId: 'alice', role: 'owner', viaAdminBypass: true },
      [],
    );
    const meta = logger.info.mock.calls[0][1];
    expect(meta).toHaveProperty('secret_keys', '');
    expect(meta.via_admin_bypass).toBe(true);
  });

  it('omits secret_keys for the database route', () => {
    const logger = fakeLogger();
    auditSecretRead(logger, 'database', 'nfc', 'quirestack-api', {
      userId: 'alice',
      role: 'owner',
      viaAdminBypass: false,
    });
    expect(logger.info.mock.calls[0][1]).not.toHaveProperty('secret_keys');
  });

  // The masked base routes (/database, /secrets) log a distinct '*-meta' kind
  // from the /reveal routes' plaintext kind, so an audit trail can tell a
  // metadata read apart from an actual credential disclosure.
  it.each([
    ['database-meta', undefined],
    ['secrets-meta', []],
  ] as const)('records the %s kind for a masked read', (kind, secretKeys) => {
    const logger = fakeLogger();
    auditSecretRead(
      logger,
      kind,
      'nfc',
      'quirestack-api',
      { userId: 'alice', role: 'viewer', viaAdminBypass: false },
      secretKeys as string[] | undefined,
    );
    expect(logger.info.mock.calls[0][1]).toMatchObject({ kind });
  });
});

// End-to-end route tests: a real express app wired with createRouter, driven
// with the platform's own fetch (no supertest — this mirrors the pattern in
// plugins/tenant-backend/src/router.test.ts). httpAuth/userInfo are stubbed
// to resolve a fixed userId; tenant role comes from the fake Knex db, and
// Vault responses come from the module-level node-fetch mock.
describe('database and secrets routes (masked vs. reveal)', () => {
  const noopLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(),
  };
  noopLogger.child.mockReturnValue(noopLogger);

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

  let server: Server | undefined;

  function startApp(role: string): Promise<string> {
    const options = {
      logger: noopLogger,
      httpAuth: { credentials: jest.fn().mockResolvedValue({ principal: { type: 'user' } }) },
      userInfo: {
        getUserInfo: jest.fn().mockResolvedValue({
          ownershipEntityRefs: ['user:default/dave'],
        }),
      },
      db: fakeDb({ 'nfc:dave': { role } }),
      isPostgres: false,
      vaultAddr: 'https://vault.example',
      vaultTokens: staticTokenProvider('s.tok'),
      oidcLoginUrl: 'https://app.mctl.ai/oidc/login',
      backendBaseUrl: 'https://app.mctl.ai',
    } as unknown as RouterOptions;
    const app = express();
    app.use(createRouter(options));
    return new Promise(resolve => {
      server = app.listen(0, () => {
        resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`);
      });
    });
  }

  function mockVaultKV(data: Record<string, string> | undefined) {
    fetchMock.mockResolvedValue(
      data === undefined
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => ({ data: { data } }) },
    );
  }

  beforeEach(() => fetchMock.mockReset());

  afterEach(done => {
    if (server) {
      server.close(() => done());
      server = undefined;
    } else {
      done();
    }
  });

  it('GET /database: viewer gets 200 with no password field and hasPassword computed', async () => {
    mockVaultKV({ host: 'h', port: '5432', database: 'd', username: 'u', password: 'p' });
    const base = await startApp('viewer');
    const res = await globalThis.fetch(`${base}/teams/nfc/quirestack-api/database`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ host: 'h', port: '5432', database: 'd', username: 'u', hasPassword: true });
    expect(body).not.toHaveProperty('password');
  });

  it('GET /database/reveal: developer gets 200 with plaintext password', async () => {
    mockVaultKV({ host: 'h', port: '5432', database: 'd', username: 'u', password: 'p' });
    const base = await startApp('developer');
    const res = await globalThis.fetch(`${base}/teams/nfc/quirestack-api/database/reveal`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ host: 'h', port: '5432', database: 'd', username: 'u', password: 'p' });
  });

  it('GET /database/reveal: viewer gets 403 with no secret value in the body', async () => {
    mockVaultKV({ host: 'h', port: '5432', database: 'd', username: 'u', password: 'p' });
    const base = await startApp('viewer');
    const res = await globalThis.fetch(`${base}/teams/nfc/quirestack-api/database/reveal`);
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).not.toContain('p"');
    expect(text).not.toContain('password');
  });

  it('GET /secrets: viewer gets 200 with secretKeys only, no plaintext', async () => {
    mockVaultKV({ API_KEY: 'super-secret', DATABASE_PASSWORD: 'hunter2' });
    const base = await startApp('viewer');
    const res = await globalThis.fetch(`${base}/teams/nfc/quirestack-api/secrets`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ secretKeys: ['API_KEY', 'DATABASE_PASSWORD'] });
    expect(JSON.stringify(body)).not.toContain('super-secret');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('GET /secrets/reveal: developer gets 200 with plaintext secrets map', async () => {
    mockVaultKV({ API_KEY: 'super-secret' });
    const base = await startApp('developer');
    const res = await globalThis.fetch(`${base}/teams/nfc/quirestack-api/secrets/reveal`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ secrets: { API_KEY: 'super-secret' } });
  });

  it('GET /secrets/reveal: viewer gets 403', async () => {
    mockVaultKV({ API_KEY: 'super-secret' });
    const base = await startApp('viewer');
    const res = await globalThis.fetch(`${base}/teams/nfc/quirestack-api/secrets/reveal`);
    const text = await res.text();
    expect(res.status).toBe(403);
    expect(text).not.toContain('super-secret');
  });

  // Express decodes each path segment, so `..%2Fteam-b%2Fvictim` reaches the
  // handler as the single param value `../team-b/victim`. requireTenantRole
  // only ever checks `team`, so a legitimate nfc member passed RBAC and the
  // dot-segments were then spliced into the Vault URL, where WHATWG URL
  // normalisation collapsed them onto another tenant's path. Guard: any
  // non-slug team/app is a 400 before authorisation or any Vault call.
  it('GET /secrets/reveal: a traversal-encoded app escapes no tenant boundary (400, no Vault call)', async () => {
    mockVaultKV({ API_KEY: 'super-secret' });
    const base = await startApp('developer');
    const res = await globalThis.fetch(
      `${base}/teams/nfc/..%2Fvictim-team%2Fvictim-app/secrets/reveal`,
    );
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).not.toContain('super-secret');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /database: a traversal-encoded team is rejected before the role lookup', async () => {
    mockVaultKV({ host: 'h', port: '5432', database: 'd', username: 'u', password: 'p' });
    const base = await startApp('viewer');
    const res = await globalThis.fetch(
      `${base}/teams/..%2Fvictim-team/quirestack-api/database`,
    );
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /database/reveal: uppercase and over-long slugs are rejected too', async () => {
    mockVaultKV({ host: 'h', port: '5432', database: 'd', username: 'u', password: 'p' });
    const base = await startApp('developer');
    for (const app of ['Quirestack-API', 'a'.repeat(32), '-leading-dash']) {
      const res = await globalThis.fetch(
        `${base}/teams/nfc/${encodeURIComponent(app)}/database/reveal`,
      );
      expect(res.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET /secrets: reports an empty secretKeys array when nothing is stored (no plaintext {} confusion)', async () => {
    mockVaultKV(undefined);
    const base = await startApp('viewer');
    const res = await globalThis.fetch(`${base}/teams/nfc/quirestack-api/secrets`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ secretKeys: [] });
  });
});

// A revoked Vault token used to be terminal: the plugin held one string for
// the process lifetime, so every route 500'd until someone minted a new token
// and restarted the pod. vaultFetch is what makes that self-healing.
describe('vaultFetch (token refresh on rejection)', () => {
  const ok = { ok: true, status: 200, json: async () => ({}) };
  const denied = (status: number) => ({ ok: false, status, json: async () => ({}) });

  beforeEach(() => fetchMock.mockReset());

  it('sends the provider token and does not retry a successful call', async () => {
    fetchMock.mockResolvedValue(ok);
    const tokens = staticTokenProvider('s.tok');

    await vaultFetch('https://vault.example', tokens, 'teams/nfc/api');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vault.example/v1/secret/data/teams/nfc/api',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'X-Vault-Token': 's.tok' }),
      }),
    );
  });

  it.each([401, 403])('invalidates and retries once on HTTP %i', async status => {
    fetchMock.mockResolvedValueOnce(denied(status)).mockResolvedValueOnce(ok);
    const tokens = staticTokenProvider('s.tok');
    const invalidate = jest.spyOn(tokens, 'invalidate');

    const resp = await vaultFetch('https://vault.example', tokens, 'teams/nfc/api');

    // Scoped to the token that was actually rejected, so a request that
    // already refreshed keeps its fresh one.
    expect(invalidate).toHaveBeenCalledWith('s.tok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resp.ok).toBe(true);
  });

  it('propagates a login failure raised while retrying', async () => {
    fetchMock.mockResolvedValueOnce(denied(403));
    const tokens = {
      getToken: jest
        .fn()
        .mockResolvedValueOnce('s.dead')
        .mockRejectedValueOnce(new Error('Vault k8s auth failed')),
      invalidate: jest.fn(),
    };

    await expect(
      vaultFetch('https://vault.example', tokens, 'teams/nfc/api'),
    ).rejects.toThrow('Vault k8s auth failed');
    // The route's own try/catch turns this into a 500 — the point is that it
    // surfaces rather than hanging or being swallowed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries only once, so a real policy denial still surfaces', async () => {
    fetchMock.mockResolvedValue(denied(403));
    const resp = await vaultFetch(
      'https://vault.example',
      staticTokenProvider('s.tok'),
      'teams/nfc/api',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(resp.status).toBe(403);
  });

  it('does not retry a 404, which means the path is absent, not the token bad', async () => {
    fetchMock.mockResolvedValue(denied(404));
    const tokens = staticTokenProvider('s.tok');
    const invalidate = jest.spyOn(tokens, 'invalidate');

    await vaultFetch('https://vault.example', tokens, 'teams/nfc/api');

    expect(invalidate).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a JSON body and content-type for writes', async () => {
    fetchMock.mockResolvedValue(ok);
    await vaultFetch(
      'https://vault.example',
      staticTokenProvider('s.tok'),
      'teams/nfc/api/telegram',
      { method: 'POST', body: JSON.stringify({ data: { k: 'v' } }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://vault.example/v1/secret/data/teams/nfc/api/telegram',
      expect.objectContaining({
        method: 'POST',
        body: '{"data":{"k":"v"}}',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    );
  });

  it('omits a content-type on reads', async () => {
    fetchMock.mockResolvedValue(ok);
    await vaultFetch('https://vault.example', staticTokenProvider('s.tok'), 'teams/nfc/api');
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Content-Type');
  });
});

describe('intake page rendering', () => {
  const payload = '"><script>alert(1)</script>';

  it('does not reflect raw markup from team/service/returnTo into the intake page', () => {
    const html = renderOpenClawIntakePage(payload, payload, `/x?a=${payload}`);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does not reflect raw markup into the saved page', () => {
    const html = renderOpenClawSavedPage(payload, payload);
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders valid slugs verbatim in both pages', () => {
    expect(renderOpenClawIntakePage('labs', 'my-svc', '')).toContain('labs/my-svc');
    expect(renderOpenClawSavedPage('labs', 'my-svc')).toContain('labs/my-svc');
  });
});
