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
  const row = await builder
    .where({ tenant_name: tenantName, user_id: userId })
    .first();
  if (!row) {
    return undefined;
  }
  return {
    tenantName: String(row.tenant_name),
    userId: String(row.user_id),
    role: String(row.role),
  };
}
