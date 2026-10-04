import knexLib, { Knex } from 'knex';
import { OidcStore } from './oidcStore';
import { readOidcSessionUserId } from './sessionAuth';

// Runs against a real Postgres when OIDC_TEST_PG_URL is set, e.g.
//   docker run --rm -d -p 55491:5432 -e POSTGRES_PASSWORD=pw postgres:16
//   OIDC_TEST_PG_URL=postgres://postgres:pw@127.0.0.1:55491/postgres yarn test
// SQLite runs everything else; this covers the schema-qualified Postgres
// paths: the host_only migration, the session reader and code consumption
// under real concurrency.
const url = process.env.OIDC_TEST_PG_URL;
const describePg = url ? describe : describe.skip;
const SCHEMA = 'oidc-provider';

describePg('OidcStore on Postgres', () => {
  let knex: Knex;
  const logger = { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any;

  beforeEach(async () => {
    knex = knexLib({ client: 'pg', connection: url, pool: { min: 0, max: 10 } });
    await knex.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [SCHEMA]);
    await knex.raw('CREATE SCHEMA ??', [SCHEMA]);
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [SCHEMA]);
    await knex.destroy();
  });

  it('deletes legacy sessions on init and only reads host_only rows', async () => {
    await knex.schema.withSchema(SCHEMA).createTable('oidc_sessions', t => {
      t.string('session_id', 128).primary().notNullable();
      t.string('user_id', 128).notNullable();
      t.bigInteger('expires_at').notNullable();
    });
    const future = Date.now() + 60_000;
    await knex('oidc_sessions').withSchema(SCHEMA).insert({ session_id: 'legacy', user_id: 'u', expires_at: future });

    const store = new OidcStore(knex, logger, true);
    await store.init();
    await store.init();

    expect(await knex('oidc_sessions').withSchema(SCHEMA).where({ session_id: 'legacy' }).first()).toBeUndefined();

    await store.saveSession('new', 'mashkovd', future);
    await knex('oidc_sessions').withSchema(SCHEMA).insert({ session_id: 'old-pod', user_id: 'u', expires_at: future });

    expect(await readOidcSessionUserId('__Host-oidc_session=new', knex, true)).toBe('mashkovd');
    expect(await readOidcSessionUserId('__Host-oidc_session=old-pod', knex, true)).toBeUndefined();
    expect(await store.getSession('old-pod')).toBeUndefined();
  });

  it('lets exactly one of many concurrent consumers redeem a forward-auth code', async () => {
    const store = new OidcStore(knex, logger, true);
    await store.init();
    await store.saveForwardAuthCode('c1', {
      userId: 'u',
      portalSessionId: 'p',
      tenant: 't',
      service: 's',
      host: 't-s.mctl.ai',
      state: 'st',
      returnPath: '/',
      sessionExpiresAt: Date.now() + 60_000,
      expiresAt: Date.now() + 60_000,
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.consumeForwardAuthCode('c1')));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
