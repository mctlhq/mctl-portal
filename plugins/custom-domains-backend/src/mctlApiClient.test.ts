import { ClientLogger, MctlApiDomainsClient, MctlApiError, toPortalDomain } from './mctlApiClient';

// This plugin uses the Node 22 global `fetch` directly (no node-fetch/
// @types/node-fetch dependency), so the mock targets the global rather than
// a module import.
let fetchMock: jest.SpyInstance;

beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchMock.mockRestore();
});

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

  // router.ts's respondToDomainsError forwards MctlApiError.message
  // verbatim to the browser. A 4xx body is client-actionable (a 409
  // "domain already registered") so it belongs in the message; a 5xx body
  // can carry a stack trace or other internal detail and must not reach an
  // authenticated tenant user through a routine upstream failure.
  it('does not include the raw upstream response body in a 5xx error message', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Traceback: internal db connection string leaked here',
    });
    let caught: unknown;
    try {
      await client.list('acme');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).not.toContain('internal db connection string');
  });

  it('does include the raw upstream response body in a 4xx error message (client-actionable)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => 'domain already registered',
    });
    let caught: unknown;
    try {
      await client.list('acme');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toContain('domain already registered');
  });

  // A 401/403 from mctl-api can only mean this plugin's own MCTL_API_TOKEN
  // is wrong, not anything the end user did (team authorization is
  // enforced by the router before any upstream call is made). Backstage's
  // core FetchApi treats a 401 as a signal that the user's own session
  // expired, so forwarding it verbatim risks forcing a login loop over a
  // backend misconfiguration the user cannot fix.
  it.each([401, 403])('maps an upstream %i to a 502-class MctlApiError rather than forwarding it', async status => {
    fetchMock.mockResolvedValue({ ok: false, status, text: async () => 'unauthorized' });
    await expect(client.list('acme')).rejects.toMatchObject({ status: 502 });
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
  // remove() normalizes the empty body to a defined RemoveResult-shaped
  // value so router.ts's `res.json(result)` never answers 200 with an empty
  // body.
  it('resolves to a defined RemoveResult on a 204 No Content success response', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204, text: async () => '' });
    await expect(client.remove('d1', 'acme')).resolves.toEqual({ status: 'deleted' });
  });

  // Regression: request() can return `undefined` for an empty body (the
  // case above), and list()'s `data.domains ?? []` used to assume `data`
  // itself was always an object — a TypeError, not the empty array the
  // empty-body guard was meant to produce.
  it('resolves to an empty array, not a thrown TypeError, when list gets a 200 with an empty body', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    await expect(client.list('acme')).resolves.toEqual([]);
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

  // mctl-api's verifyAndRespond (internal/api/handlers_domains.go) always
  // answers 200 with a JSON Result body, so an empty body on a 200 here
  // means something swallowed it in transit, not a legitimate response.
  it('verify() rejects with a 502-class MctlApiError on a 200 with an empty body', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    await expect(client.verify('d1', 'acme')).rejects.toBeInstanceOf(MctlApiError);
    await expect(client.verify('d1', 'acme')).rejects.toMatchObject({ status: 502 });
  });

  it('verify() resolves unchanged on a 200 with a real Result object', async () => {
    const result = { verified: false, reason: 'DNS not propagated yet', expected_record: 'x', expected_value: 'y' };
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify(result) });
    await expect(client.verify('d1', 'acme')).resolves.toEqual(result);
  });

  // Neither the resolved upstream URL nor the underlying driver's raw
  // message should ever reach the browser through a thrown message — only
  // the request path.
  it('a network failure throws a message naming only the path, never the upstream host or driver message', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.example.com'));
    let caught: unknown;
    try {
      await client.list('acme');
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).not.toContain('api.example.com');
    expect((caught as Error).message).not.toContain('ENOTFOUND');
    expect((caught as Error).message).toContain('/api/v1/domains');
  });

  // A 400 platform-domain rejection from mctl-api's AddDomain is
  // client-actionable and must be forwarded as-is, per the 401/403 mapping's
  // own documented carve-out (400 is not in the 401/403 set collapsed to
  // 502).
  it('forwards a 400 platform-domain rejection as 400 with mctl-api\'s own message', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"domain is a platform domain"}',
    });
    let caught: unknown;
    try {
      await client.create({ team: 'acme', service: 'web', domain: 'mctl.ai', actor: 'carol' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 400 });
    expect((caught as Error).message).toContain('domain is a platform domain');
  });

  describe('with an injected logger', () => {
    const logger: jest.Mocked<ClientLogger> = { warn: jest.fn(), error: jest.fn() };
    const loggerClient = new MctlApiDomainsClient({
      baseUrl: 'https://api.example.com',
      token: 'super-secret-token',
      logger,
    });

    beforeEach(() => {
      logger.warn.mockClear();
      logger.error.mockClear();
    });

    it('logs the upstream status, path, and body at error level on a 5xx, and excludes the body from the thrown message', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Traceback: internal db connection string leaked here',
      });
      let caught: unknown;
      try {
        await loggerClient.list('acme');
      } catch (err) {
        caught = err;
      }
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Traceback: internal db connection string leaked here'),
      );
      expect((caught as Error).message).not.toContain('Traceback');
    });

    it('functions without a supplied logger, defaulting to a no-op', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
      await expect(client.list('acme')).rejects.toBeInstanceOf(MctlApiError);
    });
  });
});
