import knexFactory, { Knex } from 'knex';
import { RepoConnectionStore } from './store';
import { isRepoBoundToTeam } from './bindingLookup';

// The verified-only readers and the one-time legacy carry-over, against real
// databases. Postgres runs when GAC_TEST_PG_URL points at a scratch server
// (schemas are created and dropped here); SQLite always runs.
// Use a database of its own: suites run in parallel and drop the same schemas.

// The first initialize() runs at FIRST_RUN and records it as the cutoff.
const FIRST_RUN = new Date('2026-10-05T12:00:00.000Z');
const BEFORE = new Date(FIRST_RUN.getTime() - 86_400_000).toISOString();
const AFTER = new Date(FIRST_RUN.getTime() + 86_400_000).toISOString();
const LATER = new Date(FIRST_RUN.getTime() + 2 * 86_400_000);

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
    store = new RepoConnectionStore(db, () => FIRST_RUN);
    await store.initialize(); // creates the tables and records the cutoff; nothing to migrate yet
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

  it('leaves rows untrusted, and does not fail, while the tenants table does not exist yet', async () => {
    if (!tenantCheck) return; // only Postgres reads the tenants table
    await db.raw('DROP TABLE "tenant-management".tenants');
    expect(await store.migrateLegacyRows()).toBe(0);
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(await store.findByTeamAndRepo('labs', 'mashkovd/app')).toBeUndefined();
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

  it('answers the cross-plugin binding check from verified rows only, ignoring case', async () => {
    const isPostgres = tenantCheck;
    expect(await isRepoBoundToTeam(db, isPostgres, 'labs', 'carol/tool')).toBe(true);
    expect(await isRepoBoundToTeam(db, isPostgres, 'labs', 'Carol/Tool')).toBe(true);
    // another team's binding, and unverified rows, are not this team's
    expect(await isRepoBoundToTeam(db, isPostgres, 'admins', 'carol/tool')).toBe(false);
    expect(await isRepoBoundToTeam(db, isPostgres, 'labs', 'victim-org/private')).toBe(false);
    expect(await isRepoBoundToTeam(db, isPostgres, 'labs', 'mashkovd/app')).toBe(false);
  });

  it('records the cutoff on the first run and never moves it', async () => {
    expect(await store.legacyCutoff()).toBe(FIRST_RUN.toISOString());
    // A later start (a new release, a restart) must not re-derive the cutoff:
    // the bare row written after the first run would then be carried over.
    const later = new RepoConnectionStore(db, () => LATER);
    await later.initialize();
    expect(await later.legacyCutoff()).toBe(FIRST_RUN.toISOString());
    const row = await db('repo_connections').where({ repo_full_name: 'victim-org/private' }).first();
    expect(row.created_by).toBe('popup-install');
    expect(await later.findByTeamAndRepo('labs', 'victim-org/private')).toBeUndefined();
  });

  it('refuses to migrate when the recorded cutoff is unreadable', async () => {
    await db('repo_connections_migrations').update({ cutoff: 'garbage' });
    await expect(store.migrateLegacyRows()).rejects.toThrow(/unreadable cutoff/);
    expect(await store.findByTeamAndRepo('labs', 'mashkovd/app')).toBeUndefined();
  });

  const fresh = (repo: string, installation: number) => ({
    team_id: 'labs',
    service_id: '_auto',
    repo_full_name: repo,
    installation_id: installation,
    account_type: 'user',
    created_by: 'sync:mashkovd',
  });

  const snapshot = () =>
    db('repo_connections')
      .orderBy(['team_id', 'repo_full_name'])
      .select('team_id', 'repo_full_name', 'installation_id', 'created_by');

  it('replaceTeam carries verified rows of other installations, drops the rest and writes the fresh listing', async () => {
    await store.migrateLegacyRows();
    const carried = await store.replaceTeam('labs', new Set([5]), [fresh('carol/new', 5)]);
    expect(carried.map(r => r.repo_full_name)).toEqual(['mashkovd/app']);
    const labs = (await snapshot()).filter(r => r.team_id === 'labs');
    expect(labs.map(r => [r.repo_full_name, r.created_by])).toEqual([
      ['carol/new', 'sync:mashkovd'],
      ['mashkovd/app', 'legacy:sync'],
    ]);
    expect((await snapshot()).filter(r => r.team_id === 'admins')).toHaveLength(1);
  });

  it('replaceTeam changes nothing when a write fails part-way (the carried rows are never lost)', async () => {
    await store.migrateLegacyRows();
    const before = await snapshot();
    await expect(
      store.replaceTeam('labs', new Set([5]), [
        fresh('carol/new', 5),
        { ...fresh('carol/broken', 5), repo_full_name: null as unknown as string },
      ]),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});
