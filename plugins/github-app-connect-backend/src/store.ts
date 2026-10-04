import { Knex } from 'knex';

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

export class RepoConnectionStore {
  constructor(private readonly db: Knex) {}

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

  async find(
    teamId: string,
    serviceId: string,
    repoFullName: string,
  ): Promise<RepoConnection | undefined> {
    return this.db('repo_connections')
      .where({
        team_id: teamId,
        service_id: serviceId,
        repo_full_name: repoFullName,
      })
      .first();
  }

  async findByRepo(repoFullName: string): Promise<RepoConnection[]> {
    return this.db('repo_connections')
      .where({ repo_full_name: repoFullName })
      .select('*');
  }

  async findByTeamAndRepo(teamId: string, repoFullName: string): Promise<RepoConnection | undefined> {
    return this.db('repo_connections')
      .where({ team_id: teamId, repo_full_name: repoFullName })
      .first();
  }

  /**
   * Installations bound to the team by a verified flow: the install callback
   * with a portal-minted state (popup:<user>, callback:<user>) or a repo sync
   * run as the signed-in user (sync:<user>). Rows written by earlier versions
   * (plain 'sync', 'popup-install', 'github-callback', 'auto-discovery',
   * 'direct-install') were not verified and are not carried over.
   */
  async findVerifiedInstallationsByTeam(teamId: string): Promise<number[]> {
    const rows = await this.db('repo_connections')
      .where({ team_id: teamId })
      .andWhere(q =>
        q
          .where('created_by', 'like', 'popup:%')
          .orWhere('created_by', 'like', 'callback:%')
          .orWhere('created_by', 'like', 'sync:%'),
      )
      .distinct('installation_id')
      .select('installation_id');
    return rows.map(r => Number(r.installation_id));
  }

  async findAllInstallations(): Promise<number[]> {
    const rows = await this.db('repo_connections')
      .distinct('installation_id')
      .select('installation_id');
    return rows.map(r => Number(r.installation_id));
  }

  async findInstallationsByTeam(teamId: string): Promise<number[]> {
    const rows = await this.db('repo_connections')
      .where({ team_id: teamId })
      .distinct('installation_id')
      .select('installation_id');
    return rows.map(r => Number(r.installation_id));
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
