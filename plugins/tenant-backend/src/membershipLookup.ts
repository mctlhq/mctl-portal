import type { Knex } from 'knex';

/** Postgres schema where tenant-backend owns the tenant_members table. */
export const TENANT_MGMT_SCHEMA = 'tenant-management';

/**
 * Read a single tenant_members row from the canonical
 * tenant-management schema. Intended for plugins other than
 * tenant-backend that need to authorize a user against a team —
 * their own Knex client points at a different schema, so queries
 * must go through withSchema() on Postgres.
 *
 * Returns undefined if the user is not a member of the tenant.
 */
export async function getTenantMember(
  db: Knex,
  isPostgres: boolean,
  tenantName: string,
  userId: string,
): Promise<{ tenantName: string; userId: string; role: string } | undefined> {
  const builder = isPostgres
    ? db('tenant_members').withSchema(TENANT_MGMT_SCHEMA)
    : db('tenant_members');
  let row: any;
  try {
    row = await builder
      .where({ tenant_name: tenantName, user_id: userId })
      .first();
  } catch (err: any) {
    // Backstage scopes databases per plugin on SQLite (local dev), so a
    // calling plugin whose client points at a different SQLite file cannot
    // see tenant-management's tenant_members table. Treat that as "no
    // membership" so the caller returns a clean 403 rather than a 500.
    if (isMissingTableError(err)) {
      return undefined;
    }
    throw err;
  }
  if (!row) {
    return undefined;
  }
  return {
    tenantName: String(row.tenant_name),
    userId: String(row.user_id),
    role: String(row.role),
  };
}

/**
 * Whether userId holds owner role in the platform-wide 'admins' tenant.
 * Mirrors the isAdmin check in tenant-backend's resolveAuth() so other
 * plugins can grant the same cross-tenant admin bypass.
 */
export async function isAdminUser(
  db: Knex,
  isPostgres: boolean,
  userId: string,
): Promise<boolean> {
  const member = await getTenantMember(db, isPostgres, 'admins', userId.toLowerCase());
  return member?.role === 'owner';
}

function isMissingTableError(err: any): boolean {
  const code = err?.code ?? '';
  const msg = err?.message ?? '';
  // Postgres (would indicate a misconfigured production DB, not local dev)
  if (code === '42P01') return false;
  // SQLite (better-sqlite3 / sqlite3)
  if (code === 'SQLITE_ERROR' && /no such table/i.test(msg)) return true;
  if (/no such table: tenant_members/i.test(msg)) return true;
  return false;
}
