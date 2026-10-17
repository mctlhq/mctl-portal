import knexLib, { Knex } from 'knex';
import {
  WorkspaceReadyOutbox,
  createWorkspaceReadyProcessor,
} from './workspaceReadyEmail';
import { WorkspaceAccess } from './workspaceAccess';
import { TenantMember } from './types';
import { TenantStore } from './tenantStore';

const pid = 'prn_01M39HRB7JRXZ2PHW5VVB695YZ';
const member: TenantMember = {
  tenantName: 'acme',
  principalId: pid,
  userId: pid.toLowerCase(),
  login: 'alice',
  catalogKey: 'principal',
  role: 'owner',
  invitedBy: 'system',
  invitedAt: new Date().toISOString(),
};
const access: WorkspaceAccess = {
  tenant: 'acme',
  principalId: pid,
  account: 'alice@mctl.ai',
  role: 'owner',
  observedAt: new Date().toISOString(),
  status: 'ready',
  environments: [],
  capabilities: [
    { id: 'portal', label: 'Portal', url: 'https://app.mctl.ai/' },
  ],
  mcp: 'blocked',
  accessUrl: 'https://app.mctl.ai/workspace/access',
};
let db: Knex;
beforeEach(() => {
  db = knexLib({
    client: 'better-sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
  });
});
afterEach(async () => {
  await db.destroy();
});

async function fixture() {
  const logger = { warn: jest.fn(), info: jest.fn() };
  const tenantStore = new TenantStore({ getClient: async () => db } as any, logger as any);
  await tenantStore.init();
  await db('tenants').insert({ name: 'acme', display_name: 'Acme', quotas: '{}', networking: '{}', contact_email: 'alice@example.com', synced_at: new Date().toISOString() });
  await tenantStore.seedMember('acme', { ...member, catalogKey: 'principal' });
  const outbox = new WorkspaceReadyOutbox(db, logger);
  await outbox.init();
  const store = {
    listAllMembers: jest.fn().mockResolvedValue([member]),
    findByName: jest
      .fn()
      .mockResolvedValue({ contactEmail: 'alice@example.com' }),
  };
  const readAccess = jest.fn().mockResolvedValue(access);
  const fetchImpl = jest
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }),
    );
  let clock = Date.now();
  const process = createWorkspaceReadyProcessor({
    store: store as any,
    readAccess,
    outbox,
    apiKey: 'test',
    logger,
    fetchImpl,
    now: () => clock,
  });
  return {
    outbox,
    tenantStore,
    logger,
    store,
    readAccess,
    fetchImpl,
    process,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

it('sends once across repeated and concurrent workers using the durable key', async () => {
  const f = await fixture();
  await Promise.all([f.process(), f.process()]);
  await f.process();
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  const row = await db('workspace_ready_emails').first();
  expect(row.status).toBe('accepted');
  expect(row.provider_id).toBe('email-1');
});

it('retries ambiguous delivery with exactly the same key and payload', async () => {
  const f = await fixture();
  f.fetchImpl.mockRejectedValueOnce(new Error('network timeout'));
  await f.process();
  f.readAccess.mockResolvedValue({
    ...access,
    observedAt: new Date(Date.now() + 5000).toISOString(),
  });
  f.advance(60_000);
  await f.process();
  expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  const a = f.fetchImpl.mock.calls[0][1];
  const b = f.fetchImpl.mock.calls[1][1];
  expect(a.headers['Idempotency-Key']).toBe(b.headers['Idempotency-Key']);
  expect(a.body).toBe(b.body);
});

it('stops ambiguous retry before the provider deduplication key expires', async () => {
  const f = await fixture();
  f.fetchImpl.mockRejectedValue(new Error('timeout'));
  await f.process();
  f.advance(23 * 60 * 60 * 1000);
  await f.process();
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect((await db('workspace_ready_emails').first()).status).toBe('reconcile');
});

it.each(['unknown', 'provisioning', 'revoked'])(
  'does not send for %s readiness',
  async state => {
    const f = await fixture();
    if (state === 'unknown')
      f.readAccess.mockRejectedValue(new Error('unknown'));
    if (state === 'provisioning')
      f.readAccess.mockResolvedValue({ ...access, status: 'provisioning' });
    if (state === 'revoked') f.store.listAllMembers.mockResolvedValue([]);
    await f.process();
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(await db('workspace_ready_emails')).toHaveLength(0);
  },
);

it('does not retry a snapshot after a grant is revoked', async () => {
  const f = await fixture();
  f.fetchImpl.mockRejectedValueOnce(new Error('timeout'));
  await f.process();
  f.readAccess.mockResolvedValue({ ...access, capabilities: [] });
  f.advance(60_000);
  await f.process();
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect((await db('workspace_ready_emails').first()).status).toBe('reconcile');
});

it('does not confuse a provider failure or malformed success with acceptance', async () => {
  const f = await fixture();
  f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await f.process();
  expect((await db('workspace_ready_emails').first()).status).toBe('pending');
  f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  f.advance(60_000);
  await f.process();
  expect((await db('workspace_ready_emails').first()).status).toBe('pending');
});

it('skips accepted jobs before any further platform/catalog observation', async () => {
  const f = await fixture();
  await f.process();
  f.readAccess.mockClear();
  f.store.findByName.mockClear();
  await f.process();
  await f.process();
  expect(f.readAccess).not.toHaveBeenCalled();
  expect(f.store.findByName).not.toHaveBeenCalled();
});

it('requires observable reconciliation after an ambiguous send and recipient correction', async () => {
  const f = await fixture();
  f.fetchImpl.mockRejectedValueOnce(new Error('timeout'));
  await f.process();
  f.store.findByName.mockResolvedValue({
    contactEmail: 'corrected@example.com',
  });
  f.advance(60_000);
  await f.process();
  const row = await db('workspace_ready_emails').first();
  expect(row.status).toBe('reconcile');
  expect(row.reconcile_reason).toBe('recipient_or_grants_changed');
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.stringContaining(
      'needs reconciliation: recipient_or_grants_changed',
    ),
  );
  f.readAccess.mockClear();
  f.advance(60_000);
  await f.process();
  expect(f.readAccess).not.toHaveBeenCalled();
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
});

it('logs the expired-key transition once and does not observe that job again', async () => {
  const f = await fixture();
  f.fetchImpl.mockRejectedValueOnce(new Error('timeout'));
  await f.process();
  f.logger.warn.mockClear();
  f.readAccess.mockClear();
  f.advance(23 * 60 * 60 * 1000);
  await f.process();
  await f.process();
  expect(f.logger.warn).toHaveBeenCalledTimes(1);
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.stringContaining('dedup_window_expired'),
  );
  expect(f.readAccess).not.toHaveBeenCalled();
});

it('backs off failed observations instead of producing a warning each tick', async () => {
  const f = await fixture();
  f.readAccess.mockRejectedValue(new Error('platform offline'));
  await f.process();
  await f.process();
  expect(f.readAccess).toHaveBeenCalledTimes(1);
  f.advance(60_000);
  await f.process();
  expect(f.readAccess).toHaveBeenCalledTimes(2);
  f.advance(60_000);
  await f.process();
  expect(f.readAccess).toHaveBeenCalledTimes(2);
  f.advance(60_000);
  await f.process();
  expect(f.readAccess).toHaveBeenCalledTimes(3);
});

it('recovers after explicit provider refusals exceed the deduplication window', async () => {
  const f = await fixture();
  f.fetchImpl.mockResolvedValue(new Response('{}', { status: 403 }));
  await f.process();
  f.advance(24 * 60 * 60_000);
  await f.process();
  expect(
    (await db('workspace_ready_emails').first()).first_attempt_ms,
  ).toBeNull();
  f.advance(16 * 60_000);
  f.fetchImpl.mockResolvedValue(
    new Response(JSON.stringify({ id: 'fixed-key' }), { status: 200 }),
  );
  await f.process();
  expect((await db('workspace_ready_emails').first()).status).toBe('accepted');
});

it('does not erase an older ambiguous attempt after a later explicit refusal', async () => {
  const f = await fixture();
  f.fetchImpl.mockRejectedValueOnce(new Error('timeout'));
  await f.process();
  f.advance(60_001);
  f.fetchImpl.mockResolvedValue(new Response('{}', { status: 401 }));
  await f.process();
  expect(
    (await db('workspace_ready_emails').first()).first_attempt_ms,
  ).not.toBeNull();
  f.advance(24 * 60 * 60_000);
  await f.process();
  expect((await db('workspace_ready_emails').first()).status).toBe('reconcile');
});

it('does not report acceptance when another worker owns the delivery lease', async () => {
  const f = await fixture();
  const id = await f.outbox.prepare(access, 'alice@example.com');
  const delivery = await f.outbox.claim(id, Date.now());
  await db('workspace_ready_emails')
    .where({ id })
    .update({ lease_token: 'another-worker' });
  await expect(
    f.outbox.finish(delivery!, 'accepted-id', Date.now()),
  ).rejects.toThrow('lost its delivery lease');
  expect((await db('workspace_ready_emails').first()).status).toBe('pending');
});

it.each(['recipient', 'capability'])(
  'refreshes a never-dispatched snapshot after refusal and %s change',
  async change => {
    const f = await fixture();
    const withMcp = {
      ...access,
      capabilities: [
        ...access.capabilities,
        { id: 'mcp', label: 'MCP', url: 'https://api.mctl.ai/mcp' },
      ],
      mcp: 'available',
    };
    f.readAccess.mockResolvedValue(withMcp);
    f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await f.process();
    f.advance(60_001);
    if (change === 'recipient')
      f.store.findByName.mockResolvedValue({
        contactEmail: 'corrected@example.com',
      });
    else f.readAccess.mockResolvedValue(access);
    await f.process();
    expect((await db('workspace_ready_emails').first()).status).toBe('pending');
    await f.process();
    expect((await db('workspace_ready_emails').first()).status).toBe(
      'accepted',
    );
    const sent = JSON.parse(f.fetchImpl.mock.calls[1][1].body);
    if (change === 'recipient')
      expect(sent.to).toEqual(['corrected@example.com']);
    else expect(sent.text).not.toContain('https://api.mctl.ai/mcp');
    expect(f.fetchImpl.mock.calls[1][1].headers['Idempotency-Key']).toBe(
      f.fetchImpl.mock.calls[0][1].headers['Idempotency-Key'],
    );
  },
);

it('does not recreate an email after deletion while access observation was in flight', async () => {
 const f = await fixture();
 f.readAccess.mockImplementationOnce(async () => { await f.tenantStore.delete('acme'); return access; });
 await f.process();
 expect(f.fetchImpl).not.toHaveBeenCalled();
 expect(await db('workspace_ready_emails')).toEqual([]);
});
