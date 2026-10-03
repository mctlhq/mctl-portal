import * as fs from 'fs';
import * as path from 'path';
import { MctlApiError, MctlApiWorkItemsClient, isRelayAllowed, toPortalWorkItem } from './mctlApiClient';

const VIEW = {
  schema_version: 'workitem/v1',
  state_version: 3,
  work_item: {
    id: 'wi_abc',
    tenant: 'acme',
    owner_principal: 'github:alice',
    visibility: 'tenant',
    origin_surface: 'telegram',
    title: 'Fix it',
    state: 'waiting',
    waiting_reason: 'input',
    state_version: 3,
    created_by: 'github:alice',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
    content: 'secret chat',
    messages: ['hi'],
    transcript: 'x',
  },
  latest_execution: { id: 'we_1', engine: 'temporal', engine_ref: 'dev-loop-x', attempt: 1, phase: 'Running', started_at: '2026-10-01T01:00:00Z' },
  latest_snapshot: { id: 'cs_1', execution_id: 'we_1', content_hash: 'sha256:aa' },
  links: [{ url: 'javascript:alert(1)' }],
};
const unknownReq = { state: 'unknown' as const, reason: 'x' };

function jsonResp(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status });
}

describe('toPortalWorkItem', () => {
  it('maps the pinned fixture (T1)', () => {
    const w = toPortalWorkItem(VIEW, { state: 'ok', value: [] });
    expect(w).toMatchObject({ id: 'wi_abc', state: 'waiting', waitingReason: 'input', stateVersion: 3, tenant: 'acme' });
    expect(w.latestExecution).toEqual({
      state: 'ok',
      value: { id: 'we_1', attempt: 1, phase: 'Running', startedAt: '2026-10-01T01:00:00Z', endedAt: undefined, resumedFromExecutionId: undefined },
    });
    expect(w.latestSnapshot).toEqual({ state: 'ok', value: { id: 'cs_1', executionId: 'we_1', contentHash: 'sha256:aa' } });
  });

  it('marks relay-unobservable sections unknown, never empty (T2)', () => {
    const w = toPortalWorkItem(VIEW, unknownReq);
    for (const k of ['executions', 'snapshots', 'evidence'] as const) {
      expect(w[k]).toEqual({ state: 'unknown', reason: 'not_available_via_relay' });
    }
    const stale = toPortalWorkItem(VIEW, { state: 'stale', value: [], observedAt: '2026-10-01T00:00:00Z' });
    expect(stale.executionRequests).toMatchObject({ state: 'stale', observedAt: '2026-10-01T00:00:00Z' });
  });

  it('drops content fields, engine identity and unsafe links (T3)', () => {
    const w = toPortalWorkItem(VIEW, unknownReq, [
      { label: 'bad', url: 'javascript:alert(1)' },
      { label: 'ok', url: 'https://canvas.example/x' },
    ]);
    const s = JSON.stringify(w);
    for (const f of ['"content"', '"messages"', '"transcript"', 'engine_ref', 'dev-loop-x', 'owner_principal']) {
      expect(s).not.toContain(f);
    }
    expect(w.links).toEqual([{ label: 'ok', url: 'https://canvas.example/x' }]);
  });
});

describe('MctlApiWorkItemsClient (T4)', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  const client = () => new MctlApiWorkItemsClient({ baseUrl: 'http://api.test/', surfaceToken: 'tok-secret' });
  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it('sends the surface token and actor on every request', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp(200, VIEW))
      .mockResolvedValueOnce(jsonResp(200, { execution_requests: [{ id: 'xr_1', kind: 'resume', state: 'pending', claimed_by: 'service:x' }] }));
    const w = await client().getWorkItem('wi_abc', 'user:default/alice');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.Authorization).toBe('Bearer tok-secret');
      expect(call[1].headers['X-MCTL-Surface-Actor']).toBe('user:default/alice');
    }
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/v1/work-items/wi_abc');
    expect(JSON.stringify(w)).not.toContain('claimed_by');
  });

  it('only allows relay routes', () => {
    expect(isRelayAllowed('GET', '/api/v1/work-items/wi_1')).toBe(true);
    expect(isRelayAllowed('GET', '/api/v1/work-items/wi_1/executions')).toBe(false);
    expect(isRelayAllowed('POST', '/api/v1/work-items/wi_1/resume')).toBe(false);
    expect(isRelayAllowed('GET', '/api/v1/work-items/wi_1/events')).toBe(false);
    expect(isRelayAllowed('PATCH', '/api/v1/work-items/wi_1')).toBe(false);
  });

  it('maps 5xx to 502 without the upstream body or token', async () => {
    fetchMock.mockResolvedValue(jsonResp(500, { error: 'stack trace tok-secret' }));
    const err = await client().getWorkItem('wi_abc', 'u').catch(e => e);
    expect(err).toBeInstanceOf(MctlApiError);
    expect(err.status).toBe(502);
    expect(err.message).not.toContain('stack');
    expect(err.message).not.toContain('tok-secret');
  });

  it('maps 403 link codes to link_required and other 403 to forbidden', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(403, { error: 'x', code: 'link_not_found' }));
    expect(await client().getWorkItem('wi_abc', 'u').catch(e => e)).toMatchObject({ status: 403, code: 'link_required' });
    fetchMock.mockResolvedValueOnce(jsonResp(403, { error: 'nope', code: 'tenant_forbidden' }));
    expect(await client().getWorkItem('wi_abc', 'u').catch(e => e)).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('keeps 404 and 409 semantics', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(404, { error: 'none', code: 'work_item_not_found' }));
    expect(await client().getWorkItem('wi_abc', 'u').catch(e => e)).toMatchObject({ status: 404, code: 'work_item_not_found' });
    fetchMock.mockResolvedValueOnce(jsonResp(409, { error: 'stale', code: 'state_version_conflict', details: { state_version: 5 } }));
    expect(
      await client().createExecutionRequest('wi_abc', 'u', { kind: 'resume', expectedStateVersion: 3 }).catch(e => e),
    ).toMatchObject({ status: 409, code: 'state_version_conflict', details: { state_version: 5 } });
  });

  it('treats an empty 200 body as 502 and a timeout as 502', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(200, undefined));
    expect(await client().getWorkItem('wi_abc', 'u').catch(e => e)).toMatchObject({ status: 502 });
    fetchMock.mockRejectedValueOnce(new Error('timeout tok-secret'));
    const err = await client().getWorkItem('wi_abc', 'u').catch(e => e);
    expect(err.status).toBe(502);
    expect(err.message).not.toContain('tok-secret');
  });

  it('never sends engine identity when requesting execution', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(201, { execution_request: { id: 'xr_1', kind: 'resume', state: 'pending' } }));
    await client().createExecutionRequest('wi_abc', 'u', { kind: 'resume', expectedStateVersion: 3, idempotencyKey: 'k' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ kind: 'resume', expected_state_version: 3, idempotency_key: 'k' });
  });

  it('never reads MCTL_API_TOKEN or an admin credential (T2)', () => {
    for (const f of ['plugin.ts', 'router.ts', 'mctlApiClient.ts']) {
      expect(fs.readFileSync(path.join(__dirname, f), 'utf8')).not.toMatch(/MCTL_API_TOKEN/);
    }
  });
});
