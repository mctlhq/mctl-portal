import {
  createZitadelCustomerResolver,
  unverifiedSubjectOf,
  ZitadelCustomerError,
} from './zitadelCustomer';

const PID = 'prn_01M45DR1GWC87109EH88VBJX25';

function idToken(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
}

describe('unverifiedSubjectOf', () => {
  it('reads sub', () => {
    expect(unverifiedSubjectOf(idToken({ sub: '900' }))).toBe('900');
  });

  it.each([['not.a.jwt'], ['two.parts'], [idToken({ sub: 1 })], [idToken({})]])(
    'reads no subject from %p',
    t => {
      expect(unverifiedSubjectOf(t)).toBeUndefined();
    },
  );
});

describe('createZitadelCustomerResolver', () => {
  const realFetch = (global as any).fetch;
  afterEach(() => {
    (global as any).fetch = realFetch;
  });
  const logger = { error: jest.fn(), warn: jest.fn() };
  const resolve = createZitadelCustomerResolver({ baseUrl: 'http://api/', surfaceToken: 'surface-tok', logger });

  function answer(status: number, body: unknown) {
    const fetchMock = jest.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }));
    (global as any).fetch = fetchMock;
    return fetchMock;
  }

  it('posts the token as the portal surface, naming its subject as the actor', async () => {
    const fetchMock = answer(200, { principalId: PID, githubId: '77', githubLogin: 'alice' });
    const tok = idToken({ sub: '900' });
    await expect(resolve(tok, 'signin')).resolves.toEqual({
      principalId: PID,
      githubId: '77',
      githubLogin: 'alice',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api/api/v1/surface-principals/zitadel');
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: 'Bearer surface-tok',
        'X-MCTL-Surface-Actor': 'zitadel:900',
      }),
    );
    expect(JSON.parse(init.body as string)).toEqual({ idToken: tok, purpose: 'signin' });
  });

  it('refuses a token without a subject without calling mctl-api', async () => {
    const fetchMock = answer(200, {});
    await expect(resolve('garbage', 'create')).rejects.toMatchObject({ kind: 'refused' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'not_a_customer'],
    [401, 'id_token_invalid'],
    [403, 'customer_unproven'],
    [403, 'principal_disabled'],
    [403, 'identity_refused'],
    [409, 'customer_conflict'],
  ])('reads %i %s as a refusal of the customer', async (status, code) => {
    answer(status, { error: 'x', code });
    await expect(resolve(idToken({ sub: '900' }), 'signin')).rejects.toEqual(
      expect.objectContaining({ kind: 'refused', code }),
    );
  });

  it.each([
    [403, { code: 'portal_surface_required' }],
    [400, { code: 'invalid_request' }],
    [429, { code: 'too_many_requests' }],
    [503, { code: 'surface_identity_unavailable' }],
    [500, 'not json'],
    [200, { principalId: 'prn_short', githubId: '77', githubLogin: 'alice' }],
    [200, { principalId: PID, githubId: 'x', githubLogin: 'alice' }],
    [200, { principalId: PID, githubId: '77' }],
    [200, 'not json'],
  ])('reads %i %p as unavailable, not a verdict on the customer', async (status, body) => {
    answer(status, body);
    const err = await resolve(idToken({ sub: '900' }), 'signin').catch(e => e);
    expect(err).toBeInstanceOf(ZitadelCustomerError);
    expect(err.kind).toBe('unavailable');
  });

  it('reads a network failure as unavailable', async () => {
    (global as any).fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(resolve(idToken({ sub: '900' }), 'signin')).rejects.toMatchObject({ kind: 'unavailable' });
  });
});
