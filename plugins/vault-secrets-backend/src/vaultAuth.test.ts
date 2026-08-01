import fetch from 'node-fetch';
import { kubernetesTokenProvider, staticTokenProvider } from './vaultAuth';

jest.mock('node-fetch', () => jest.fn());

const fetchMock = fetch as unknown as jest.Mock;

const loginOk = (token: string, leaseSeconds = 3600) => ({
  ok: true,
  status: 200,
  json: async () => ({
    auth: { client_token: token, lease_duration: leaseSeconds },
  }),
});

const fakeLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any);

beforeEach(() => {
  fetchMock.mockReset();
});

describe('staticTokenProvider', () => {
  it('returns the configured token and survives invalidate', async () => {
    const provider = staticTokenProvider('s.static');
    expect(await provider.getToken()).toBe('s.static');
    provider.invalidate();
    // Nothing to re-issue — a static token is all we have, so it must keep
    // being handed out rather than becoming undefined.
    expect(await provider.getToken()).toBe('s.static');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('kubernetesTokenProvider', () => {
  const build = (overrides: Partial<Parameters<typeof kubernetesTokenProvider>[0]> = {}) =>
    kubernetesTokenProvider({
      vaultAddr: 'https://vault.example',
      role: 'backstage',
      logger: fakeLogger(),
      readJwt: jest.fn().mockResolvedValue('jwt-1'),
      ...overrides,
    });

  it('logs in with the ServiceAccount JWT and returns the client token', async () => {
    fetchMock.mockResolvedValue(loginOk('s.k8s'));
    const provider = build();

    expect(await provider.getToken()).toBe('s.k8s');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://vault.example/v1/auth/kubernetes/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ role: 'backstage', jwt: 'jwt-1' }),
      }),
    );
  });

  it('honours a custom auth mount path', async () => {
    fetchMock.mockResolvedValue(loginOk('s.k8s'));
    await build({ authPath: 'kubernetes-preprod' }).getToken();
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://vault.example/v1/auth/kubernetes-preprod/login',
    );
  });

  it('caches the token instead of logging in per request', async () => {
    fetchMock.mockResolvedValue(loginOk('s.k8s'));
    const provider = build();

    await provider.getToken();
    await provider.getToken();
    await provider.getToken();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-logs in once the lease is 80% elapsed', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk('s.first', 100))
      .mockResolvedValueOnce(loginOk('s.second', 100));
    let clock = 0;
    const provider = build({ now: () => clock });

    expect(await provider.getToken()).toBe('s.first');
    clock = 79_000; // just inside the renew threshold
    expect(await provider.getToken()).toBe('s.first');
    clock = 81_000; // past it
    expect(await provider.getToken()).toBe('s.second');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-reads the JWT on every login, since kubelet rotates it in place', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk('s.first', 100))
      .mockResolvedValueOnce(loginOk('s.second', 100));
    const readJwt = jest
      .fn()
      .mockResolvedValueOnce('jwt-old')
      .mockResolvedValueOnce('jwt-rotated');
    const provider = build({ readJwt, now: () => 0 });

    await provider.getToken();
    provider.invalidate();
    await provider.getToken();

    expect(readJwt).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).jwt).toBe('jwt-rotated');
  });

  it('logs in again after invalidate, which is how a revoked token recovers', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk('s.first'))
      .mockResolvedValueOnce(loginOk('s.second'));
    const provider = build();

    expect(await provider.getToken()).toBe('s.first');
    provider.invalidate();
    expect(await provider.getToken()).toBe('s.second');
  });

  it('does not start a second login while one is in flight', async () => {
    let release: (v: any) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise(resolve => {
        release = resolve;
      }),
    );
    const provider = build();

    const first = provider.getToken();
    const second = provider.getToken();
    release(loginOk('s.k8s'));

    expect(await first).toBe('s.k8s');
    expect(await second).toBe('s.k8s');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh login attempt after a failed one', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) })
      .mockResolvedValueOnce(loginOk('s.k8s'));
    const provider = build();

    await expect(provider.getToken()).rejects.toThrow(
      "Vault k8s auth failed for role 'backstage': HTTP 403",
    );
    // The in-flight promise must be cleared on rejection, or the provider
    // would replay the same failure forever.
    expect(await provider.getToken()).toBe('s.k8s');
  });

  it('rejects an empty ServiceAccount token rather than logging in with it', async () => {
    const provider = build({ readJwt: jest.fn().mockResolvedValue('  \n') });
    await expect(provider.getToken()).rejects.toThrow(/empty ServiceAccount token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a login response with no client_token', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ auth: {} }) });
    await expect(build().getToken()).rejects.toThrow(/returned no client_token/);
  });

  it('falls back to an hourly renewal when Vault reports no lease', async () => {
    fetchMock.mockResolvedValue(loginOk('s.k8s', 0));
    let clock = 0;
    const provider = build({ now: () => clock });

    await provider.getToken();
    clock = 2_880_000 - 1; // 3600s * 0.8 = 2880s
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await provider.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock = 2_880_001;
    await provider.getToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
