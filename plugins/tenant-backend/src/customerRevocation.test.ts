import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createCustomerRevocationMiddleware } from './customerRevocation';

const jwt = (payload: object) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
const userToken = jwt({ sub: 'user:default/prn_01m45dr1gwc87109eh88vbjx25' });

describe('customer revocation root fence', () => {
  let server: Server;
  let base: string;
  const revoked = jest.fn();
  beforeEach(async () => {
    revoked.mockReset().mockResolvedValue(false);
    const app = express();
    app.use(createCustomerRevocationMiddleware({ isRevoked: revoked, appOrigin: 'https://app.mctl.ai' }));
    app.use((_req, res) => res.json({ reachedNormalAuthentication: true }));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  it.each([
    { Authorization: `Bearer ${userToken}` },
    { Cookie: `backstage-auth=${encodeURIComponent(userToken)}` },
    { Authorization: `Bearer ${jwt({ sub: 'plugin:catalog', obo: userToken })}` },
  ])('refuses revoked direct, cookie and delegated tokens before any plugin route', async headers => {
    revoked.mockResolvedValue(true);
    const res = await fetch(`${base}/api/catalog/entities`, { headers: new Headers(Object.entries({ ...headers, Origin: 'https://app.mctl.ai' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.mctl.ai');
    expect(revoked).toHaveBeenCalledWith('prn_01M45DR1GWC87109EH88VBJX25');
  });

  it('forwards an unrevoked claim to normal authentication without authorizing it', async () => {
    const res = await fetch(base, { headers: { Authorization: `Bearer ${userToken}` } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reachedNormalAuthentication: true });
  });

  it.each([undefined, 'not-a-token', jwt({ sub: 'plugin:catalog' }), jwt({ sub: 'user:default/mashkovd' })])(
    'leaves non-customer credentials to normal authentication', async token => {
      const res = await fetch(base, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      expect(res.status).toBe(200);
      expect(revoked).not.toHaveBeenCalled();
    },
  );

  it('fails closed on an unreadable revocation state', async () => {
    revoked.mockRejectedValue(new Error('database unavailable'));
    const res = await fetch(base, { headers: { Authorization: `Bearer ${userToken}`, Origin: 'https://foreign.example' } });
    expect(res.status).toBe(503);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
