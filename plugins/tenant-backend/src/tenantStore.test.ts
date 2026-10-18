import { dirname, join } from 'path';
import { OidcStore } from '../../oidc-provider-backend/src/oidcStore';
import { WorkspaceReadyOutbox } from './workspaceReadyEmail';
import knexLib, { Knex } from 'knex';
import { CustomerHasTenantError, TenantExistsError, TenantStore } from './tenantStore';
import { Tenant } from './types';
import { oidcUserExists } from './membershipLookup';
import { SeedMember } from './memberKeys';

// A login-keyed values.yaml member, as seedMemberOf resolves one.
function byLogin(userId: string, role: string): SeedMember {
  return { userId, role, catalogKey: 'login' };
}

function makeStore(knex: Knex): TenantStore {
  const db = { getClient: async () => knex } as any;
  const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any;
  return new TenantStore(db, logger);
}

function makeTenant(name: string, overrides: Partial<Tenant> = {}): Tenant {
  return {
    name,
    displayName: `${name} display`,
    quotas: {
      'requests.cpu': '1',
      'requests.memory': '1Gi',
      'limits.cpu': '2',
      'limits.memory': '2Gi',
      pods: '10',
    },
    networking: {
      allowIntraNamespace: true,
      allowClusterEgress: false,
      allowInternetEgress: false,
    },
    syncedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}

async function freshStore(): Promise<{ store: TenantStore; knex: Knex }> {
  const knex = knexLib({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
  const store = makeStore(knex);
  await store.init();
  return { store, knex };
}

let currentKnex: Knex | undefined;
afterEach(async () => {
  await currentKnex?.destroy();
  currentKnex = undefined;
});

describe('TenantStore.seedMember', () => {
  it('records a principal-keyed member and reads it back as one', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    const pid = 'prn_01M45DR1GWC87109EH88VBJX25';
    await store.seedMember('bobs', {
      userId: pid.toLowerCase(), role: 'owner', catalogKey: 'principal', principalId: pid, login: 'alice',
    });
    await store.seedMember('labs', byLogin('alice', 'owner'));
    const [bob] = await store.listMembershipsForUser(pid.toLowerCase());
    expect(bob).toEqual(
      expect.objectContaining({ tenantName: 'bobs', catalogKey: 'principal', principalId: pid, login: 'alice' }),
    );
    // The login names only the login-keyed member.
    const byAlice = await store.listMembershipsForUser('alice');
    expect(byAlice.map(m => m.tenantName)).toEqual(['labs']);
    expect(byAlice[0].catalogKey).toBeUndefined();
  });

  it('adds the principal columns to a table created before them', async () => {
    const knex = knexLib({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
    currentKnex = knex;
    await knex.schema.createTable('tenant_members', t => {
      t.string('tenant_name').notNullable();
      t.string('user_id').notNullable();
      t.string('role').notNullable().defaultTo('developer');
      t.timestamp('invited_at').notNullable().defaultTo(knex.fn.now());
      t.string('invited_by').notNullable();
      t.primary(['tenant_name', 'user_id']);
    });
    await knex('tenant_members').insert({ tenant_name: 'labs', user_id: 'alice', role: 'owner', invited_by: 'system' });
    const store = makeStore(knex);
    await store.init();
    await store.init();
    const [alice] = await store.listMembers('labs');
    expect(alice.userId).toBe('alice');
    expect(alice.catalogKey).toBeUndefined();
  });

  it('seeds a user into multiple tenants without conflict', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('admins', byLogin('mashkovd', 'owner'));
    await store.seedMember('ovk', byLogin('mashkovd', 'owner'));
    const rows = await store.listMembershipsForUser('mashkovd');
    expect(rows.map(r => r.tenantName).sort()).toEqual(['admins', 'ovk']);
  });

  it('upserts role idempotently within the same tenant', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('labs', byLogin('alice', 'developer'));
    await store.seedMember('labs', byLogin('alice', 'owner'));
    const rows = await store.listMembershipsForUser('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('owner');
  });
});

describe('TenantStore.addMember', () => {
  it('rejects when the user is already in a different tenant', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('ovk', byLogin('bob', 'developer'));
    await expect(
      store.addMember({
        tenantName: 'labs',
        userId: 'bob',
        role: 'developer',
        invitedAt: new Date().toISOString(),
        invitedBy: 'test',
      }),
    ).rejects.toThrow('already a member');
  });
});

describe('TenantStore.listMembershipsForUser', () => {
  it('returns all rows ordered by tenant_name', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('ovk', byLogin('carol', 'owner'));
    await store.seedMember('admins', byLogin('carol', 'owner'));
    const rows = await store.listMembershipsForUser('carol');
    expect(rows.map(r => r.tenantName)).toEqual(['admins', 'ovk']);
  });
});

describe('TenantStore.getMemberByTenant', () => {
  it('returns only the matching tenant row', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('admins', byLogin('dave', 'owner'));
    await store.seedMember('ovk', byLogin('dave', 'developer'));
    expect((await store.getMemberByTenant('admins', 'dave'))?.role).toBe('owner');
    expect((await store.getMemberByTenant('ovk', 'dave'))?.role).toBe('developer');
    expect(await store.getMemberByTenant('labs', 'dave')).toBeUndefined();
  });
});

describe('TenantStore.upsert', () => {
  it('inserts a new tenant and reads it back', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.upsert(makeTenant('labs', { githubTeam: 'labs-team' }));
    const found = await store.findByName('labs');
    expect(found?.displayName).toBe('labs display');
    expect(found?.githubTeam).toBe('labs-team');
    expect(found?.quotas.pods).toBe('10');
    expect(found?.networking.allowIntraNamespace).toBe(true);
  });

  it('updates mutable fields on conflict without creating a duplicate', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.upsert(makeTenant('labs', { displayName: 'old' }));
    await store.upsert(makeTenant('labs', { displayName: 'new', contactEmail: 'a@b.c' }));
    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].displayName).toBe('new');
    expect(all[0].contactEmail).toBe('a@b.c');
  });
});

describe('TenantStore.listAll / listNames', () => {
  it('orders tenants by name', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.upsert(makeTenant('ovk'));
    await store.upsert(makeTenant('admins'));
    await store.upsert(makeTenant('labs'));
    expect((await store.listAll()).map(t => t.name)).toEqual(['admins', 'labs', 'ovk']);
    expect(await store.listNames()).toEqual(['admins', 'labs', 'ovk']);
  });
});

describe('TenantStore.findByName', () => {
  it('returns undefined for an unknown tenant', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    expect(await store.findByName('nope')).toBeUndefined();
  });
});

describe('TenantStore.delete', () => {
  it('removes the tenant and cascades its members', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.upsert(makeTenant('labs'));
    await store.seedMember('labs', byLogin('eve', 'owner'));
    await store.delete('labs');
    expect(await store.findByName('labs')).toBeUndefined();
    expect(await store.listMembershipsForUser('eve')).toHaveLength(0);
  });
});

describe('TenantStore.addMember', () => {
  it('normalizes userId to lowercase and trims whitespace', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.addMember({
      tenantName: 'labs',
      userId: '  MashkovD  ',
      role: 'developer',
      invitedAt: new Date().toISOString(),
      invitedBy: 'test',
    });
    const rows = await store.listMembershipsForUser('mashkovd');
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('mashkovd');
  });

  it('enforces the one-tenant constraint after normalization', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.addMember({
      tenantName: 'ovk',
      userId: 'frank',
      role: 'developer',
      invitedAt: new Date().toISOString(),
      invitedBy: 'test',
    });
    await expect(
      store.addMember({
        tenantName: 'labs',
        userId: 'FRANK',
        role: 'developer',
        invitedAt: new Date().toISOString(),
        invitedBy: 'test',
      }),
    ).rejects.toThrow('already a member');
  });
});

describe('TenantStore.addMember keying', () => {
  const PID = 'prn_01M45DR1GWC87109EH88VBJX25';

  it('keeps the principal and login when an invite re-adds the member', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('labs', { userId: 'heidi', role: 'owner', catalogKey: 'login', principalId: PID });
    await store.addMember({
      tenantName: 'labs',
      userId: 'heidi',
      role: 'developer',
      invitedAt: new Date().toISOString(),
      invitedBy: 'test',
    });
    const m = await store.getMemberByTenant('labs', 'heidi');
    expect(m).toMatchObject({ role: 'developer', principalId: PID });
  });

  it('rewrites the keying when the caller states it', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('labs', { userId: 'ivan', role: 'owner', catalogKey: 'login' });
    await store.addMember({
      tenantName: 'labs',
      userId: 'ivan',
      role: 'owner',
      invitedAt: new Date().toISOString(),
      invitedBy: 'test',
      catalogKey: 'login',
      principalId: PID,
      login: 'ivan',
    });
    expect((await store.getMemberByTenant('labs', 'ivan'))?.principalId).toBe(PID);
  });
});

describe('TenantStore.createCustomerTenant', () => {
  const PID = 'prn_01M45DR1GWC87109EH88VBJX25';
  const owner = (tenantName: string) => ({
    tenantName,
    userId: PID.toLowerCase(),
    role: 'owner' as const,
    invitedAt: new Date().toISOString(),
    invitedBy: 'system',
    catalogKey: 'principal' as const,
    principalId: PID,
    login: 'alice',
  });

  it('writes the tenant and its principal-keyed owner', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.createCustomerTenant(makeTenant('bobs'), owner('bobs'));
    expect(await store.findByName('bobs')).toBeDefined();
    expect(await store.getMemberByTenant('bobs', PID.toLowerCase())).toMatchObject({
      role: 'owner', catalogKey: 'principal', principalId: PID, login: 'alice',
    });
  });

  it('lets only one of two concurrent requests for a customer through, leaving no second tenant', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    const results = await Promise.allSettled([
      store.createCustomerTenant(makeTenant('first'), owner('first')),
      store.createCustomerTenant(makeTenant('second'), owner('second')),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(CustomerHasTenantError);
    expect((await store.listAll()).map(t => t.name)).toHaveLength(1);
  });

  it('refuses a taken name without touching the tenant that holds it', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.upsert(makeTenant('labs', { displayName: 'Labs' }));
    await expect(store.createCustomerTenant(makeTenant('labs', { displayName: 'Mine' }), owner('labs')))
      .rejects.toBeInstanceOf(TenantExistsError);
    expect((await store.findByName('labs'))?.displayName).toBe('Labs');
    expect(await store.getMemberByTenant('labs', PID.toLowerCase())).toBeUndefined();
  });

  it('refuses seeding a customer into a second tenant', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.createCustomerTenant(makeTenant('first'), owner('first'));
    await expect(
      store.seedMember('second', { userId: PID.toLowerCase(), role: 'owner', catalogKey: 'principal', principalId: PID }),
      // Not toThrow(): the driver's error comes from another realm in the
      // repo-wide run and fails jest's Error check there.
    ).rejects.toHaveProperty('message', expect.stringContaining('UNIQUE constraint failed'));
    // Login-keyed staff may still belong to several tenants.
    await store.seedMember('first', { userId: 'root', role: 'owner', catalogKey: 'login' });
    await store.seedMember('second', { userId: 'root', role: 'owner', catalogKey: 'login' });
  });
});

describe('TenantStore.updateMemberRole / removeMember', () => {
  it('updates a role in place', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('labs', byLogin('grace', 'developer'));
    await store.updateMemberRole('labs', 'grace', 'owner');
    expect((await store.getMemberByTenant('labs', 'grace'))?.role).toBe('owner');
  });

  it('removes only the targeted membership', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('labs', byLogin('heidi', 'developer'));
    await store.seedMember('labs', byLogin('ivan', 'developer'));
    await store.removeMember('labs', 'heidi');
    expect(await store.getMemberByTenant('labs', 'heidi')).toBeUndefined();
    expect((await store.listMembers('labs')).map(m => m.userId)).toEqual(['ivan']);
  });
});

describe('TenantStore.getMemberTenant', () => {
  it('returns the single tenant/role for a user or undefined', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('ovk', byLogin('judy', 'owner'));
    expect(await store.getMemberTenant('judy')).toEqual({ tenantName: 'ovk', role: 'owner' });
    expect(await store.getMemberTenant('nobody')).toBeUndefined();
  });
});

// Postgres only (repo_connections lives in github-app-connect's schema there):
// runs when TENANT_TEST_PG_URL points at a scratch server.
// Use a database of its own: suites run in parallel and drop the same schemas.
const pgUrl = process.env.TENANT_TEST_PG_URL;
(pgUrl ? describe : describe.skip)('TenantStore.delete on Postgres', () => {
  let admin: Knex;
  let knex: Knex;

  beforeEach(async () => {
    admin = knexLib({ client: 'pg', connection: pgUrl });
    await admin.raw('DROP SCHEMA IF EXISTS "github-app-connect" CASCADE');
    await admin.raw('DROP SCHEMA IF EXISTS "tenant-management" CASCADE');
    await admin.raw('CREATE SCHEMA "tenant-management"');
    knex = knexLib({ client: 'pg', connection: pgUrl, searchPath: ['tenant-management'] });
  });

  afterEach(async () => {
    await knex.destroy();
    await admin.destroy();
  });

  it("deletes the tenant's repo connections and only those", async () => {
    await admin.raw('CREATE SCHEMA "github-app-connect"');
    await admin.raw(
      'CREATE TABLE "github-app-connect".repo_connections (team_id text, repo_full_name text, created_by text)',
    );
    await admin.raw(
      `INSERT INTO "github-app-connect".repo_connections VALUES ('nfc', 'a/b', 'sync'), ('labs', 'c/d', 'sync')`,
    );
    const store = makeStore(knex);
    await store.init();
    await store.upsert(makeTenant('nfc'));
    await store.delete('nfc');
    const rows = await admin('repo_connections').withSchema('github-app-connect').select('team_id');
    expect(rows.map(r => r.team_id)).toEqual(['labs']);
    expect(await store.findByName('nfc')).toBeUndefined();
  });

  it('still deletes the tenant when github-app-connect has no table', async () => {
    const store = makeStore(knex);
    await store.init();
    await store.upsert(makeTenant('nfc'));
    await store.delete('nfc');
    expect(await store.findByName('nfc')).toBeUndefined();
  });

  it('removes only customer sessions using installed Backstage migrations and the real OIDC store', async () => {
    for (const schema of ['auth', 'oidc-provider', 'notifications']) {
      await admin.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.raw(`CREATE SCHEMA "${schema}"`);
    }
    const authDb = knexLib({ client: 'pg', connection: pgUrl, searchPath: ['auth'] });
    const notificationsDb = knexLib({ client: 'pg', connection: pgUrl, searchPath: ['notifications'] });
    try {
      const directory = join(dirname(require.resolve('@backstage/plugin-auth-backend/package.json')), 'migrations');
      await authDb.migrate.latest({ directory, schemaName: 'auth' });
      await notificationsDb.migrate.latest({ directory: join(dirname(require.resolve('@backstage/plugin-notifications-backend/package.json')), 'migrations'), schemaName: 'notifications' });
      await notificationsDb('broadcast').insert({ id:'00000000-0000-4000-8000-000000000001', title:'Broadcast', severity:'normal', origin:'test' });
      const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any;
      const oidc = new OidcStore(admin, logger, true);
      await oidc.init();
      const pid = 'prn_01M45DR1GWC87109EH88VBJX25';
      const users = [pid.toLowerCase(), 'alice', 'bob'];
      const future = Date.now() + 60_000;
      for (const user of users) {
        const ref = `user:default/${user}`;
        await notificationsDb('notification').insert({ id: `00000000-0000-4000-8000-${String(users.indexOf(user)+2).padStart(12,'0')}`, user:ref, title:'Private notification', description:'Workspace details', severity:'normal', link:'https://example.test',origin:'test' });
        await notificationsDb('user_settings').insert({ user:ref, channel:'web', origin:'test', enabled:true, settings_key_hash:user });
        await notificationsDb('broadcast_user_status').insert({broadcast_id:'00000000-0000-4000-8000-000000000001',user:ref});
        await authDb('user_info').insert({ user_entity_ref: ref, user_info: '{}', updated_at: new Date(), created_at: new Date() });
        await authDb('offline_sessions').insert({ id: user, user_entity_ref: ref, token_hash: 'test-hash' });
        await authDb('oauth_authorization_sessions').insert({ id: user, user_entity_ref: ref, client_id: 'test-client', redirect_uri: 'https://example.test/callback', response_type: 'code', expires_at: new Date(future) });
        await authDb('oidc_authorization_codes').insert({ code: user, session_id: user, expires_at: new Date(future) });
        // OIDC callbacks only write login keys after oidcUserExists succeeds.
        if (user === pid.toLowerCase()) continue;
        await oidc.saveSession(user, user, future);
        await oidc.saveCode(user, { userId: user, clientId: 'test-client', redirectUri: 'https://example.test/callback', expiresAt: future });
        await oidc.saveAccessToken(user, user, future);
        const session = { userId: user, portalSessionId: user, tenant: 'acme', service: 'web', host: 'example.test', expiresAt: future };
        await oidc.saveForwardAuthSession(user, session);
        await oidc.saveForwardAuthCode(user, { ...session, state: 'test-state', returnPath: '/', sessionExpiresAt: future });
      }
      const store = makeStore(knex); await store.init();
      await store.seedMember('customer', { userId: pid.toLowerCase(), role: 'owner', catalogKey: 'principal', principalId: pid, login: 'charlie' });
      await store.seedMember('staff', byLogin('alice', 'owner'));
      expect(await oidcUserExists(admin, 'charlie')).toBe(false);
      expect(await oidcUserExists(admin, 'ALICE')).toBe(true);
      await store.deleteCustomerSessions(pid);
      await store.deleteCustomerSessions(pid);
      for (const table of ['offline_sessions', 'user_info', 'oauth_authorization_sessions']) {
        const rows = await authDb(table).orderBy('user_entity_ref').select('user_entity_ref');
        expect(rows).toEqual([{ user_entity_ref: 'user:default/alice' }, { user_entity_ref: 'user:default/bob' }]);
      }
      expect(await authDb('oidc_authorization_codes').orderBy('session_id').select('session_id')).toEqual([{ session_id: 'alice' }, { session_id: 'bob' }]);
      for (const table of ['oidc_sessions', 'oidc_codes', 'oidc_access_tokens', 'oidc_forward_auth_codes', 'oidc_forward_auth_sessions']) {
        expect(await admin(table).withSchema('oidc-provider').orderBy('user_id').select('user_id')).toEqual([{ user_id: 'alice' }, { user_id: 'bob' }]);
      }
      for (const table of ['notification', 'user_settings', 'broadcast_user_status']) {
        expect(await notificationsDb(table).orderBy('user').select('user')).toEqual([{user:'user:default/alice'},{user:'user:default/bob'}]);
      }
      await authDb.schema.dropTable('user_info');
      await expect(store.deleteCustomerSessions(pid)).rejects.toThrow('Unsupported session schema');
    } finally { await authDb.destroy(); await notificationsDb.destroy(); }
  });

  it('serializes ready-email work with deletion and refuses stale post-delete preparation', async () => {
    const store = makeStore(knex);
    await store.init();
    await store.upsert(makeTenant('acme'));
    const pid = 'prn_01M45DR1GWC87109EH88VBJX25';
    await store.seedMember('acme', { userId: pid.toLowerCase(), principalId: pid, login: 'alice', catalogKey: 'principal', role: 'owner' });
    const outbox = new WorkspaceReadyOutbox(knex);
    await outbox.init();
    const access = { tenant: 'acme', principalId: pid, account: 'alice@mctl.ai', role: 'owner', observedAt: new Date().toISOString(), status: 'ready', environments: [], capabilities: [], mcp: 'blocked', accessUrl: 'https://app.mctl.ai/workspace/access' } as any;
    const blocker = await knex.transaction();
    await blocker.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['tenant-lifecycle|acme']);
    let settled = false;
    const preparation = outbox.prepare(access, 'alice@example.com').then(id => { settled = true; return id; });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    await blocker.commit();
    const id = await preparation;
    const delivery = await outbox.claim(id, Date.now());
    expect(delivery).toBeDefined();
    await expect(store.delete('acme')).rejects.toThrow('in flight');
    await outbox.finish(delivery!, 'provider-id', Date.now());
    await store.delete('acme');
    await outbox.prepare(access, 'alice@example.com');
    expect(await outbox.claim(id, Date.now())).toBeUndefined();
    const row = await knex('workspace_ready_emails').where({ id }).first();
    expect(row.recipient).toBe('');
    expect(row.payload).toBe('{}');
  });

  it('keeps the tenant when the connection cleanup fails', async () => {
    await admin.raw('CREATE SCHEMA "github-app-connect"');
    // A table without team_id makes the cleanup fail with something other than 42P01.
    await admin.raw('CREATE TABLE "github-app-connect".repo_connections (other text)');
    const store = makeStore(knex);
    await store.init();
    await store.upsert(makeTenant('nfc'));
    await expect(store.delete('nfc')).rejects.toThrow();
    expect(await store.findByName('nfc')).toBeDefined();
  });
});

it('preserves private contact data when GitOps sync omits it', async () => {
  const { store, knex } = await freshStore();
  currentKnex = knex;
  await store.upsert(makeTenant('acme', { contactEmail: 'owner@example.com' }));
  await store.upsert(makeTenant('acme', { displayName: 'Synced name' }));
  expect(await store.findByName('acme')).toEqual(expect.objectContaining({ contactEmail: 'owner@example.com', displayName: 'Synced name' }));
  await store.upsert(makeTenant('acme', { contactEmail: 'corrected@example.com' }));
  expect((await store.findByName('acme'))?.contactEmail).toBe('corrected@example.com');
});


describe('TenantStore.delete notification cleanup', () => {
  async function prepared() {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.upsert(makeTenant('acme'));
    await store.seedMember('acme', byLogin('alice', 'owner'));
    await knex.schema.createTable('workspace_ready_emails', table => {
      table.string('id').primary(); table.string('tenant_name'); table.string('status');
      table.string('recipient'); table.text('snapshot'); table.text('payload');
      table.bigInteger('lease_until_ms').nullable(); table.string('lease_token').nullable();
    });
    for (const tenant of ['acme', 'other']) await knex('workspace_ready_emails').insert({
      id: tenant, tenant_name: tenant, status: 'pending', recipient: `${tenant}@example.com`,
      snapshot: '{"private":true}', payload: '{"private":true}',
    });
    return { store, knex };
  }

  it('cancels old deliveries, erases message/contact data, and preserves other tenants', async () => {
    const { store, knex } = await prepared();
    await store.delete('acme');
    await store.delete('acme');
    expect(await store.findByName('acme')).toBeUndefined();
    expect(await store.listMembershipsForUser('alice')).toEqual([]);
    expect(await knex('workspace_ready_emails').where({ id: 'acme' }).first()).toMatchObject({
      status: 'cancelled', recipient: '', snapshot: '{}', payload: '{}',
    });
    expect(await knex('workspace_ready_emails').where({ id: 'other' }).first()).toMatchObject({
      status: 'pending', recipient: 'other@example.com',
    });
  });

  it('leaves membership and payload intact while a send is in flight, then retries', async () => {
    const { store, knex } = await prepared();
    await knex('workspace_ready_emails').where({ id: 'acme' }).update({ lease_until_ms: Date.now() + 60_000 });
    await expect(store.delete('acme')).rejects.toThrow('in flight');
    expect(await store.findByName('acme')).toBeDefined();
    expect(await store.listMembershipsForUser('alice')).toHaveLength(1);
    expect((await knex('workspace_ready_emails').where({ id: 'acme' }).first()).recipient).toBe('acme@example.com');
    await knex('workspace_ready_emails').where({ id: 'acme' }).update({ lease_until_ms: null });
    await store.delete('acme');
    expect(await store.findByName('acme')).toBeUndefined();
  });
});


it('freezes name reuse until cleanup completes and cannot release a replacement freeze', async () => {
  const {store,knex}=await freshStore();currentKnex=knex;
  const pid='prn_01M45DR1GWC87109EH88VBJX25';
  await store.createCustomerTenant(makeTenant('frozen'),{ tenantName:'frozen',userId:pid.toLowerCase(),principalId:pid,login:'alice',catalogKey:'principal',role:'owner',invitedAt:new Date().toISOString(),invitedBy:'test' });
  await store.freezeCustomerDeletion('frozen',pid,'alice');
  await store.freezeCustomerDeletion('frozen',pid,'alice');
  expect(await store.isTenantDeleting('frozen')).toBe(true);
  await expect(store.releaseCustomerDeletion('frozen',pid)).rejects.toThrow('still exists');
  await store.delete('frozen');
  await expect(store.createCustomerTenant(makeTenant('frozen'),{ tenantName:'frozen',userId:'bob',role:'owner',catalogKey:'login',invitedAt:new Date().toISOString(),invitedBy:'test' })).rejects.toThrow('deletion is in progress');
  await expect(store.releaseCustomerDeletion('frozen',pid)).rejects.toThrow('receipt');
  await store.markCustomerDeletionClean('frozen',pid);
  await store.releaseCustomerDeletion('frozen',pid);
  const next='prn_01M45DR1GWC87109EH88VBJX26';
  await store.createCustomerTenant(makeTenant('frozen'),{ tenantName:'frozen',userId:next.toLowerCase(),principalId:next,login:'bob',catalogKey:'principal',role:'owner',invitedAt:new Date().toISOString(),invitedBy:'test' });
  await store.freezeCustomerDeletion('frozen',next,'bob');
  await store.releaseCustomerDeletion('frozen',pid);
  expect(await store.assertCustomerDeletion('frozen',pid)).toBe('complete');
  expect(await store.isTenantDeleting('frozen')).toBe(true);
});


it('does not treat a completed marker without a private cleanup receipt as clean', async () => {
 const {store,knex}=await freshStore();currentKnex=knex;
 const pid='prn_01M45DR1GWC87109EH88VBJX25';
 await knex('customer_deletions').insert({tenant_name:'missing-receipt',principal_id:pid,status:'complete'});
 await expect(store.assertCustomerDeletion('missing-receipt',pid)).rejects.toThrow('receipt');
 await expect(store.releaseCustomerDeletion('missing-receipt',pid)).rejects.toThrow('receipt');
});
