import { DatabaseService, LoggerService } from '@backstage/backend-plugin-api';
import { Tenant, TenantMember } from './types';
import { isPostgresClient } from './membershipLookup';
import { SeedMember } from './memberKeys';

/** Schema of github-app-connect's repo_connections table on Postgres. */
const GITHUB_APP_CONNECT_SCHEMA = 'github-app-connect';

/** A self-service customer already owns a workspace (one per principal). */
export class CustomerHasTenantError extends Error {}

/** The tenant name is already taken. */
export class TenantExistsError extends Error {}

// A unique-constraint violation, on Postgres (23505) or SQLite (tests).
function isUniqueViolation(err: any): boolean {
  return err?.code === '23505' || /UNIQUE constraint failed/.test(String(err?.message));
}

/**
 * TenantStore: PostgreSQL-backed cache of tenant definitions.
 * Synced periodically from GitHub (platform-gitops/tenants/{name}/values.yaml).
 */
export class TenantStore {
  private db: DatabaseService;
  private logger: LoggerService;

  constructor(db: DatabaseService, logger: LoggerService) {
    this.db = db;
    this.logger = logger;
  }

  /** Ensure the tenants table exists */
  async init(): Promise<void> {
    const knex = await this.db.getClient();
    const exists = await knex.schema.hasTable('tenants');
    if (!exists) {
      await knex.schema.createTable('tenants', table => {
        table.string('name').primary().notNullable();
        table.string('display_name').notNullable();
        table.text('description').nullable();
        table.string('github_team').nullable();
        table.string('contact_email').nullable();
        table.jsonb('quotas').notNullable();
        table.jsonb('networking').notNullable();
        table.timestamp('synced_at').notNullable();
      });
      this.logger.info('[TenantStore] Created tenants table');
    }

    const membersExists = await knex.schema.hasTable('tenant_members');
    if (!membersExists) {
      await knex.schema.createTable('tenant_members', table => {
        table.string('tenant_name').notNullable();
        table.string('user_id').notNullable();
        table.string('role').notNullable().defaultTo('developer');
        table.timestamp('invited_at').notNullable().defaultTo(knex.fn.now());
        table.string('invited_by').notNullable();
        table.primary(['tenant_name', 'user_id']);
        table.index(['user_id'], 'idx_tenant_members_user');
      });
      this.logger.info('[TenantStore] Created tenant_members table');
    }

    // Principal-keyed members (stage C2): how user_id was chosen, the
    // principal and the display login. Added in place; rows from before
    // read as login-keyed.
    const memberColumns: Array<[string, (t: any) => void]> = [
      ['catalog_key', t => t.string('catalog_key').notNullable().defaultTo('login')],
      ['principal_id', t => t.string('principal_id').nullable()],
      ['login', t => t.string('login').nullable()],
    ];
    for (const [column, add] of memberColumns) {
      if (!(await knex.schema.hasColumn('tenant_members', column))) {
        try {
          await knex.schema.alterTable('tenant_members', add);
          this.logger.info(`[TenantStore] Added tenant_members.${column}`);
        } catch (e) {
          // Another replica starting at the same time may have added it
          // between the check and the ALTER; only its absence is an error.
          if (!(await knex.schema.hasColumn('tenant_members', column))) throw e;
        }
      }
    }

    // One workspace per self-service customer, held by the database rather
    // than by a check a concurrent request can pass too. Login-keyed rows
    // are exempt: staff legitimately belong to several tenants.
    await knex.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_members_principal ` +
        `ON tenant_members (user_id) WHERE catalog_key = 'principal'`,
    );
  }

  /** Upsert a tenant (insert or update on conflict) */
  async upsert(tenant: Tenant): Promise<void> {
    const knex = await this.db.getClient();
    await knex('tenants')
      .insert(tenantRow(tenant))
      .onConflict('name')
      .merge([
        'display_name',
        'description',
        'github_team',
        'contact_email',
        'quotas',
        'networking',
        'synced_at',
      ]);
  }

  /**
   * Writes a self-service customer's tenant and its principal-keyed owner
   * together, or neither: a second request for the same customer, however
   * close in time, fails here with CustomerHasTenantError and leaves no
   * tenant behind. A taken name fails with TenantExistsError instead of
   * overwriting the tenant that holds it.
   */
  async createCustomerTenant(tenant: Tenant, owner: TenantMember): Promise<void> {
    const knex = await this.db.getClient();
    await knex.transaction(async trx => {
      try {
        await trx('tenants').insert(tenantRow(tenant));
      } catch (err) {
        if (isUniqueViolation(err)) throw new TenantExistsError(`Tenant '${tenant.name}' already exists`);
        throw err;
      }
      try {
        await trx('tenant_members').insert({
          tenant_name: tenant.name,
          user_id: owner.userId.toLowerCase().trim(),
          role: owner.role,
          invited_at: owner.invitedAt,
          invited_by: owner.invitedBy,
          catalog_key: 'principal',
          principal_id: owner.principalId ?? null,
          login: owner.login ?? null,
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new CustomerHasTenantError('This account already has a workspace');
        throw err;
      }
    });
  }

  /** Get all tenants */
  async listAll(): Promise<Tenant[]> {
    const knex = await this.db.getClient();
    const rows = await knex('tenants').select('*').orderBy('name');
    return rows.map(rowToTenant);
  }

  /** Get a single tenant by name */
  async findByName(name: string): Promise<Tenant | undefined> {
    const knex = await this.db.getClient();
    const row = await knex('tenants').where({ name }).first();
    return row ? rowToTenant(row) : undefined;
  }

  /**
   * Delete a tenant by name (used when tenant directory is removed from Git).
   * Its GitHub repository connections go with it: they authorize builds for
   * the team name, and a later tenant registered under the same name must
   * not inherit them. A failed cleanup fails the delete, so the next sync
   * retries it.
   */
  async delete(name: string): Promise<void> {
    const knex = await this.db.getClient();
    if (isPostgresClient(knex)) {
      try {
        await knex('repo_connections')
          .withSchema(GITHUB_APP_CONNECT_SCHEMA)
          .where({ team_id: name })
          .delete();
      } catch (err: any) {
        // 42P01: github-app-connect never created its table, so there is nothing to clean.
        if (err?.code !== '42P01') throw err;
      }
    }
    await knex('tenant_members').where({ tenant_name: name }).delete();
    await knex('tenants').where({ name }).delete();
  }

  /** Get all tenant names currently in DB */
  async listNames(): Promise<string[]> {
    const knex = await this.db.getClient();
    const rows = await knex('tenants').select('name').orderBy('name');
    return rows.map((r: any) => r.name as string);
  }

  // ─── Member management ────────────────────────────────────────────────────

  /** Add a member to a tenant (upsert). Enforces one-tenant-per-user. */
  async addMember(member: TenantMember): Promise<void> {
    const knex = await this.db.getClient();
    // Normalize userId to lowercase — GitHub logins are case-insensitive and
    // the OIDC provider always queries with the lowercased login.
    member.userId = member.userId.toLowerCase().trim();
    // Ensure the user is not already in a different tenant
    const existing = await knex('tenant_members')
      .where({ user_id: member.userId })
      .whereNot({ tenant_name: member.tenantName })
      .first();
    if (existing) {
      throw new Error(
        `User '${member.userId}' is already a member of tenant '${existing.tenant_name}'`,
      );
    }
    await knex('tenant_members')
      .insert({
        tenant_name: member.tenantName,
        user_id: member.userId,
        role: member.role,
        invited_at: member.invitedAt,
        invited_by: member.invitedBy,
        catalog_key: member.catalogKey ?? 'login',
        principal_id: member.principalId ?? null,
        login: member.login ?? null,
      })
      .onConflict(['tenant_name', 'user_id'])
      // A caller that says how the member is keyed (tenant creation)
      // rewrites the keying; one that does not (an invite, which is also how
      // a role is changed) keeps what the row holds.
      .merge(
        member.catalogKey
          ? ['role', 'catalog_key', 'principal_id', 'login']
          : ['role'],
      );
  }

  /** Remove a member from a tenant */
  async removeMember(tenantName: string, userId: string): Promise<void> {
    const knex = await this.db.getClient();
    await knex('tenant_members')
      .where({ tenant_name: tenantName, user_id: userId })
      .delete();
  }

  /**
   * Seed a member from values.yaml (system sync). Gitops is the source of
   * truth — a user may legitimately appear in multiple tenant values files
   * (e.g. a platform admin who is also a member of a product tenant), so no
   * single-tenant constraint is enforced here. That constraint lives only in
   * addMember() which handles user-initiated invites.
   *
   * member.userId is the catalog name seedMemberOf chose; how it was chosen
   * is recorded with it, so a principal-keyed row is never read as a login.
   */
  async seedMember(tenantName: string, member: SeedMember): Promise<void> {
    const knex = await this.db.getClient();
    const normalized = member.userId.toLowerCase().trim();
    await knex('tenant_members')
      .insert({
        tenant_name: tenantName,
        user_id: normalized,
        role: member.role,
        invited_at: new Date(),
        invited_by: 'system',
        catalog_key: member.catalogKey,
        principal_id: member.principalId ?? null,
        login: member.login ?? null,
      })
      .onConflict(['tenant_name', 'user_id'])
      .merge(['role', 'catalog_key', 'principal_id', 'login']);
  }

  /** Update a member's role */
  async updateMemberRole(tenantName: string, userId: string, role: string): Promise<void> {
    const knex = await this.db.getClient();
    await knex('tenant_members')
      .where({ tenant_name: tenantName, user_id: userId })
      .update({ role });
  }

  /** List all members of a tenant */
  async listMembers(tenantName: string): Promise<TenantMember[]> {
    const knex = await this.db.getClient();
    const rows = await knex('tenant_members')
      .where({ tenant_name: tenantName })
      .orderBy('invited_at', 'asc');
    return rows.map(rowToMember);
  }

  /** Get the tenant (and role) for a given user. Returns undefined if not a member anywhere. */
  async getMemberTenant(
    userId: string,
  ): Promise<{ tenantName: string; role: string } | undefined> {
    const knex = await this.db.getClient();
    const row = await knex('tenant_members').where({ user_id: userId }).first();
    return row ? { tenantName: row.tenant_name, role: row.role } : undefined;
  }

  /** Get a specific member's record within a tenant. */
  async getMemberByTenant(tenantName: string, userId: string): Promise<TenantMember | undefined> {
    const knex = await this.db.getClient();
    const row = await knex('tenant_members').where({ tenant_name: tenantName, user_id: userId }).first();
    return row ? rowToMember(row) : undefined;
  }

  /** All tenant memberships for a single user (multi-tenant users have >1 row). */
  async listMembershipsForUser(userId: string): Promise<TenantMember[]> {
    const knex = await this.db.getClient();
    const rows = await knex('tenant_members').where({ user_id: userId }).orderBy('tenant_name');
    return rows.map(rowToMember);
  }

  /** List ALL members across ALL tenants (used by catalog YAML generator) */
  async listAllMembers(): Promise<TenantMember[]> {
    const knex = await this.db.getClient();
    const rows = await knex('tenant_members').select('*').orderBy('tenant_name', 'user_id');
    return rows.map(rowToMember);
  }
}

function rowToMember(row: any): TenantMember {
  return {
    tenantName: row.tenant_name,
    userId: row.user_id,
    role: row.role as 'owner' | 'developer' | 'viewer',
    invitedAt:
      row.invited_at instanceof Date ? row.invited_at.toISOString() : String(row.invited_at),
    invitedBy: row.invited_by,
    ...(row.catalog_key === 'principal' ? { catalogKey: 'principal' as const } : {}),
    ...(row.principal_id ? { principalId: row.principal_id } : {}),
    ...(row.login ? { login: row.login } : {}),
  };
}

function rowToTenant(row: any): Tenant {
  return {
    name: row.name,
    displayName: row.display_name,
    description: row.description ?? undefined,
    githubTeam: row.github_team ?? undefined,
    contactEmail: row.contact_email ?? undefined,
    quotas: typeof row.quotas === 'string' ? JSON.parse(row.quotas) : row.quotas,
    networking: typeof row.networking === 'string' ? JSON.parse(row.networking) : row.networking,
    syncedAt: row.synced_at instanceof Date ? row.synced_at.toISOString() : row.synced_at,
  };
}

function tenantRow(tenant: Tenant) {
  return {
    name: tenant.name,
    display_name: tenant.displayName,
    description: tenant.description ?? null,
    github_team: tenant.githubTeam ?? null,
    contact_email: tenant.contactEmail ?? null,
    quotas: JSON.stringify(tenant.quotas),
    networking: JSON.stringify(tenant.networking),
    synced_at: tenant.syncedAt,
  };
}
