import knexLib, { Knex } from 'knex';
import { TenantStore } from './tenantStore';

function makeStore(knex: Knex): TenantStore {
  const db = { getClient: async () => knex } as any;
  const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any;
  return new TenantStore(db, logger);
}

async function freshStore(): Promise<TenantStore> {
  const knex = knexLib({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
  const store = makeStore(knex);
  await store.init();
  return store;
}

describe('TenantStore.seedMember', () => {
  it('seeds a user into multiple tenants without conflict', async () => {
    const store = await freshStore();
    await store.seedMember('admins', 'mashkovd', 'owner');
    await store.seedMember('ovk', 'mashkovd', 'owner');
    const rows = await store.listMembershipsForUser('mashkovd');
    expect(rows.map(r => r.tenantName).sort()).toEqual(['admins', 'ovk']);
  });

  it('upserts role idempotently within the same tenant', async () => {
    const store = await freshStore();
    await store.seedMember('labs', 'alice', 'developer');
    await store.seedMember('labs', 'alice', 'owner');
    const rows = await store.listMembershipsForUser('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('owner');
  });
});

describe('TenantStore.addMember', () => {
  it('rejects when the user is already in a different tenant', async () => {
    const store = await freshStore();
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
    const store = await freshStore();
    await store.seedMember('ovk', 'carol', 'owner');
    await store.seedMember('admins', 'carol', 'owner');
    const rows = await store.listMembershipsForUser('carol');
    expect(rows.map(r => r.tenantName)).toEqual(['admins', 'ovk']);
  });
});

describe('TenantStore.getMemberByTenant', () => {
  it('returns only the matching tenant row', async () => {
    const store = await freshStore();
    await store.seedMember('admins', 'dave', 'owner');
    await store.seedMember('ovk', 'dave', 'developer');
    expect((await store.getMemberByTenant('admins', 'dave'))?.role).toBe('owner');
    expect((await store.getMemberByTenant('ovk', 'dave'))?.role).toBe('developer');
    expect(await store.getMemberByTenant('labs', 'dave')).toBeUndefined();
  });
});
