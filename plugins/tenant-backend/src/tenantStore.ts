import { DatabaseService, LoggerService } from '@backstage/backend-plugin-api';
import { Tenant, TenantMember } from './types';

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
  }

  /** Upsert a tenant (insert or update on conflict) */
  async upsert(tenant: Tenant): Promise<void> {
    const knex = await this.db.getClient();
    await knex('tenants')
      .insert({
        name: tenant.name,
        display_name: tenant.displayName,
        description: tenant.description ?? null,
        github_team: tenant.githubTeam ?? null,
        contact_email: tenant.contactEmail ?? null,
        quotas: JSON.stringify(tenant.quotas),
        networking: JSON.stringify(tenant.networking),
        synced_at: tenant.syncedAt,
      })
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

  /** Delete a tenant by name (used when tenant directory is removed from Git) */
  async delete(name: string): Promise<void> {
    const knex = await this.db.getClient();
    await knex('tenant_members').where({ tenant_name: name }).delete();
    await knex('tenants').where({ name }).delete();
  }

  /** Get all tenant names currently in DB */
  async listNames(): Promise<string[]> {
    const knex = await this.db.getClient();
    const rows = await knex('tenants').select('name');
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
      })
      .onConflict(['tenant_name', 'user_id'])
      .merge(['role']);
  }

  /** Remove a member from a tenant */
  async removeMember(tenantName: string, userId: string): Promise<void> {
    const knex = await this.db.getClient();
    await knex('tenant_members')
      .where({ tenant_name: tenantName, user_id: userId })
      .delete();
  }

  /**
   * Seed a member from values.yaml (system sync, no one-tenant constraint).
   * Skips if the user is already in a *different* tenant (to avoid conflicts).
   */
  async seedMember(tenantName: string, userId: string, role: string): Promise<void> {
    const knex = await this.db.getClient();
    const normalized = userId.toLowerCase().trim();
    // Only skip if already in a different tenant; allow upsert within same tenant
    const conflict = await knex('tenant_members')
      .where({ user_id: normalized })
      .whereNot({ tenant_name: tenantName })
      .first();
    if (conflict) {
      this.logger.debug(
        `[TenantStore] seedMember: skipping '${normalized}' — already in tenant '${conflict.tenant_name}'`,
      );
      return;
    }
    await knex('tenant_members')
      .insert({
        tenant_name: tenantName,
        user_id: normalized,
        role,
        invited_at: new Date(),
        invited_by: 'system',
      })
      .onConflict(['tenant_name', 'user_id'])
      .merge(['role']);
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
