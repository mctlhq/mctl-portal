import * as fs from 'fs';
import * as path from 'path';

// Built at runtime so the fixture is data, not a script URL literal.
const JS_URL = ['javascript', 'alert(1)'].join(':');
import { MctlApiError, MctlApiWorkItemsClient, WorkItemHistory, isRelayAllowed, toPortalWorkItem } from './mctlApiClient';

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
  links: [{ url: JS_URL }],
};
const unknownReq = { state: 'unknown' as const, reason: 'x' };
const unknownHistory: WorkItemHistory = {
  executions: { state: 'unknown', reason: 'fetch_failed' },
  snapshots: { state: 'unknown', reason: 'fetch_failed' },
  evidence: { state: 'unknown', reason: 'fetch_failed' },
  events: { state: 'unknown', reason: 'fetch_failed' },
};

// mctl-api answers a relayed history read with the direct-read body, so every
// field the portal must not forward is present here.
const HISTORY: Record<string, unknown> = {
  'execution-requests': { execution_requests: [] },
  executions: {
    schema_version: 'workitem/v1',
    executions: [
      { id: 'we_1', engine: 'temporal', engine_ref: 'dev-loop-x', attempt: 1, phase: 'Failed', started_at: 'T1', ended_at: 'T2' },
      { id: 'we_2', engine: 'argo', engine_ref: 'argo-run-y', attempt: 2, phase: 'Running', started_at: 'T3', resumed_from_execution_id: 'we_1' },
    ],
  },
  snapshots: {
    schema_version: 'workitem/v1',
    snapshots: [
      {
        id: 'cs_1',
        work_item_id: 'wi_abc',
        execution_id: 'we_1',
        execution_sequence: 1,
        content_hash: 'sha256:aa',
        strategy: 'devloop',
        strategy_version: '3',
        prior_snapshot_id: 'cs_0',
        produced_by: 'service:snapshot-producer',
        created_at: 'T1',
        schema_version: 'ctx/v1',
        canonical_b64: 'Y2Fub25pY2FsLWJ5dGVz',
      },
    ],
  },
  evidence: {
    evidence: [
      {
        id: 'ev_1',
        content_hash: 'sha256:bb',
        api_version: 'evidence/v1',
        envelope_b64: 'ZW52ZWxvcGUtYnl0ZXM=',
        execution_id: 'we_1',
        work_item_id: 'wi_abc',
        created_at: 'T2',
        ingested_by: 'service:evidence-ingester',
        ingested_by_principal_id: 'pid-ingester',
        ingested_at: 'T2',
        primary_ref_kind: 'work',
        primary_ref_id: 'we_1',
        ref: { evidence_id: 'ev_1', engine: 'temporal', engine_ref: 'dev-loop-ref-z', tenant: 'acme' },
      },
    ],
    truncated: false,
    limit: 50,
  },
  events: {
    schema_version: 'workitem/v1',
    events: [
      {
        work_item_id: 'wi_abc',
        seq: 1,
        kind: 'state_changed',
        from_state: 'active',
        to_state: 'waiting',
        actor_principal: 'github:alice',
        acting_principal: 'surface:relayer',
        surface: 'telegram',
        request_id: 'req-123',
        detail: { note: 'raw-detail' },
        created_at: 'T4',
      },
    ],
  },
};
const FORBIDDEN = [
  'engine',
  'temporal',
  'dev-loop-x',
  'argo-run-y',
  'dev-loop-ref-z',
  'produced_by',
  'snapshot-producer',
  'canonical_b64',
  'Y2Fub25pY2FsLWJ5dGVz',
  'envelope_b64',
  'ZW52ZWxvcGUtYnl0ZXM=',
  'ingested',
  'evidence-ingester',
  'pid-ingester',
  'actor_principal',
  'acting_principal',
  'github:alice',
  'surface:relayer',
  'request_id',
  'req-123',
  'raw-detail',
];

function jsonResp(status: number, body: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status });
}

describe('toPortalWorkItem', () => {
  it('maps the pinned fixture (T1)', () => {
    const w = toPortalWorkItem(VIEW, { state: 'ok', value: [] }, unknownHistory);
    expect(w).toMatchObject({ id: 'wi_abc', state: 'waiting', waitingReason: 'input', stateVersion: 3, tenant: 'acme' });
    expect(w.latestExecution).toEqual({
      state: 'ok',
      value: { id: 'we_1', attempt: 1, phase: 'Running', startedAt: '2026-10-01T01:00:00Z', endedAt: undefined, resumedFromExecutionId: undefined },
    });
    expect(w.latestSnapshot).toEqual({ state: 'ok', value: { id: 'cs_1', executionId: 'we_1', contentHash: 'sha256:aa' } });
  });

  it('passes unobserved history through as unknown, never empty (T2)', () => {
    const w = toPortalWorkItem(VIEW, unknownReq, unknownHistory);
    for (const k of ['executions', 'snapshots', 'evidence', 'events'] as const) {
      expect(w[k]).toEqual({ state: 'unknown', reason: 'fetch_failed' });
    }
    expect(w.evidenceTruncated).toBeUndefined();
    expect(w.surfaces).toEqual({ state: 'unknown', reason: 'not_available_via_relay' });
    const stale = toPortalWorkItem(VIEW, { state: 'stale', value: [], observedAt: '2026-10-01T00:00:00Z' }, unknownHistory);
    expect(stale.executionRequests).toMatchObject({ state: 'stale', observedAt: '2026-10-01T00:00:00Z' });
  });

  it('drops content fields, engine identity and unsafe links (T3)', () => {
    const w = toPortalWorkItem(VIEW, unknownReq, unknownHistory, [
      { label: 'bad', url: JS_URL },
      { label: 'proto-relative', url: '//evil.example/x' },
      { label: 'backslash', url: '/\\evil.example/x' },
      { label: 'ok', url: 'https://canvas.example/x' },
      { label: 'path', url: '/canvas/we_1' },
    ]);
    const s = JSON.stringify(w);
    for (const f of ['"content"', '"messages"', '"transcript"', 'engine_ref', 'dev-loop-x', 'owner_principal']) {
      expect(s).not.toContain(f);
    }
    expect(w.links).toEqual([
      { label: 'ok', url: 'https://canvas.example/x' },
      { label: 'path', url: '/canvas/we_1' },
    ]);
  });

  it('never defaults an unreadable latest execution phase', () => {
    const { phase: _phase, ...noPhase } = VIEW.latest_execution;
    const w = toPortalWorkItem({ ...VIEW, latest_execution: noPhase }, unknownReq, unknownHistory);
    expect(w.latestExecution).toEqual({ state: 'unknown', reason: 'unrecognised_shape' });
  });

  it('says why there is no canvas link, so an unset template is not a failure', () => {
    const noExec = { ...VIEW, latest_execution: null };
    expect(toPortalWorkItem(VIEW, unknownReq, unknownHistory).canvas).toBe('not_configured');
    expect(toPortalWorkItem(noExec, unknownReq, unknownHistory).canvas).toBe('not_configured');
    expect(toPortalWorkItem(noExec, unknownReq, unknownHistory, [], true).canvas).toBe('no_execution');
    expect(toPortalWorkItem(VIEW, unknownReq, unknownHistory, [], true).canvas).toBe('unavailable');
    expect(toPortalWorkItem(VIEW, unknownReq, unknownHistory, [{ label: 'c', url: '//evil.example/x' }], true).canvas).toBe('unavailable');
    const unreadable = { ...VIEW, latest_execution: { phase: 'Running' } };
    expect(toPortalWorkItem(unreadable, unknownReq, unknownHistory, [], true).canvas).toBe('unavailable');
    expect(toPortalWorkItem(VIEW, unknownReq, unknownHistory, [{ label: 'c', url: '/canvas/we_1' }], true).canvas).toBe('ok');
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

  /** Answers each work-item path from HISTORY, unless `over` names it. */
  const route = (over: Record<string, () => Response> = {}) =>
    fetchMock.mockImplementation(async (url: string) => {
      const sub = new URL(url).pathname.match(/^\/api\/v1\/work-items\/[^/]+(?:\/(.+))?$/)?.[1] ?? '';
      if (over[sub]) return over[sub]();
      return jsonResp(200, sub === '' ? VIEW : HISTORY[sub]);
    });

  it('sends the surface token and actor on every request', async () => {
    route({
      'execution-requests': () =>
        jsonResp(200, { execution_requests: [{ id: 'xr_1', kind: 'resume', state: 'pending', claimed_by: 'service:x' }] }),
    });
    const w = await client().getWorkItem('wi_abc', 'user:default:alice');
    expect(fetchMock).toHaveBeenCalledTimes(6);
    for (const call of fetchMock.mock.calls) {
      expect(call[1].headers.Authorization).toBe('Bearer tok-secret');
      expect(call[1].headers['X-MCTL-Surface-Actor']).toBe('user:default:alice');
    }
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/v1/work-items/wi_abc');
    expect(JSON.stringify(w)).not.toContain('claimed_by');
  });

  it('builds the canvas link through the same filter as every other link', async () => {
    const mk = (tpl: string) =>
      new MctlApiWorkItemsClient({ baseUrl: 'http://api.test', surfaceToken: 't', executionCanvasUrlTemplate: tpl });
    route();
    const built = await mk('/canvas/{executionId}?wi={workItemId}').getWorkItem('wi_abc', 'u');
    expect(built.links).toEqual([{ label: 'Execution Canvas', url: '/canvas/we_1?wi=wi_abc' }]);
    expect(built.canvas).toBe('ok');
    const refused = await mk('//evil.example/{executionId}').getWorkItem('wi_abc', 'u');
    expect(refused.links).toEqual([]);
    expect(refused.canvas).toBe('unavailable');
    expect((await client().getWorkItem('wi_abc', 'u')).canvas).toBe('not_configured');
  });

  it('degrades only the execution-requests section on any upstream error, including 429', async () => {
    for (const status of [400, 403, 404, 409, 429, 500, 503]) {
      route({ 'execution-requests': () => jsonResp(status, { error: 'x', code: 'rate_limited' }) });
      const w = await client().getWorkItem('wi_abc', 'u');
      expect(w.id).toBe('wi_abc');
      expect(w.executionRequests).toEqual({ state: 'unknown', reason: 'fetch_failed' });
      expect(w.executions.state).toBe('ok');
    }
  });

  it('reads executions, snapshots, evidence and events through the relay (mctl-api#436)', async () => {
    route();
    const w = await client().getWorkItem('wi_abc', 'u');
    const paths = fetchMock.mock.calls.map(c => new URL(c[0]).pathname).sort();
    expect(paths).toEqual(
      ['', '/events', '/evidence', '/execution-requests', '/executions', '/snapshots'].map(p => `/api/v1/work-items/wi_abc${p}`),
    );
    expect(w.executions).toEqual({
      state: 'ok',
      observedAt: expect.any(String),
      value: [
        { id: 'we_1', attempt: 1, phase: 'Failed', startedAt: 'T1', endedAt: 'T2' },
        { id: 'we_2', attempt: 2, phase: 'Running', startedAt: 'T3', resumedFromExecutionId: 'we_1' },
      ],
    });
    expect(w.snapshots).toEqual({
      state: 'ok',
      observedAt: expect.any(String),
      value: [
        {
          id: 'cs_1',
          executionId: 'we_1',
          contentHash: 'sha256:aa',
          executionSequence: 1,
          strategy: 'devloop',
          strategyVersion: '3',
          priorSnapshotId: 'cs_0',
          createdAt: 'T1',
        },
      ],
    });
    expect(w.evidence).toEqual({
      state: 'ok',
      observedAt: expect.any(String),
      value: [
        {
          id: 'ev_1',
          executionId: 'we_1',
          contentHash: 'sha256:bb',
          apiVersion: 'evidence/v1',
          createdAt: 'T2',
          primaryRefKind: 'work',
          primaryRefId: 'we_1',
        },
      ],
    });
    expect(w.evidenceTruncated).toBeUndefined();
    expect(w.events).toEqual({
      state: 'ok',
      observedAt: expect.any(String),
      value: [{ seq: 1, kind: 'state_changed', fromState: 'active', toState: 'waiting', surface: 'telegram', createdAt: 'T4' }],
    });
    expect(w.surfaces).toEqual({ state: 'unknown', reason: 'not_available_via_relay' });
  });

  it('never forwards engine identity, envelopes, snapshot bytes or principals', async () => {
    route();
    const s = JSON.stringify(await client().getWorkItem('wi_abc', 'u'));
    for (const f of FORBIDDEN) {
      expect(s).not.toContain(f);
    }
  });

  it('reports an empty history list as ok and empty, never unknown', async () => {
    route({
      executions: () => jsonResp(200, { executions: [] }),
      snapshots: () => jsonResp(200, { snapshots: [] }),
      evidence: () => jsonResp(200, { evidence: [], truncated: false, limit: 50 }),
      events: () => jsonResp(200, { events: [] }),
    });
    const w = await client().getWorkItem('wi_abc', 'u');
    for (const k of ['executions', 'snapshots', 'evidence', 'events'] as const) {
      expect(w[k]).toEqual({ state: 'ok', value: [], observedAt: expect.any(String) });
    }
  });

  it('degrades only the failing history section, and the item stays readable', async () => {
    for (const k of ['executions', 'snapshots', 'evidence', 'events'] as const) {
      for (const status of [403, 404, 429, 500, 503]) {
        route({ [k]: () => jsonResp(status, { error: 'x' }) });
        const w = await client().getWorkItem('wi_abc', 'u');
        expect(w.id).toBe('wi_abc');
        expect(w[k]).toEqual({ state: 'unknown', reason: 'fetch_failed' });
        const others = (['executions', 'snapshots', 'evidence', 'events', 'executionRequests'] as const).filter(o => o !== k);
        expect(others.map(o => w[o]?.state)).toEqual(others.map(() => 'ok'));
      }
    }
  });

  it('marks an unrecognised history body unknown, never empty or partial', async () => {
    const cases: [string, 'executions' | 'snapshots' | 'evidence' | 'events', unknown][] = [
      ['executions', 'executions', {}],
      ['executions', 'executions', { executions: 'we_1' }],
      ['executions', 'executions', { executions: [{ id: 'we_1', attempt: 1, phase: 'Failed', started_at: 'T1' }, { phase: 'Running' }] }],
      ['executions', 'executions', { executions: [{ id: 'we_2', attempt: 2, started_at: 'T1' }] }],
      ['executions', 'executions', { executions: [{ id: 'we_2', attempt: 2, phase: '', started_at: 'T1' }] }],
      ['snapshots', 'snapshots', { snapshots: [{ id: 'cs_1', execution_id: 'we_1' }] }],
      ['evidence', 'evidence', { evidence: [] }],
      ['evidence', 'evidence', { evidence: [], truncated: 'no' }],
      ['evidence', 'evidence', { evidence: [{ content_hash: 'sha256:bb' }], truncated: false }],
      ['evidence', 'evidence', { evidence: [{ id: 'ev_1', primary_ref_kind: 'work', primary_ref_id: 'we_1' }], truncated: false }],
      ['evidence', 'evidence', { evidence: [{ id: 'ev_1', content_hash: 'sha256:bb' }], truncated: false }],
      ['evidence', 'evidence', { evidence: [{ id: 'ev_1', content_hash: 'sha256:bb', primary_ref_kind: 'runtime' }], truncated: false }],
      ['events', 'events', { events: [{ seq: '1', kind: 'created' }] }],
      ['events', 'events', null],
    ];
    for (const [sub, k, body] of cases) {
      route({ [sub]: () => jsonResp(200, body) });
      const w = await client().getWorkItem('wi_abc', 'u');
      expect(w[k]).toEqual({ state: 'unknown', reason: 'unrecognised_shape' });
    }
  });

  it('keeps a queued execution without started_at readable, with its canvas link', async () => {
    const queued = { id: 'we_3', engine: 'temporal', engine_ref: 'dev-loop-q', attempt: 1, phase: 'Pending' };
    route({
      '': () => jsonResp(200, { ...VIEW, latest_execution: queued }),
      executions: () => jsonResp(200, { executions: [queued] }),
    });
    const c = new MctlApiWorkItemsClient({
      baseUrl: 'http://api.test',
      surfaceToken: 't',
      executionCanvasUrlTemplate: '/canvas/{executionId}',
    });
    const w = await c.getWorkItem('wi_abc', 'u');
    const value = { id: 'we_3', attempt: 1, phase: 'Pending' };
    expect(w.latestExecution).toEqual({ state: 'ok', value });
    expect(w.executions).toEqual({ state: 'ok', value: [value], observedAt: expect.any(String) });
    expect(w.links).toEqual([{ label: 'Execution Canvas', url: '/canvas/we_3' }]);
    expect(w.canvas).toBe('ok');
  });

  it('reads runtime-only evidence, whose execution_id is blank', async () => {
    const runtimeOnly = { id: 'ev_2', content_hash: 'sha256:cc', execution_id: '', primary_ref_kind: 'runtime', primary_ref_id: 'ex-0123456789abcdef' };
    route({ evidence: () => jsonResp(200, { evidence: [runtimeOnly], truncated: false, limit: 50 }) });
    const w = await client().getWorkItem('wi_abc', 'u');
    expect(w.evidence).toEqual({
      state: 'ok',
      observedAt: expect.any(String),
      value: [{ id: 'ev_2', contentHash: 'sha256:cc', primaryRefKind: 'runtime', primaryRefId: 'ex-0123456789abcdef' }],
    });
  });

  it('marks a clipped evidence page as clipped', async () => {
    route({ evidence: () => jsonResp(200, { ...(HISTORY.evidence as object), truncated: true, limit: 1 }) });
    const w = await client().getWorkItem('wi_abc', 'u');
    expect(w.evidence.state).toBe('ok');
    expect(w.evidenceTruncated).toEqual({ limit: 1 });
  });

  it('propagates a plugin bug in a history read instead of degrading it', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      // Not a Response: reading it is a TypeError, not an upstream answer.
      new URL(url).pathname.endsWith('/events') ? (undefined as unknown as Response) : jsonResp(200, VIEW),
    );
    const err = await client().getWorkItem('wi_abc', 'u').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MctlApiError);
  });

  it('only allows relay routes', () => {
    expect(isRelayAllowed('GET', '/api/v1/work-items/wi_1')).toBe(true);
    for (const sub of ['executions', 'snapshots', 'events', 'evidence']) {
      expect(isRelayAllowed('GET', `/api/v1/work-items/wi_1/${sub}`)).toBe(true);
    }
    // Not called by anything yet, so not allowed.
    expect(isRelayAllowed('GET', '/api/v1/work-items/wi_1/snapshots/cs_1')).toBe(false);
    // Serves the snapshot bytes: not a relay route.
    expect(isRelayAllowed('GET', '/api/v1/work-items/wi_1/executions/we_1/snapshot')).toBe(false);
    expect(isRelayAllowed('GET', '/api/v1/work-items/wi_1/executions/we_1')).toBe(false);
    expect(isRelayAllowed('GET', '/api/v1/work-items/wi_1/snapshots/cs_1/bytes')).toBe(false);
    for (const sub of ['executions', 'snapshots', 'events', 'evidence', 'executions/we_1/snapshot']) {
      expect(isRelayAllowed('POST', `/api/v1/work-items/wi_1/${sub}`)).toBe(false);
    }
    expect(isRelayAllowed('GET', '/api/v1/work-items/wi_1/approvals')).toBe(false);
    expect(isRelayAllowed('POST', '/api/v1/work-items/wi_1/resume')).toBe(false);
    expect(isRelayAllowed('PATCH', '/api/v1/work-items/wi_1')).toBe(false);
  });

  it('makes no request at all for a route outside the relay allowlist', async () => {
    const c = client() as unknown as {
      request(method: string, path: string, actor: string, body?: unknown): Promise<unknown>;
    };
    for (const [method, p] of [
      ['GET', '/api/v1/work-items/wi_1/executions/we_1/snapshot'],
      ['GET', '/api/v1/work-items/wi_1/snapshots/cs_1'],
      ['POST', '/api/v1/work-items/wi_1/executions'],
      ['POST', '/api/v1/work-items/wi_1/executions/we_1/snapshot'],
      ['GET', '/api/v1/work-items/wi_1/approvals'],
      ['POST', '/api/v1/work-items/wi_1/resume'],
      ['POST', '/api/v1/work-items/wi_1/actions/approve'],
    ]) {
      const err = await c.request(method, p, 'u').catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(MctlApiError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes no request with an actor mctl-api would reject as invalid_request', async () => {
    const err = await client().getWorkItem('wi_abc', 'user:default/alice').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MctlApiError);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('never logs the redeem code, even when mctl-api or the driver echoes it (T8)', async () => {
    const lines: string[] = [];
    const logger = { warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    const c = new MctlApiWorkItemsClient({ baseUrl: 'http://api.test', surfaceToken: 't', logger });
    const code = 'K7QX-9F2M-SECRET';
    fetchMock.mockResolvedValueOnce(jsonResp(500, { error: `failed to redeem ${code}` }));
    await expect(c.redeemIdentity(code, 'u')).rejects.toMatchObject({ status: 502 });
    fetchMock.mockRejectedValueOnce(new Error(`socket hang up while sending {"code":"${code}"}`));
    await expect(c.redeemIdentity(code, 'u')).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(jsonResp(403, { error: `code ${code} is invalid`, code: 'challenge_invalid' }));
    const refused = await c.redeemIdentity(code, 'u').catch(e => e);
    expect(refused).toMatchObject({ status: 403 });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.join('\n')).not.toContain(code);
  });

  it('never reads MCTL_API_TOKEN or an admin credential (T2)', () => {
    for (const f of ['plugin.ts', 'router.ts', 'mctlApiClient.ts']) {
      expect(fs.readFileSync(path.join(__dirname, f), 'utf8')).not.toMatch(/MCTL_API_TOKEN/);
    }
  });
});
