import express, { Request } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { clientKey, createRateLimiters } from './rateLimit';

function req(xff: string | string[] | undefined, ip = '10.42.0.7'): Request {
  return { headers: xff === undefined ? {} : { 'x-forwarded-for': xff }, ip, socket: {} } as unknown as Request;
}

describe('clientKey', () => {
  it('uses the entry Traefik appended, not what the client wrote', () => {
    expect(clientKey(req('6.6.6.6, 203.0.113.9'))).toBe('203.0.113.9');
    expect(clientKey(req(['6.6.6.6', '203.0.113.9']))).toBe('203.0.113.9');
  });

  it('falls back to the socket peer without the header', () => {
    expect(clientKey(req(undefined))).toBe('10.42.0.7');
    expect(clientKey(req(''))).toBe('10.42.0.7');
  });

  it('puts one IPv6 allocation in one bucket', () => {
    expect(clientKey(req('2001:db8:1:2::1'))).toBe(clientKey(req('2001:db8:1:2:ffff::9')));
  });
});

describe('createRateLimiters', () => {
  let server: Server | undefined;

  afterEach(done => {
    if (server) {
      server.close(() => done());
      server = undefined;
    } else {
      done();
    }
  });

  function start(): Promise<string> {
    const limit = createRateLimiters({ read: 2, write: 1 });
    const app = express();
    app.get('/r', limit.read, (_req, res) => res.json({ ok: true }));
    app.post('/w', limit.write, (_req, res) => res.json({ ok: true }));
    return new Promise(resolve => {
      server = app.listen(0, () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`));
    });
  }

  const from = (ip: string) => ({ headers: { 'X-Forwarded-For': ip } });

  it('answers 429 once a client spends its budget', async () => {
    const base = await start();
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await fetch(`${base}/r`, from('203.0.113.9'))).status);
    expect(codes).toEqual([200, 200, 429]);
    const res = await fetch(`${base}/r`, from('203.0.113.9'));
    expect(await res.json()).toEqual({ error: 'Too many requests' });
  });

  it('keeps clients, and read and write budgets, apart', async () => {
    const base = await start();
    expect((await fetch(`${base}/w`, { method: 'POST', ...from('203.0.113.9') })).status).toBe(200);
    expect((await fetch(`${base}/w`, { method: 'POST', ...from('203.0.113.9') })).status).toBe(429);
    expect((await fetch(`${base}/w`, { method: 'POST', ...from('198.51.100.4') })).status).toBe(200);
    expect((await fetch(`${base}/r`, from('203.0.113.9'))).status).toBe(200);
  });

  it('is not escaped by forging earlier X-Forwarded-For entries', async () => {
    const base = await start();
    expect((await fetch(`${base}/w`, { method: 'POST', ...from('1.1.1.1, 203.0.113.9') })).status).toBe(200);
    expect((await fetch(`${base}/w`, { method: 'POST', ...from('2.2.2.2, 203.0.113.9') })).status).toBe(429);
  });
});
