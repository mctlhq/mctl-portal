import { Knex } from 'knex';
import { isPostgresClient } from '../../tenant-backend/src/membershipLookup';

export interface RepoConnection {
  team_id: string;
  service_id: string;
  repo_full_name: string;
  installation_id: number;
  account_type: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * Prefixes of created_by values written by a verified binding flow. Rows
 * without one were written before installations were verified and are not
 * trusted (see migrateLegacyRows for the one-time exception).
 */
export const VERIFIED_CREATED_BY_PREFIXES = ['popup:', 'callback:', 'sync:', 'legacy:'];

/**
 * Bookkeeping for one-time migrations of repo_connections. The legacy
 * carry-over records its cutoff here on its first run, so the cutoff is the
 * moment this code first started against the database, not a date fixed
 * when it was written.
 */
const MIGRATIONS_TABLE = 'repo_connections_migrations';
const LEGACY_MIGRATION = 'legacy-bindings';

const TENANT_SCHEMA = 'tenant-management';

export class RepoConnectionStore {
  constructor(
    private readonly db: Knex,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async initialize(): Promise<void> {
    const hasTable = await this.db.schema.hasTable('repo_connections');
    if (!hasTable) {
      await this.db.schema.createTable('repo_connections', table => {
        table.string('team_id').notNullable();
        table.string('service_id').notNullable();
        table.string('repo_full_name').notNullable();
        table.bigInteger('installation_id').notNullable();
        table.string('account_type').notNullable().defaultTo('user');
        table.string('created_by').notNullable();
        table.timestamp('created_at').defaultTo(this.db.fn.now());
        table.timestamp('updated_at').defaultTo(this.db.fn.now());
        table.primary(['team_id', 'service_id', 'repo_full_name']);
      });
    }
    if (!(await this.db.schema.hasTable(MIGRATIONS_TABLE))) {
      await this.db.schema.createTable(MIGRATIONS_TABLE, table => {
        table.string('name').primary();
        table.string('cutoff').notNullable();
      });
    }
    await this.migrateLegacyRows();
  }

  /**
   * The legacy cutoff: recorded by the first run, read back by every later
   * one. Rows written by the old, unverified flows before it were reviewed
   * (2026-10-04: 25 rows, all bare 'sync', no popup/callback/auto-discovery
   * rows). A bare row written after it, e.g. by an old replica during the
   * rollout, stays untrusted. Concurrent first runs agree: only one insert
   * wins and both read the stored value.
   */
  async legacyCutoff(): Promise<string> {
    await this.db(MIGRATIONS_TABLE)
      .insert({ name: LEGACY_MIGRATION, cutoff: this.now().toISOString() })
      .onConflict('name')
      .ignore();
    const row = await this.db(MIGRATIONS_TABLE).where({ name: LEGACY_MIGRATION }).first();
    if (typeof row?.cutoff !== 'string' || Number.isNaN(Date.parse(row.cutoff))) {
      throw new Error(`${MIGRATIONS_TABLE}: unreadable cutoff for ${LEGACY_MIGRATION}`);
    }
    return row.cutoff;
  }

  /**
   * One-time carry-over of reviewed pre-cutoff rows: marks them
   * `legacy:<created_by>` so verified-only readers keep them. Only rows of
   * teams that still exist as tenants are carried over; a row for a deleted
   * tenant would otherwise pass its bindings to whoever registers the name
   * next. Idempotent: marked rows no longer match, and the cutoff does not
   * move after the first run.
   */
  async migrateLegacyRows(): Promise<number> {
    const cutoff = await this.legacyCutoff();
    const isPostgres = isPostgresClient(this.db);
    const query = this.db('repo_connections')
      .whereNot('created_by', 'like', '%:%')
      // An ISO string compares correctly both as a Postgres timestamp and as
      // the ISO text SQLite stores.
      .andWhere('created_at', '<', cutoff);
    if (isPostgres) {
      // tenant-backend owns the tenants table in its own schema.
      query.whereIn(
        'team_id',
        this.db.withSchema(TENANT_SCHEMA).select('name').from('tenants'),
      );
    }
    return query.update({ created_by: this.db.raw("'legacy:' || created_by") });
  }

  async upsert(conn: Omit<RepoConnection, 'created_at' | 'updated_at'>): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.db('repo_connections')
      .where({
        team_id: conn.team_id,
        service_id: conn.service_id,
        repo_full_name: conn.repo_full_name,
      })
      .first();

    if (existing) {
      await this.db('repo_connections')
        .where({
          team_id: conn.team_id,
          service_id: conn.service_id,
          repo_full_name: conn.repo_full_name,
        })
        .update({
          installation_id: conn.installation_id,
          account_type: conn.account_type,
          created_by: conn.created_by,
          updated_at: now,
        });
    } else {
      await this.db('repo_connections').insert({
        ...conn,
        created_at: now,
        updated_at: now,
      });
    }
  }

  // Readers only see rows written by a verified flow (VERIFIED_CREATED_BY_PREFIXES).
  private verified(teamId?: string) {
    const q = this.db('repo_connections').where(w => {
      for (const prefix of VERIFIED_CREATED_BY_PREFIXES) {
        w.orWhere('created_by', 'like', `${prefix}%`);
      }
    });
    return teamId === undefined ? q : q.andWhere({ team_id: teamId });
  }

  async find(
    teamId: string,
    serviceId: string,
    repoFullName: string,
  ): Promise<RepoConnection | undefined> {
    return this.verified(teamId)
      .andWhere({ service_id: serviceId, repo_full_name: repoFullName })
      .first();
  }

  async findByRepo(repoFullName: string): Promise<RepoConnection[]> {
    return this.verified().andWhere({ repo_full_name: repoFullName }).select('*');
  }

  async findByTeamAndRepo(teamId: string, repoFullName: string): Promise<RepoConnection | undefined> {
    return this.verified(teamId).andWhere({ repo_full_name: repoFullName }).first();
  }

  /**
   * Installations bound to the team by a verified flow: the install callback
   * with a portal-minted state (popup:<user>, callback:<user>), a repo sync
   * run as the signed-in user (sync:<user>), or reviewed pre-cutoff rows
   * (legacy:<created_by>). Other rows are ignored.
   */
  async findVerifiedInstallationsByTeam(teamId: string): Promise<number[]> {
    const rows = await this.verified(teamId).distinct('installation_id').select('installation_id');
    return rows.map(r => Number(r.installation_id));
  }

  async findAllInstallations(): Promise<number[]> {
    const rows = await this.verified().distinct('installation_id').select('installation_id');
    return rows.map(r => Number(r.installation_id));
  }

  async findInstallationsByTeam(teamId: string): Promise<number[]> {
    return this.findVerifiedInstallationsByTeam(teamId);
  }

  async delete(
    teamId: string,
    serviceId: string,
    repoFullName: string,
  ): Promise<void> {
    await this.db('repo_connections')
      .where({
        team_id: teamId,
        service_id: serviceId,
        repo_full_name: repoFullName,
      })
      .delete();
  }

  async deleteByTeam(teamId: string): Promise<number> {
    return this.db('repo_connections')
      .where({ team_id: teamId })
      .delete();
  }
}
