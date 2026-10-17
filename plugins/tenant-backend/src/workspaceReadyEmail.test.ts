import knexLib, { Knex } from 'knex';
import {
  WorkspaceReadyOutbox,
  createWorkspaceReadyProcessor,
} from './workspaceReadyEmail';
import { WorkspaceAccess } from './workspaceAccess';
import { TenantMember } from './types';

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
  const outbox = new WorkspaceReadyOutbox(db);
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
    logger: { warn: jest.fn(), info: jest.fn() },
    fetchImpl,
    now: () => clock,
  });
  return {
    outbox,
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
  await f.process();
  expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  expect((await db('workspace_ready_emails').first()).status).toBe('cancelled');
});

it('does not confuse a provider failure or malformed success with acceptance', async () => {
  const f = await fixture();
  f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  await f.process();
  expect((await db('workspace_ready_emails').first()).status).toBe('pending');
  f.fetchImpl.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  await f.process();
  expect((await db('workspace_ready_emails').first()).status).toBe('pending');
});
