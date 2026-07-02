import knexLib, { Knex } from 'knex';
import { OidcStore } from './oidcStore';

function makeStore(knex: Knex): OidcStore {
  const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any;
  return new OidcStore(knex, logger, false);
}

let currentKnex: Knex | undefined;
afterEach(async () => {
  await currentKnex?.destroy();
  currentKnex = undefined;
});

async function freshStore(): Promise<{ store: OidcStore; knex: Knex }> {
  const knex = knexLib({
    client: 'better-sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
  });
  const store = makeStore(knex);
  await store.init();
  return { store, knex };
}

describe('OidcStore.init', () => {
  it('is idempotent when called twice', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await expect(store.init()).resolves.toBeUndefined();
  });
});

describe('OidcStore authorization codes', () => {
  it('round-trips a code with all fields', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.saveCode('c1', {
      userId: 'mashkovd',
      clientId: 'client-a',
      redirectUri: 'https://app/cb',
      expiresAt: 123,
      nonce: 'n1',
    });
    expect(await store.consumeCode('c1')).toEqual({
      userId: 'mashkovd',
      clientId: 'client-a',
      redirectUri: 'https://app/cb',
      expiresAt: 123,
      nonce: 'n1',
    });
  });

  it('is single-use: a second consume returns undefined', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.saveCode('c2', {
      userId: 'u',
      clientId: 'c',
      redirectUri: 'r',
      expiresAt: 1,
    });
    expect(await store.consumeCode('c2')).toBeDefined();
    expect(await store.consumeCode('c2')).toBeUndefined();
  });

  it('returns undefined for an unknown code', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    expect(await store.consumeCode('missing')).toBeUndefined();
  });

  it('normalizes a missing nonce to undefined', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.saveCode('c3', {
      userId: 'u',
      clientId: 'c',
      redirectUri: 'r',
      expiresAt: 1,
    });
    expect((await store.consumeCode('c3'))?.nonce).toBeUndefined();
  });
});

describe('OidcStore sessions', () => {
  it('round-trips a session', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.saveSession('s1', 'mashkovd', 999);
    expect(await store.getSession('s1')).toEqual({ userId: 'mashkovd', expiresAt: 999 });
  });

  it('returns undefined for an unknown session', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    expect(await store.getSession('nope')).toBeUndefined();
  });
});

describe('OidcStore pending auths', () => {
  it('round-trips and is single-use', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.savePendingAuth('state-1', '/return/here', 555);
    expect(await store.consumePendingAuth('state-1')).toEqual({
      returnTo: '/return/here',
      expiresAt: 555,
    });
    expect(await store.consumePendingAuth('state-1')).toBeUndefined();
  });
});

describe('OidcStore access tokens', () => {
  it('round-trips an access token', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    await store.saveAccessToken('t1', 'mashkovd', 777);
    expect(await store.getAccessToken('t1')).toEqual({ userId: 'mashkovd', expiresAt: 777 });
  });

  it('returns undefined for an unknown token', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    expect(await store.getAccessToken('nope')).toBeUndefined();
  });
});

// OidcStore is a persistence layer: reads return the stored row (including its
// expiresAt) regardless of whether it is past due. Expiry is enforced by callers
// in router.ts (e.g. consumeCode at :479, getAccessToken at :532, getSession at
// :229/:563). These tests pin that contract so the responsibility boundary stays
// explicit; cleanupExpired() is the mechanism that eventually purges stale rows.
describe('OidcStore expiry is caller-enforced, not store-enforced', () => {
  it('returns a past-due code/session/token so the caller can reject it', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    const past = Date.now() - 60_000;
    await store.saveCode('old-code', {
      userId: 'u',
      clientId: 'c',
      redirectUri: 'r',
      expiresAt: past,
    });
    await store.saveSession('old-session', 'u', past);
    await store.saveAccessToken('old-token', 'u', past);

    expect((await store.consumeCode('old-code'))?.expiresAt).toBe(past);
    expect((await store.getSession('old-session'))?.expiresAt).toBe(past);
    expect((await store.getAccessToken('old-token'))?.expiresAt).toBe(past);
  });
});

describe('OidcStore.cleanupExpired', () => {
  it('deletes only rows expired before now across all tables', async () => {
    const { store, knex } = await freshStore();
    currentKnex = knex;
    const past = Date.now() - 60_000;
    const future = Date.now() + 60_000;

    await store.saveSession('live', 'u', future);
    await store.saveSession('dead', 'u', past);
    await store.saveAccessToken('live-tok', 'u', future);
    await store.saveAccessToken('dead-tok', 'u', past);
    await store.savePendingAuth('live-state', '/x', future);
    await store.savePendingAuth('dead-state', '/x', past);

    await store.cleanupExpired();

    expect(await store.getSession('live')).toBeDefined();
    expect(await store.getSession('dead')).toBeUndefined();
    expect(await store.getAccessToken('live-tok')).toBeDefined();
    expect(await store.getAccessToken('dead-tok')).toBeUndefined();
    expect(await store.consumePendingAuth('live-state')).toBeDefined();
    expect(await store.consumePendingAuth('dead-state')).toBeUndefined();
  });
});
