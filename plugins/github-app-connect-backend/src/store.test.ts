import knexFactory, { Knex } from 'knex';
import { LEGACY_BINDING_CUTOFF, RepoConnectionStore } from './store';

// The verified-only readers and the one-time legacy carry-over, against real
// databases. Postgres runs when GAC_TEST_PG_URL points at a scratch server
// (schemas are created and dropped here); SQLite always runs.
// Use a database of its own: suites run in parallel and drop the same schemas.

const BEFORE = new Date(new Date(LEGACY_BINDING_CUTOFF).getTime() - 86_400_000).toISOString();
const AFTER = new Date(new Date(LEGACY_BINDING_CUTOFF).getTime() + 86_400_000).toISOString();

type Row = { team_id: string; repo_full_name: string; installation_id: number; created_by: string; created_at: string };

const ROWS: Row[] = [
  // reviewed pre-cutoff rows of live tenants
  { team_id: 'labs', repo_full_name: 'mashkovd/app', installation_id: 1, created_by: 'sync', created_at: BEFORE },
  { team_id: 'admins', repo_full_name: 'mctlhq/api', installation_id: 2, created_by: 'sync', created_at: BEFORE },
  // pre-cutoff row of a tenant that no longer exists
  { team_id: 'nfc', repo_full_name: 'someone/quirestack', installation_id: 3, created_by: 'sync', created_at: BEFORE },
  // unverified row written after the cutoff
  { team_id: 'labs', repo_full_name: 'victim-org/private', installation_id: 4, created_by: 'popup-install', created_at: AFTER },
  // verified row
  { team_id: 'labs', repo_full_name: 'carol/tool', installation_id: 5, created_by: 'popup:carol', created_at: AFTER },
];

async function seed(db: Knex) {
  for (const r of ROWS) {
    await db('repo_connections').insert({
      ...r,
      service_id: '_auto',
      account_type: 'user',
      updated_at: r.created_at,
    });
  }
}

const pgUrl = process.env.GAC_TEST_PG_URL;

const engines: Array<[string, () => Promise<{ db: Knex; cleanup: () => Promise<void>; tenantCheck: boolean }>]> = [
  [
    'sqlite',
    async () => {
      const db = knexFactory({ client: 'better-sqlite3', connection: ':memory:', useNullAsDefault: true });
      return { db, cleanup: () => db.destroy(), tenantCheck: false };
    },
  ],
];
if (pgUrl) {
  engines.push([
    'postgres',
    async () => {
      const admin = knexFactory({ client: 'pg', connection: pgUrl });
      await admin.raw('DROP SCHEMA IF EXISTS "github-app-connect" CASCADE');
      await admin.raw('DROP SCHEMA IF EXISTS "tenant-management" CASCADE');
      await admin.raw('CREATE SCHEMA "github-app-connect"');
      await admin.raw('CREATE SCHEMA "tenant-management"');
      await admin.raw('CREATE TABLE "tenant-management".tenants (name text primary key)');
      await admin.raw(`INSERT INTO "tenant-management".tenants (name) VALUES ('labs'), ('admins')`);
      await admin.destroy();
      // Like Backstage's per-plugin schema mode: the plugin's own schema is the search path.
      const db = knexFactory({ client: 'pg', connection: pgUrl, searchPath: ['github-app-connect'] });
      return { db, cleanup: () => db.destroy(), tenantCheck: true };
    },
  ]);
}

describe.each(engines)('RepoConnectionStore on %s', (_name, open) => {
  let db: Knex;
  let cleanup: () => Promise<void>;
  let tenantCheck: boolean;
  let store: RepoConnectionStore;

  beforeEach(async () => {
    ({ db, cleanup, tenantCheck } = await open());
    store = new RepoConnectionStore(db);
    await store.initialize(); // creates the table; nothing to migrate yet
    await seed(db);
  });

  afterEach(async () => {
    await cleanup();
  });

  it('carries reviewed pre-cutoff rows over as legacy and leaves everything else alone', async () => {
    await store.migrateLegacyRows();
    const byRepo = Object.fromEntries(
      (await db('repo_connections').select('repo_full_name', 'created_by')).map(r => [r.repo_full_name, r.created_by]),
    );
    expect(byRepo['mashkovd/app']).toBe('legacy:sync');
    expect(byRepo['mctlhq/api']).toBe('legacy:sync');
    // a deleted tenant's rows are not carried over where tenants are visible
    expect(byRepo['someone/quirestack']).toBe(tenantCheck ? 'sync' : 'legacy:sync');
    expect(byRepo['victim-org/private']).toBe('popup-install');
    expect(byRepo['carol/tool']).toBe('popup:carol');
  });

  it('is idempotent', async () => {
    const first = await store.migrateLegacyRows();
    expect(first).toBe(tenantCheck ? 2 : 3);
    expect(await store.migrateLegacyRows()).toBe(0);
  });

  it('runs as part of initialize', async () => {
    await store.initialize();
    expect(await store.findByTeamAndRepo('labs', 'mashkovd/app')).toBeDefined();
  });

  it('readers ignore unverified rows', async () => {
    expect(await store.findByTeamAndRepo('labs', 'mashkovd/app')).toBeUndefined();
    expect(await store.findByTeamAndRepo('labs', 'victim-org/private')).toBeUndefined();
    expect(await store.findByTeamAndRepo('labs', 'carol/tool')).toBeDefined();
    expect(await store.findInstallationsByTeam('labs')).toEqual([5]);

    await store.migrateLegacyRows();
    expect((await store.findInstallationsByTeam('labs')).sort()).toEqual([1, 5]);
    expect(await store.find('labs', '_auto', 'victim-org/private')).toBeUndefined();
    expect(await store.findByRepo('victim-org/private')).toEqual([]);
    expect((await store.findAllInstallations()).sort()).toEqual(tenantCheck ? [1, 2, 5] : [1, 2, 3, 5]);
  });
});
