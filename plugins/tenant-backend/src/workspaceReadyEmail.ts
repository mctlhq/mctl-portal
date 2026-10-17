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

const deliveryKey = (tenant: string, principal: string) =>
  createHash('sha256')
    .update(JSON.stringify([tenant, principal]))
    .digest('hex');

interface Delivery {
  id: string;
  payload: string;
  snapshot: string;
  recipient: string;
  lease_token: string;
  had_prior_attempt: boolean;
}

/** Durable one-per-tenant/principal outbox. Never purge on tenant deletion:
 * a reused name must not resurrect a previously delivered ready notification.
 * Provider deduplication lasts 24h, so ambiguous attempts older than 23h stop
 * for reconciliation instead of silently becoming a new send.
 */
export class WorkspaceReadyOutbox {
  constructor(
    private readonly db: Knex,
    private readonly logger?: Pick<LoggerService, 'warn'>,
  ) {}

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
        table.string('reconcile_reason').nullable();
      });
    } catch (err) {
      if (!(await this.db.schema.hasTable(TABLE))) throw err;
    }
  }

  async prepare(access: WorkspaceAccess, recipient: string, from?: string) {
    const id = deliveryKey(access.tenant, access.principalId);
    await this.db(TABLE)
      .insert({
        id,
        tenant_name: access.tenant,
        principal_id: access.principalId,
        recipient,
        snapshot: JSON.stringify(access),
        payload: JSON.stringify(renderWorkspaceReady(access, recipient, from)),
        status: 'pending',
      })
      .onConflict(['tenant_name', 'principal_id'])
      .ignore();
    return id;
  }

  private async expire(now: number, id?: string) {
    let query = this.db(TABLE)
      .where({ status: 'pending' })
      .whereNotNull('first_attempt_ms')
      .where('first_attempt_ms', '<=', now - RETRY_WINDOW_MS);
    if (id) query = query.andWhere({ id });
    const rows = await query
      .update({ status: 'reconcile', reconcile_reason: 'dedup_window_expired' })
      .returning('id');
    for (const row of rows)
      this.logger?.warn(
        `[WorkspaceReady] Delivery ${row.id} needs reconciliation: dedup_window_expired`,
      );
  }

  async eligible(ids: string[], now: number): Promise<Set<string>> {
    await this.expire(now);
    const eligible = new Set(ids);
    // Bounded SQL parameter lists; completed work never triggers HTTP reads.
    for (let start = 0; start < ids.length; start += 500) {
      const rows = await this.db(TABLE)
        .whereIn('id', ids.slice(start, start + 500))
        .select('id', 'status', 'lease_until_ms');
      for (const row of rows) {
        if (
          row.status !== 'pending' ||
          (row.lease_until_ms !== null && Number(row.lease_until_ms) >= now)
        )
          eligible.delete(row.id);
      }
    }
    return eligible;
  }

  async claim(id: string, now: number): Promise<Delivery | undefined> {
    await this.expire(now, id);
    return this.db.transaction(async tx => {
      const previous = await tx(TABLE)
        .where({ id, status: 'pending' })
        .forUpdate()
        .first();
      if (
        !previous ||
        (previous.lease_until_ms !== null &&
          Number(previous.lease_until_ms) >= now)
      )
        return undefined;
      const rows = await tx(TABLE)
        .where({ id, status: 'pending' })
        .update({
          lease_token: randomUUID(),
          lease_until_ms: now + LEASE_MS,
          first_attempt_ms: previous.first_attempt_ms ?? now,
        })
        .returning('*');
      return rows[0]
        ? { ...rows[0], had_prior_attempt: previous.first_attempt_ms !== null }
        : undefined;
    });
  }

  async finish(delivery: Delivery, providerId: string, now: number) {
    const changed = await this.db(TABLE)
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
    if (changed !== 1)
      throw new Error('Ready email acceptance lost its delivery lease');
  }

  async release(delivery: Delivery, definiteRefusal = false) {
    await this.db(TABLE)
      .where({
        id: delivery.id,
        lease_token: delivery.lease_token,
        status: 'pending',
      })
      .update({
        lease_until_ms: null,
        lease_token: null,
        // A refusal cannot erase an older ambiguous/crashed attempt.
        ...(definiteRefusal && !delivery.had_prior_attempt
          ? { first_attempt_ms: null }
          : {}),
      });
  }

  async refreshUnsent(
    delivery: Delivery,
    access: WorkspaceAccess,
    recipient: string,
    from?: string,
  ) {
    if (delivery.had_prior_attempt)
      throw new Error('Cannot replace an ambiguous delivery snapshot');
    const changed = await this.db(TABLE)
      .where({
        id: delivery.id,
        lease_token: delivery.lease_token,
        status: 'pending',
      })
      .update({
        recipient,
        snapshot: JSON.stringify(access),
        payload: JSON.stringify(renderWorkspaceReady(access, recipient, from)),
        first_attempt_ms: null,
        lease_until_ms: null,
        lease_token: null,
      });
    if (changed !== 1)
      throw new Error('Ready email snapshot lost its delivery lease');
  }

  async reconcile(delivery: Delivery) {
    const changed = await this.db(TABLE)
      .where({
        id: delivery.id,
        lease_token: delivery.lease_token,
        status: 'pending',
      })
      .update({
        status: 'reconcile',
        reconcile_reason: 'recipient_or_grants_changed',
        lease_until_ms: null,
        lease_token: null,
      });
    if (changed)
      this.logger?.warn(
        `[WorkspaceReady] Delivery ${delivery.id} needs reconciliation: recipient_or_grants_changed`,
      );
  }
}

export function createWorkspaceReadyProcessor(options: {
  store: Pick<TenantStore, 'listAllMembers' | 'findByName'>;
  readAccess: WorkspaceAccessReader;
  outbox: WorkspaceReadyOutbox;
  apiKey: string;
  from?: string;
  logger: Pick<LoggerService, 'warn' | 'info'>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const retries = new Map<string, { failures: number; after: number }>();
  return async () => {
    // A failed listing aborts the run, never becomes an empty success.
    const members = await options.store.listAllMembers();
    const candidates = members.filter(
      m => m.catalogKey === 'principal' && m.role === 'owner',
    );
    const ids = candidates.map(m =>
      deliveryKey(m.tenantName, m.principalId ?? ''),
    );
    const currentIds = new Set(ids);
    for (const key of retries.keys())
      if (!currentIds.has(key)) retries.delete(key);
    const eligible = await options.outbox.eligible(ids, now());
    for (const member of candidates) {
      const key = deliveryKey(member.tenantName, member.principalId ?? '');
      if (!eligible.has(key)) {
        retries.delete(key);
        continue;
      }
      if ((retries.get(key)?.after ?? 0) > now()) continue;
      let delivery: Delivery | undefined;
      let definiteRefusal = false;
      try {
        const tenant = await options.store.findByName(member.tenantName);
        if (
          !tenant?.contactEmail ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tenant.contactEmail)
        )
          throw new Error('Workspace contact address is missing or invalid');
        const current = await options.readAccess(member);
        if (current.status !== 'ready') {
          retries.delete(key);
          continue;
        }
        const id = await options.outbox.prepare(
          current,
          tenant.contactEmail,
          options.from,
        );
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
          // An ambiguous first attempt may already have been delivered. A new
          // generation/key could duplicate it, so operator reconciliation is
          // required instead of silently starting a new notification.
          if (delivery.had_prior_attempt) {
            await options.outbox.reconcile(delivery);
          } else {
            // All prior sends were explicitly refused, so no delivery can be
            // duplicated. Keep the same key and retry a fresh snapshot.
            await options.outbox.refreshUnsent(
              delivery,
              current,
              tenant.contactEmail,
              options.from,
            );
          }
          retries.delete(key);
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
        if (!response.ok) {
          // These responses explicitly refuse this send. All transport errors,
          // 5xx, malformed successes and idempotency conflicts stay ambiguous.
          definiteRefusal = [400, 401, 403, 404, 422, 429].includes(
            response.status,
          );
          throw new Error(`Email provider returned ${response.status}`);
        }
        const body: unknown = await response.json();
        const providerId = (body as { id?: unknown } | null)?.id;
        if (typeof providerId !== 'string' || !providerId)
          throw new Error('Email provider response has no message id');
        await options.outbox.finish(delivery, providerId, now());
        retries.delete(key);
        options.logger.info(
          `[WorkspaceReady] Ready email accepted for ${member.tenantName}`,
        );
      } catch (err) {
        // Independent of create-tenant: delivery/observation failures never
        // fail provisioning or claim a workspace is ready.
        if (delivery) await options.outbox.release(delivery, definiteRefusal);
        const failures = (retries.get(key)?.failures ?? 0) + 1;
        const delay = Math.min(
          15 * 60_000,
          60_000 * 2 ** Math.min(failures - 1, 4),
        );
        retries.set(key, { failures, after: now() + delay });
        options.logger.warn(
          `[WorkspaceReady] Check/delivery will retry for ${
            member.tenantName
          }: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    }
  };
}
