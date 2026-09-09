import fetch from 'node-fetch';
import { MctlApiDomainsClient, MctlApiError, toPortalDomain } from './mctlApiClient';

jest.mock('node-fetch', () => jest.fn());

const fetchMock = fetch as unknown as jest.Mock;

describe('toPortalDomain', () => {
  it('maps an mctl-api domainResponse onto the frontend CustomDomain shape, including both challenge fields', () => {
    const raw = {
      id: 'd1',
      team: 'acme',
      service: 'web',
      domain: 'example.com',
      status: 'pending',
      created_by: 'carol',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      challenge_record: '_mctl-challenge.example.com',
      challenge_value: 'mctl-domain-verification=abc123',
      cname_target: 'acme-web.mctl.ai',
    };
    expect(toPortalDomain(raw)).toEqual({
      id: 'd1',
      team: 'acme',
      service: 'web',
      domain: 'example.com',
      auto_domain: 'acme-web.mctl.ai',
      status: 'pending',
      verified_at: null,
      created_by: 'carol',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      challenge_record_name: '_mctl-challenge.example.com',
      challenge_record_value: 'mctl-domain-verification=abc123',
    });
  });

  it('tolerates a missing optional field (verified_at absent on a pending row) without throwing', () => {
    const raw = {
      id: 'd2',
      team: 'acme',
      service: 'web',
      domain: 'example.com',
      status: 'pending',
      created_by: 'carol',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    expect(() => toPortalDomain(raw)).not.toThrow();
    const mapped = toPortalDomain(raw);
    expect(mapped.verified_at).toBeNull();
    expect(mapped.challenge_record_name).toBeUndefined();
    expect(mapped.challenge_record_value).toBeUndefined();
  });

  it('tolerates a verified row that omits challenge fields entirely, per mctl-api\'s domainResponseFor', () => {
    const raw = {
      id: 'd3',
      team: 'acme',
      service: 'web',
      domain: 'example.com',
      status: 'verified',
      verified_at: '2026-01-02T00:00:00Z',
      created_by: 'carol',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      cname_target: 'acme-web.mctl.ai',
    };
    const mapped = toPortalDomain(raw);
    expect(mapped.status).toBe('verified');
    expect(mapped.verified_at).toBe('2026-01-02T00:00:00Z');
    expect(mapped.challenge_record_name).toBeUndefined();
    expect(mapped.challenge_record_value).toBeUndefined();
  });

  it('tolerates a completely empty/undefined input without throwing', () => {
    expect(() => toPortalDomain(undefined)).not.toThrow();
    const mapped = toPortalDomain(undefined);
    expect(mapped.id).toBe('');
    expect(mapped.status).toBe('pending');
    expect(mapped.verified_at).toBeNull();
  });
});

describe('MctlApiDomainsClient', () => {
  const client = new MctlApiDomainsClient({ baseUrl: 'https://api.example.com/', token: 'super-secret-token' });

  beforeEach(() => fetchMock.mockReset());

  it('strips a trailing slash from baseUrl and sends the bearer token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ domains: [] }),
    });
    await client.list('acme');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/domains?team=acme',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer super-secret-token' }),
      }),
    );
  });

  it('maps every listed domain through toPortalDomain', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        domains: [
          {
            id: 'd1',
            team: 'acme',
            service: 'web',
            domain: 'example.com',
            status: 'pending',
            created_by: 'carol',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            challenge_record: '_mctl-challenge.example.com',
            challenge_value: 'mctl-domain-verification=abc123',
          },
        ],
      }),
    });
    const result = await client.list('acme', 'web');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/domains?team=acme&service=web',
      expect.anything(),
    );
    expect(result).toHaveLength(1);
    expect(result[0].challenge_record_name).toBe('_mctl-challenge.example.com');
  });

  it('POSTs only team/service/domain on create, never the actor field', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ id: 'd1', team: 'acme', service: 'web', domain: 'example.com', status: 'pending' }),
    });
    await client.create({ team: 'acme', service: 'web', domain: 'example.com', actor: 'carol' });
    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ team: 'acme', service: 'web', domain: 'example.com' });
    expect(options.body).not.toContain('carol');
  });

  it('a 409 upstream response on create becomes a 409-bearing MctlApiError', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => '{"error":"domain already registered"}',
    });
    await expect(
      client.create({ team: 'acme', service: 'web', domain: 'example.com', actor: 'carol' }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('a 500 upstream response becomes a 502-class MctlApiError', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });
    await expect(client.list('acme')).rejects.toMatchObject({ status: 502 });
    await expect(client.list('acme')).rejects.toBeInstanceOf(MctlApiError);
  });

  it('a network/timeout failure becomes a 502-class MctlApiError', async () => {
    fetchMock.mockRejectedValue(new Error('request timed out'));
    await expect(client.list('acme')).rejects.toMatchObject({ status: 502 });
  });

  it('never leaks the bearer token into a thrown error message', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });
    let caught: unknown;
    try {
      await client.list('acme');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MctlApiError);
    expect((caught as Error).message).not.toContain('super-secret-token');
  });

  it('sends team as a query param on verify and remove', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ verified: false, expected_record: 'x', expected_value: 'y' }),
    });
    await client.verify('d1', 'acme');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/domains/d1/verify?team=acme',
      expect.objectContaining({ method: 'POST' }),
    );

    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'deleted', ingress_cleanup: 'not-required' }),
    });
    await client.remove('d1', 'acme');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/domains/d1?team=acme',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  // A 204 No Content is a valid, successful response shape for DELETE — but
  // resp.ok is true and there is no body to parse. Before this was guarded,
  // resp.json() threw a raw SyntaxError outside the request()/MctlApiError
  // mapping, which respondToDomainsError (router.ts) collapsed into a
  // generic 502 — a successful delete looked like a failure to the user.
  it('does not throw on a 204 No Content success response with an empty body', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    await expect(client.remove('d1', 'acme')).resolves.toBeUndefined();
  });

  it('surfaces a non-JSON success body as a 502-class MctlApiError rather than an uncaught SyntaxError', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '<html>not json</html>' });
    await expect(client.list('acme')).rejects.toBeInstanceOf(MctlApiError);
    await expect(client.list('acme')).rejects.toMatchObject({ status: 502 });
  });

  it('omits the Authorization header when no token is configured', async () => {
    const anonClient = new MctlApiDomainsClient({ baseUrl: 'https://api.example.com' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ domains: [] }) });
    await anonClient.list('acme');
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers).not.toHaveProperty('Authorization');
  });
});
