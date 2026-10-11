import knexLib, { Knex } from 'knex';
import { TenantStore } from './tenantStore';
import { Tenant } from './types';

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
  it('seeds a user into multiple tenants without conflict', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('admins', 'mashkovd', 'owner');
    await store.seedMember('ovk', 'mashkovd', 'owner');
    const rows = await store.listMembershipsForUser('mashkovd');
    expect(rows.map(r => r.tenantName).sort()).toEqual(['admins', 'ovk']);
  });

  it('upserts role idempotently within the same tenant', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('labs', 'alice', 'developer');
    await store.seedMember('labs', 'alice', 'owner');
    const rows = await store.listMembershipsForUser('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('owner');
  });
});

describe('TenantStore.addMember', () => {
  it('rejects when the user is already in a different tenant', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('ovk', 'bob', 'developer');
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
    await store.seedMember('ovk', 'carol', 'owner');
    await store.seedMember('admins', 'carol', 'owner');
    const rows = await store.listMembershipsForUser('carol');
    expect(rows.map(r => r.tenantName)).toEqual(['admins', 'ovk']);
  });
});

describe('TenantStore.getMemberByTenant', () => {
  it('returns only the matching tenant row', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('admins', 'dave', 'owner');
    await store.seedMember('ovk', 'dave', 'developer');
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
    await store.seedMember('labs', 'eve', 'owner');
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

describe('TenantStore.updateMemberRole / removeMember', () => {
  it('updates a role in place', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('labs', 'grace', 'developer');
    await store.updateMemberRole('labs', 'grace', 'owner');
    expect((await store.getMemberByTenant('labs', 'grace'))?.role).toBe('owner');
  });

  it('removes only the targeted membership', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('labs', 'heidi', 'developer');
    await store.seedMember('labs', 'ivan', 'developer');
    await store.removeMember('labs', 'heidi');
    expect(await store.getMemberByTenant('labs', 'heidi')).toBeUndefined();
    expect((await store.listMembers('labs')).map(m => m.userId)).toEqual(['ivan']);
  });
});

describe('TenantStore.getMemberTenant', () => {
  it('returns the single tenant/role for a user or undefined', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.seedMember('ovk', 'judy', 'owner');
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
