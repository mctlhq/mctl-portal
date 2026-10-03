import { WorkItemsApi, WorkItemsApiError } from './api';

describe('WorkItemsApi', () => {
  const discovery = { getBaseUrl: jest.fn().mockResolvedValue('http://backend/api/work-items') };
  const respond = (status: number, body?: string) =>
    new Response(body ?? null, { status, headers: { 'Content-Type': 'application/json' } });
  const make = (res: Response) => {
    const fetchApi = { fetch: jest.fn().mockResolvedValue(res) };
    return { api: new WorkItemsApi(discovery as any, fetchApi as any), fetchApi };
  };

  it('maps a backend {error, code} body to WorkItemsApiError with that code (link_required)', async () => {
    const { api } = make(respond(403, JSON.stringify({ error: 'not linked', code: 'link_required' })));
    const err = await api.get('wi_1').catch(e => e);
    expect(err).toBeInstanceOf(WorkItemsApiError);
    expect(err).toMatchObject({ status: 403, message: 'not linked', code: 'link_required' });
  });

  it('leaves code undefined when the body has none', async () => {
    const { api } = make(respond(404, JSON.stringify({ error: 'none' })));
    expect(await api.get('wi_1').catch(e => e)).toMatchObject({ status: 404, message: 'none', code: undefined });
  });

  it('falls back to HTTP <status> for a non-JSON error body', async () => {
    const { api } = make(new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await api.get('wi_1').catch(e => e)).toMatchObject({ status: 502, message: 'HTTP 502', code: undefined });
  });

  it('hits the right URLs and sends the idempotency key', async () => {
    const g = make(respond(200, JSON.stringify({ id: 'wi_1' })));
    expect(await g.api.get('wi_1')).toEqual({ id: 'wi_1' });
    expect(g.fetchApi.fetch).toHaveBeenCalledWith('http://backend/api/work-items/work-items/wi_1');

    const r = make(respond(201, JSON.stringify({ status: 'linked' })));
    await r.api.redeem('CODE');
    expect(r.fetchApi.fetch.mock.calls[0][0]).toBe('http://backend/api/work-items/surface-identities/redeem');
    expect(JSON.parse(r.fetchApi.fetch.mock.calls[0][1].body)).toEqual({ code: 'CODE' });

    const x = make(respond(201, JSON.stringify({ executionRequest: { id: 'xr_1' } })));
    await x.api.requestExecution('wi_1', { kind: 'resume', expectedStateVersion: 2, idempotencyKey: 'portal-k' });
    expect(x.fetchApi.fetch.mock.calls[0][0]).toBe('http://backend/api/work-items/work-items/wi_1/execution-requests');
    expect(JSON.parse(x.fetchApi.fetch.mock.calls[0][1].body)).toEqual({
      kind: 'resume',
      expectedStateVersion: 2,
      idempotencyKey: 'portal-k',
    });
  });
});
