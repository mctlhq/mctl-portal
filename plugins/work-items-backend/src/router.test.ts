import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createRouter } from './router';
import { MctlApiError, WorkItemsClient } from './mctlApiClient';

function fakeClient(over: Partial<WorkItemsClient> = {}): jest.Mocked<WorkItemsClient> {
  return {
    isConfigured: jest.fn().mockReturnValue(true),
    getWorkItem: jest.fn().mockResolvedValue({ id: 'wi_1' }),
    createExecutionRequest: jest.fn().mockResolvedValue({ executionRequest: { id: 'xr_1' }, replay: false }),
    redeemIdentity: jest.fn().mockResolvedValue(undefined),
    ...over,
  } as jest.Mocked<WorkItemsClient>;
}

describe('work-items router', () => {
  let server: Server;
  let base: string;

  async function start(client: WorkItemsClient, opts: { as?: 'user' | 'service' | 'none'; actionsEnabled?: boolean } = {}) {
    const as = opts.as ?? 'user';
    const httpAuth = {
      credentials: jest.fn(async (_req: unknown, o?: { allow?: string[] }) => {
        if (as === 'none' || (as === 'service' && o?.allow?.includes('user') && !o.allow.includes('service'))) {
          throw new Error('no user');
        }
        return { principal: { type: as } };
      }),
    } as any;
    const userInfo = { getUserInfo: jest.fn().mockResolvedValue({ userEntityRef: 'user:default/alice', ownershipEntityRefs: [] }) } as any;
    const app = express();
    app.use(
      createRouter({
        logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as any,
        workItems: client,
        httpAuth,
        userInfo,
        actionsEnabled: opts.actionsEnabled ?? false,
      }),
    );
    await new Promise<void>(r => {
      server = app.listen(0, () => r());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())));

  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('GET: 401 without a user, 401 for service credentials, 400 for a bad id (T5)', async () => {
    const c = fakeClient();
    await start(c, { as: 'none' });
    expect((await fetch(`${base}/work-items/wi_1`)).status).toBe(401);
    await new Promise<void>(r => server.close(() => r()));
    await start(c, { as: 'service' });
    expect((await fetch(`${base}/work-items/wi_1`)).status).toBe(401);
    await new Promise<void>(r => server.close(() => r()));
    await start(c);
    expect((await fetch(`${base}/work-items/not-an-id`)).status).toBe(400);
    expect(c.getWorkItem).not.toHaveBeenCalled();
  });

  it('GET: relays as the caller, passes upstream errors through (T5)', async () => {
    const c = fakeClient();
    await start(c);
    expect((await fetch(`${base}/work-items/wi_1`)).status).toBe(200);
    expect(c.getWorkItem).toHaveBeenCalledWith('wi_1', 'user:default/alice');
    c.getWorkItem.mockRejectedValueOnce(new MctlApiError(403, 'x', 'link_required'));
    const r403 = await fetch(`${base}/work-items/wi_1`);
    expect(r403.status).toBe(403);
    expect(await r403.json()).toEqual({ error: 'x', code: 'link_required' });
    c.getWorkItem.mockRejectedValueOnce(new MctlApiError(404, 'none', 'work_item_not_found'));
    expect((await fetch(`${base}/work-items/wi_1`)).status).toBe(404);
    c.getWorkItem.mockRejectedValueOnce(new MctlApiError(502, 'down'));
    expect((await fetch(`${base}/work-items/wi_1`)).status).toBe(502);
  });

  it('GET: 503 and no upstream call when the surface token is unset (T5)', async () => {
    const c = fakeClient({ isConfigured: jest.fn().mockReturnValue(false) });
    await start(c);
    const res = await fetch(`${base}/work-items/wi_1`);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('work_items_unconfigured');
    expect(c.getWorkItem).not.toHaveBeenCalled();
  });

  it('mutations answer 403 actions_disabled with no upstream call; no /actions route (T6)', async () => {
    const c = fakeClient();
    await start(c);
    const res = await post('/work-items/wi_1/execution-requests', { kind: 'resume', expectedStateVersion: 1 });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('actions_disabled');
    expect(c.createExecutionRequest).not.toHaveBeenCalled();
    expect((await post('/work-items/wi_1/actions/x', {})).status).toBe(404);
  });

  it('forwards an enabled mutation with the caller and returns upstream errors as-is (T7)', async () => {
    const c = fakeClient();
    await start(c, { actionsEnabled: true });
    const res = await post('/work-items/wi_1/execution-requests', {
      kind: 'resume',
      expectedStateVersion: 4,
      idempotencyKey: 'k1',
      engine: 'argo',
      engine_ref: 'x',
      execution_id: 'we_1',
    });
    expect(res.status).toBe(201);
    expect(c.createExecutionRequest).toHaveBeenCalledWith('wi_1', 'user:default/alice', {
      kind: 'resume',
      expectedStateVersion: 4,
      resumedFromExecutionId: undefined,
      intentId: undefined,
      idempotencyKey: 'k1',
    });
    c.createExecutionRequest.mockRejectedValueOnce(new MctlApiError(409, 'stale', 'state_version_conflict'));
    const conflict = await post('/work-items/wi_1/execution-requests', { kind: 'resume', expectedStateVersion: 1 });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe('state_version_conflict');
    expect((await post('/work-items/wi_1/execution-requests', { kind: 'bogus' })).status).toBe(400);
  });

  it('redeem forwards the code with the caller as actor and passes errors through (T8)', async () => {
    const c = fakeClient();
    await start(c);
    expect((await post('/surface-identities/redeem', { code: 'ABC' })).status).toBe(201);
    expect(c.redeemIdentity).toHaveBeenCalledWith('ABC', 'user:default/alice');
    c.redeemIdentity.mockRejectedValueOnce(new MctlApiError(403, 'refused', 'forbidden'));
    expect((await post('/surface-identities/redeem', { code: 'ABC' })).status).toBe(403);
    expect((await post('/surface-identities/redeem', {})).status).toBe(400);
  });
});
