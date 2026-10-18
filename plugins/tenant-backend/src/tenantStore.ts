import { ensureCustomerDeletionSchema, lockTenantLifecycle, CustomerDeletionConflictError } from './customerDeletionSchema';
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
// better-sqlite3 reports SQLITE_CONSTRAINT_UNIQUE in `code` too, but the
// message is what knex has surfaced across driver versions; the store tests
// run on SQLite, so a change in either breaks them rather than passing.
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

    await ensureCustomerDeletionSchema(knex);

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
        ...(tenant.contactEmail === undefined ? [] : ['contact_email']),
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
      if (isPostgresClient(knex)) await trx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`tenant-lifecycle|${tenant.name}`]);
      if (await trx('customer_deletions').where({ tenant_name: tenant.name, status: 'active' }).first()) {
        throw new Error('Tenant account deletion is in progress');
      }
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
    await knex.transaction(async tx => {
      await lockTenantLifecycle(tx, name);
      // Lock the delivery rows before removing membership. An in-flight send
      // must finish or lose its lease before deletion can report success.
      if (await tx.schema.hasTable('workspace_ready_emails')) {
        const deliveries = tx('workspace_ready_emails').where({ tenant_name: name });
        const rows = await (isPostgresClient(knex) ? deliveries.forUpdate() : deliveries)
          .select('lease_until_ms');
        if (rows.some(row => row.lease_until_ms !== null && Number(row.lease_until_ms) >= Date.now())) {
          throw new Error('Workspace ready delivery is in flight; retry tenant cleanup');
        }
        // Keep a non-deliverable receipt so a scheduler holding an old snapshot
        // cannot recreate and send this tenant's notification after deletion.
        await tx('workspace_ready_emails').where({ tenant_name: name }).update({
          status: 'cancelled', recipient: '', snapshot: '{}', payload: '{}',
          lease_until_ms: null, lease_token: null,
        });
      }
      if (isPostgresClient(knex) &&
          await tx.schema.withSchema(GITHUB_APP_CONNECT_SCHEMA).hasTable('repo_connections')) {
        await tx('repo_connections').withSchema(GITHUB_APP_CONNECT_SCHEMA)
          .where({ team_id: name }).delete();
      }
      await tx('tenant_members').where({ tenant_name: name }).delete();
      await tx('tenants').where({ name }).delete();
    });
  }

  async isTenantDeleting(name: string): Promise<boolean> {
    const knex = await this.db.getClient();
    return Boolean(await knex('customer_deletions').where({ tenant_name: name, status: 'active' }).first());
  }

  /** Freeze name reuse before a customer deletion workflow can remove GitOps. */
  async freezeCustomerDeletion(name: string, principalId: string, login: string): Promise<void> {
    const knex = await this.db.getClient();
    await knex.transaction(async tx => {
      if (isPostgresClient(knex)) await tx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`tenant-lifecycle|${name}`]);
      const existing = await tx('customer_deletions').where({ tenant_name: name, principal_id: principalId }).first();
      if (existing) return;
      const members = await tx('tenant_members').where({ principal_id: principalId })
        .orWhereRaw('lower(user_id) = ?', [login.toLowerCase()])
        .orWhereRaw('lower(login) = ?', [login.toLowerCase()]);
      if (members.length !== 1 || members[0].tenant_name !== name || members[0].role !== 'owner' ||
          members[0].catalog_key !== 'principal' || members[0].principal_id !== principalId) {
        throw new CustomerDeletionConflictError('Exclusive customer ownership is not observed in the portal');
      }
      const all = await tx('tenant_members').where({ tenant_name: name });
      if (all.length !== 1) throw new CustomerDeletionConflictError('Workspace has other members');
      await tx('customer_deletions').insert({ tenant_name: name, principal_id: principalId, status: 'active' });
    });
  }

  async assertCustomerDeletion(name: string, principalId: string): Promise<'active' | 'complete'> {
    const knex = await this.db.getClient();
    const row = await knex('customer_deletions').where({ tenant_name: name, principal_id: principalId }).first();
    if (!row || !['active', 'complete'].includes(row.status)) throw new Error('Customer deletion freeze is not active');
    if (row.status === 'complete' && (row.cleaned_ms === null || row.cleaned_ms === undefined)) throw new Error('Customer cleanup receipt is missing');
    return row.status;
  }

  /** A replay can release only its own freeze, never a replacement account's. */
  async releaseCustomerDeletion(name: string, principalId: string): Promise<void> {
    const knex = await this.db.getClient();
    await knex.transaction(async tx => {
      if (isPostgresClient(knex)) await tx.raw("SELECT pg_advisory_xact_lock(hashtext(?))", [`tenant-lifecycle|${name}`]);
      const row = await tx('customer_deletions').where({ tenant_name: name, principal_id: principalId }).first();
      if (!row) throw new Error('Customer deletion freeze missing');
      if (row.status === 'complete') {
        if ((row.cleaned_ms === null || row.cleaned_ms === undefined)) throw new Error('Customer cleanup receipt is missing');
        return;
      }
      if (await tx('tenants').where({ name }).first() || await tx('tenant_members').where({ tenant_name: name }).first()) {
        throw new Error('Tenant state still exists');
      }
      if ((row.cleaned_ms === null || row.cleaned_ms === undefined)) throw new Error('Customer cleanup receipt is missing');
      await tx('customer_deletions').where({ tenant_name: name, principal_id: principalId }).update({ status: 'complete' });
    });
  }

  /** Receipt is written only after private cleanup and catalog postconditions. */
  async markCustomerDeletionClean(name: string, principalId: string): Promise<void> {
    const knex = await this.db.getClient();
    await knex.transaction(async tx => {
      await lockTenantLifecycle(tx, name);
      const row = await tx('customer_deletions').where({ tenant_name: name, principal_id: principalId }).first();
      if (!row || row.status !== 'active') throw new Error('Customer deletion freeze is not active');
      if (await tx('tenants').where({ name }).first() || await tx('tenant_members').where({ tenant_name: name }).first()) throw new Error('Tenant state still exists');
      await tx('customer_deletions').where({ tenant_name: name, principal_id: principalId }).update({ cleaned_ms: Date.now() });
    });
  }

  /** Revoke Backstage sessions for the immutable customer principal.
   * Legacy oidc-provider sessions are login-keyed staff sessions. Its exact-key
   * membership gate (oidcUserExists) refuses principal-keyed customers; do not
   * fabricate principal-keyed deletes or sweep a staff login namespace here.
   */
  async deleteCustomerSessions(principalId: string): Promise<void> {
    const knex = await this.db.getClient();
    if (!isPostgresClient(knex)) throw new Error('Customer session cleanup requires PostgreSQL');
    const refs = [`user:default/${principalId.toLowerCase()}`];
    await knex.transaction(async tx => {
      // Installed auth-backend migration names. Missing schema is unknown.
      for (const table of ['offline_sessions', 'user_info', 'oauth_authorization_sessions', 'oidc_authorization_codes']) {
        if (!(await tx.schema.withSchema('auth').hasTable(table))) throw new Error(`Unsupported session schema: missing auth.${table}`);
      }
      for (const table of ['offline_sessions', 'user_info']) {
        await tx(table).withSchema('auth').whereIn('user_entity_ref', refs).delete();
      }
      const sessionIds = tx('oauth_authorization_sessions').withSchema('auth')
        .whereIn('user_entity_ref', refs).select('id');
      await tx('oidc_authorization_codes').withSchema('auth').whereIn('session_id', sessionIds).delete();
      await tx('oauth_authorization_sessions').withSchema('auth').whereIn('user_entity_ref', refs).delete();
    });
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
