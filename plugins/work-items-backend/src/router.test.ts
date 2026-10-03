import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createRouter, toSurfaceActorId } from './router';
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

/**
 * Copied from mctl-api internal/surfaceid/store.go,
 * externalIDPattern[SurfacePortal]. mctl-api answers 400 invalid_request to any
 * relay or redeem call whose X-MCTL-Surface-Actor does not match it. If
 * mctl-api changes the pattern, update this copy and CONTRACT.md "Actor id".
 */
const MCTL_API_PORTAL_EXTERNAL_ID = /^[A-Za-z0-9._:@|-]{1,256}$/;

describe('toSurfaceActorId', () => {
  const valid = [
    'user:default/alice',
    'User:Default/Alice',
    'user:default/alice.smith',
    'user:default/a_b-c.d',
    'user:my-org/bob',
    'user:my_org/alice',
    'user:my.org/alice',
    'user:default/john..doe',
    'user:default/a--b',
    'user:default/a_.b',
    'user:a/b',
    `user:${'n'.repeat(63)}/${'x'.repeat(63)}`,
  ];

  it('always emits an id that mctl-api accepts', () => {
    for (const ref of valid) {
      const id = toSurfaceActorId(ref);
      expect(id).toBeDefined();
      expect(id).toMatch(MCTL_API_PORTAL_EXTERNAL_ID);
    }
  });

  it('encodes user:<namespace>/<name> as user:<namespace>:<name>, lowercased', () => {
    expect(toSurfaceActorId('user:default/alice')).toBe('user:default:alice');
    expect(toSurfaceActorId('User:Default/Alice')).toBe('user:default:alice');
    expect(toSurfaceActorId('user:my-org/bob.s')).toBe('user:my-org:bob.s');
    // Backstage's isValidObjectName for both parts: `_`/`.` in a namespace,
    // repeated or adjacent separators inside a name.
    expect(toSurfaceActorId('user:my_org/alice')).toBe('user:my_org:alice');
    expect(toSurfaceActorId('user:My.Org/Alice')).toBe('user:my.org:alice');
    expect(toSurfaceActorId('user:default/john..doe')).toBe('user:default:john..doe');
    expect(toSurfaceActorId('user:default/a--b')).toBe('user:default:a--b');
    expect(toSurfaceActorId('user:default/a_.b')).toBe('user:default:a_.b');
  });

  it('is collision-free: distinct users never share an id', () => {
    const refs = [
      'user:a/b-c',
      'user:a-b/c',
      'user:a.b/c',
      'user:a/b.c',
      'user:a_b/c',
      'user:a/b_c',
      'user:my_org/alice',
      'user:my.org/alice',
      'user:my-org/alice',
      'user:default/alice',
      'user:other/alice',
      'user:default/alice.x',
      'user:default/alice-x',
      'user:default/john..doe',
      'user:default/john.doe',
    ];
    const ids = refs.map(toSurfaceActorId);
    expect(new Set(ids).size).toBe(refs.length);
    for (const id of ids) {
      expect(id!.split(':')).toHaveLength(3);
    }
  });

  it('refuses anything outside the Backstage user-ref grammar instead of escaping it', () => {
    for (const ref of [
      '',
      'alice',
      'group:default/admins',
      'user:default/a:b',
      'user:a:b/c',
      'user:default/a/b',
      'user:default/a b',
      'user:default/-alice',
      'user:default/alice-',
      'user:default/alice.',
      'user:_org/alice',
      'user:org./alice',
      'user:default/alice@example.com',
      `user:default/${'x'.repeat(64)}`,
      `user:${'n'.repeat(64)}/alice`,
    ]) {
      expect(toSurfaceActorId(ref)).toBeUndefined();
    }
  });
});

describe('work-items router', () => {
  let server: Server;
  let base: string;

  type StartOpts = {
    as?: 'user' | 'service' | 'none';
    actionsEnabled?: boolean;
    userEntityRef?: string;
    ownershipEntityRefs?: string[];
    logger?: unknown;
  };
  async function start(client: WorkItemsClient, opts: StartOpts = {}) {
    const as = opts.as ?? 'user';
    const httpAuth = {
      credentials: jest.fn(async (_req: unknown, o?: { allow?: string[] }) => {
        if (as === 'none' || (as === 'service' && o?.allow?.includes('user') && !o.allow.includes('service'))) {
          throw new Error('no user');
        }
        return { principal: { type: as } };
      }),
    } as any;
    const userInfo = {
      getUserInfo: jest.fn().mockResolvedValue({
        userEntityRef: opts.userEntityRef ?? 'user:default/alice',
        ownershipEntityRefs: opts.ownershipEntityRefs ?? [],
      }),
    } as any;
    const app = express();
    app.use(
      createRouter({
        logger: (opts.logger ?? { error: jest.fn(), warn: jest.fn(), info: jest.fn() }) as any,
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
    expect(c.getWorkItem).toHaveBeenCalledWith('wi_1', 'user:default:alice');
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
    expect(c.createExecutionRequest).toHaveBeenCalledWith('wi_1', 'user:default:alice', {
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

  it('400s a malformed idempotencyKey or resumedFromExecutionId with no upstream call', async () => {
    const c = fakeClient();
    await start(c, { actionsEnabled: true });
    for (const extra of [
      { idempotencyKey: 'a\r\nb' },
      { idempotencyKey: 'x'.repeat(129) },
      { idempotencyKey: '' },
      { idempotencyKey: 42 },
      { resumedFromExecutionId: 'we_1\r\nX: y' },
      { resumedFromExecutionId: 'x'.repeat(129) },
    ]) {
      const res = await post('/work-items/wi_1/execution-requests', { kind: 'resume', expectedStateVersion: 1, ...extra });
      expect(res.status).toBe(400);
    }
    expect(c.createExecutionRequest).not.toHaveBeenCalled();
    const ok = await post('/work-items/wi_1/execution-requests', {
      kind: 'resume',
      expectedStateVersion: 1,
      idempotencyKey: 'portal-0b6f2c1e-7d3a-4c55-9a1e-2f6b8e9d0c11',
      resumedFromExecutionId: 'we_0b6f2c1e-7d3a-4c55-9a1e-2f6b8e9d0c11',
    });
    expect(ok.status).toBe(201);
  });

  it('a portal admin gets no extra access: relayed as that user, mctl-api 403 passes through (T5)', async () => {
    const c = fakeClient({
      getWorkItem: jest.fn().mockRejectedValue(new MctlApiError(403, 'not visible to you', 'forbidden')),
    });
    await start(c, {
      userEntityRef: 'user:default/root-admin',
      ownershipEntityRefs: ['user:default/root-admin', 'group:default/admins', 'group:default/platform-admins'],
    });
    const res = await fetch(`${base}/work-items/wi_1`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: 'not visible to you', code: 'forbidden' });
    expect(body.id).toBeUndefined();
    // Relayed exactly once, as the user themself; there is no retry under
    // another identity and no portal-side grant.
    expect(c.getWorkItem).toHaveBeenCalledTimes(1);
    expect(c.getWorkItem).toHaveBeenCalledWith('wi_1', 'user:default:root-admin');
  });

  it('refuses a caller whose entity ref cannot be a portal actor, with no upstream call', async () => {
    for (const ref of ['group:default/admins', 'user:default/a:b', 'user:default/a/b', 'user:Default Space/alice', '']) {
      const c = fakeClient();
      const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
      await start(c, { userEntityRef: ref, logger });
      expect((await fetch(`${base}/work-items/wi_1`)).status).toBe(401);
      expect((await post('/surface-identities/redeem', { code: 'ABC' })).status).toBe(401);
      expect(c.getWorkItem).not.toHaveBeenCalled();
      expect(c.redeemIdentity).not.toHaveBeenCalled();
      // The refusal names the ref (a catalog id, not a secret).
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(ref)));
      const running = server;
      await new Promise<void>(r => running.close(() => r()));
    }
    await start(fakeClient());
  });

  it('never logs the redeem code (T8)', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    const logger = { error: jest.fn(capture), warn: jest.fn(capture), info: jest.fn(capture), debug: jest.fn(capture) };
    const code = 'K7QX-9F2M-SECRET';
    const c = fakeClient();
    c.redeemIdentity
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new MctlApiError(403, 'challenge invalid', 'challenge_invalid'))
      .mockRejectedValueOnce(new MctlApiError(502, 'mctl-api upstream error 500'))
      .mockRejectedValueOnce(new Error('route POST /api/v1/surface-identities/redeem is not on the surface relay allowlist'));
    await start(c, { logger });
    for (let i = 0; i < 4; i++) await post('/surface-identities/redeem', { code });
    expect(c.redeemIdentity).toHaveBeenCalledTimes(4);
    expect(logger.error).toHaveBeenCalled();
    expect(lines.join('\n')).not.toContain(code);
  });

  it('redeem forwards the code with the caller as actor and passes errors through (T8)', async () => {
    const c = fakeClient();
    await start(c);
    expect((await post('/surface-identities/redeem', { code: 'ABC' })).status).toBe(201);
    expect(c.redeemIdentity).toHaveBeenCalledWith('ABC', 'user:default:alice');
    c.redeemIdentity.mockRejectedValueOnce(new MctlApiError(403, 'refused', 'forbidden'));
    expect((await post('/surface-identities/redeem', { code: 'ABC' })).status).toBe(403);
    expect((await post('/surface-identities/redeem', {})).status).toBe(400);
  });
});
