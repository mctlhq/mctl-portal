import { createHash, randomUUID } from 'crypto';
import type { Knex } from 'knex';
import type { LoggerService } from '@backstage/backend-plugin-api';
import { TenantStore } from './tenantStore';
import {
  renderWorkspaceReady,
  WorkspaceAccess,
  WorkspaceAccessReader,
} from './workspaceAccess';

const TABLE = 'workspace_ready_emails';
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
const LEASE_MS = 3 * 60 * 1000;

interface Delivery {
  id: string;
  payload: string;
  snapshot: string;
  recipient: string;
  lease_token: string;
}

/** Durable one-per-tenant/principal outbox. Never purge on tenant deletion:
 * a reused name must not resurrect a previously delivered ready notification.
 * Provider deduplication lasts 24h, so ambiguous attempts older than 23h stop
 * for reconciliation instead of silently becoming a new send.
 */
export class WorkspaceReadyOutbox {
  constructor(private readonly db: Knex) {}

  async init() {
    if (await this.db.schema.hasTable(TABLE)) return;
    try {
      await this.db.schema.createTable(TABLE, table => {
        table.string('id').primary();
        table.string('tenant_name').notNullable();
        table.string('principal_id').notNullable();
        table.unique(['tenant_name', 'principal_id']);
        table.string('recipient').notNullable();
        table.text('snapshot').notNullable();
        table.text('payload').notNullable();
        table.string('status').notNullable().defaultTo('pending');
        table.bigInteger('first_attempt_ms').nullable();
        table.bigInteger('lease_until_ms').nullable();
        table.string('lease_token').nullable();
        table.string('provider_id').nullable();
        table.bigInteger('accepted_ms').nullable();
      });
    } catch (err) {
      if (!(await this.db.schema.hasTable(TABLE))) throw err;
    }
  }

  async prepare(access: WorkspaceAccess, recipient: string) {
    const id = createHash('sha256')
      .update(JSON.stringify([access.tenant, access.principalId]))
      .digest('hex');
    await this.db(TABLE)
      .insert({
        id,
        tenant_name: access.tenant,
        principal_id: access.principalId,
        recipient,
        snapshot: JSON.stringify(access),
        payload: JSON.stringify(renderWorkspaceReady(access, recipient)),
        status: 'pending',
      })
      .onConflict(['tenant_name', 'principal_id'])
      .ignore();
    return id;
  }

  async claim(id: string, now: number): Promise<Delivery | undefined> {
    await this.db(TABLE)
      .where({ id, status: 'pending' })
      .whereNotNull('first_attempt_ms')
      .where('first_attempt_ms', '<=', now - RETRY_WINDOW_MS)
      .update({ status: 'reconcile' });
    const leaseToken = randomUUID();
    const rows = await this.db(TABLE)
      .where({ id, status: 'pending' })
      .andWhere(q =>
        q.whereNull('lease_until_ms').orWhere('lease_until_ms', '<', now),
      )
      .update({
        lease_token: leaseToken,
        lease_until_ms: now + LEASE_MS,
        first_attempt_ms: this.db.raw('COALESCE(first_attempt_ms, ?)', [now]),
      })
      .returning('*');
    return rows[0];
  }

  async finish(delivery: Delivery, providerId: string, now: number) {
    await this.db(TABLE)
      .where({
        id: delivery.id,
        lease_token: delivery.lease_token,
        status: 'pending',
      })
      .update({
        status: 'accepted',
        provider_id: providerId,
        accepted_ms: now,
        lease_until_ms: null,
        lease_token: null,
      });
  }

  async release(delivery: Delivery) {
    await this.db(TABLE)
      .where({
        id: delivery.id,
        lease_token: delivery.lease_token,
        status: 'pending',
      })
      .update({ lease_until_ms: null, lease_token: null });
  }

  async cancel(delivery: Delivery) {
    await this.db(TABLE)
      .where({
        id: delivery.id,
        lease_token: delivery.lease_token,
        status: 'pending',
      })
      .update({ status: 'cancelled', lease_until_ms: null, lease_token: null });
  }
}

export function createWorkspaceReadyProcessor(options: {
  store: Pick<TenantStore, 'listAllMembers' | 'findByName'>;
  readAccess: WorkspaceAccessReader;
  outbox: WorkspaceReadyOutbox;
  apiKey: string;
  logger: Pick<LoggerService, 'warn' | 'info'>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  return async () => {
    // A failed listing aborts the run, never becomes an empty success.
    const members = await options.store.listAllMembers();
    for (const member of members.filter(
      m => m.catalogKey === 'principal' && m.role === 'owner',
    )) {
      let delivery: Delivery | undefined;
      try {
        const tenant = await options.store.findByName(member.tenantName);
        if (
          !tenant?.contactEmail ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tenant.contactEmail)
        )
          continue;
        const current = await options.readAccess(member);
        if (current.status !== 'ready') continue;
        const id = await options.outbox.prepare(current, tenant.contactEmail);
        delivery = await options.outbox.claim(id, now());
        if (!delivery) continue;
        const snapshot: WorkspaceAccess = JSON.parse(delivery.snapshot);
        // Keep the exact provider payload across retries, but never retry an
        // old grant/recipient that the current observation no longer confirms.
        if (
          delivery.recipient !== tenant.contactEmail ||
          snapshot.role !== current.role ||
          snapshot.capabilities.some(
            c =>
              !current.capabilities.some(v => v.id === c.id && v.url === c.url),
          )
        ) {
          await options.outbox.cancel(delivery);
          continue;
        }
        const response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `workspace-ready/${delivery.id}`,
          },
          body: delivery.payload,
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok)
          throw new Error(`Email provider returned ${response.status}`);
        const body: unknown = await response.json();
        const providerId = (body as { id?: unknown } | null)?.id;
        if (typeof providerId !== 'string' || !providerId)
          throw new Error('Email provider response has no message id');
        await options.outbox.finish(delivery, providerId, now());
        options.logger.info(
          `[WorkspaceReady] Ready email accepted for ${member.tenantName}`,
        );
      } catch (err) {
        // Independent of create-tenant: delivery/observation failures never
        // fail provisioning or claim a workspace is ready.
        if (delivery) await options.outbox.release(delivery);
        options.logger.warn(
          `[WorkspaceReady] Check/delivery will retry for ${
            member.tenantName
          }: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    }
  };
}
