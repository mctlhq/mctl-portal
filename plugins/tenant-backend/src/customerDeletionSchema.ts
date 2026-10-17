import type { Knex } from 'knex';
import { isPostgresClient } from './membershipLookup';

export async function lockTenantLifecycle(tx: Knex.Transaction, tenant: string) {
  if (isPostgresClient(tx)) await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`tenant-lifecycle|${tenant}`]);
}

/** Both the root revocation fence and tenant plugin await the same schema. */
export async function ensureCustomerDeletionSchema(db: Knex) {
  await db.transaction(async tx => {
    if (isPostgresClient(tx)) await tx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['customer-deletion-schema']);
    if (!(await tx.schema.hasTable('customer_deletions'))) {
      await tx.schema.createTable('customer_deletions', table => {
        table.string('tenant_name').notNullable();
        table.string('principal_id').notNullable();
        table.string('status').notNullable();
        table.primary(['tenant_name', 'principal_id']);
        table.index(['principal_id']);
      });
    }
    await tx.raw("CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_deletion_active_tenant ON customer_deletions(tenant_name) WHERE status = 'active'");
  });
}

export class CustomerDeletionConflictError extends Error {}
