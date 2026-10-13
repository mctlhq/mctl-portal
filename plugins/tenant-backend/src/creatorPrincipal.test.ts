import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createCreatorPrincipalResolver, CreatorPrincipalError } from './creatorPrincipal';

const PID = 'prn_01M39HRB7JRXZ2PHW5VVB695YZ';

describe('createCreatorPrincipalResolver', () => {
  let server: Server | undefined;
  let seen: { auth?: string; actor?: string; contentLength?: string }[] = [];
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn() };

  // A stand-in mctl-api answering status/body for the resolve route.
  function startApi(status: number, body: unknown): Promise<string> {
    const app = express();
    app.post('/api/v1/surface-principals/github', (req, res) => {
      seen.push({
        auth: req.header('authorization'),
        actor: req.header('x-mctl-surface-actor'),
        contentLength: req.header('content-length'),
      });
      res.status(status).type('application/json').send(typeof body === 'string' ? body : JSON.stringify(body));
    });
    return new Promise(resolve => {
      server = app.listen(0, () => resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/`));
    });
  }

  afterEach(done => {
    seen = [];
    if (server) {
      server.close(() => done());
      server = undefined;
    } else {
      done();
    }
  });

  const resolver = (baseUrl: string) =>
    createCreatorPrincipalResolver({ baseUrl, surfaceToken: 'surface-tok', logger: logger as any });

  it('asks as the portal surface for the login and returns the principal', async () => {
    const base = await startApi(200, { principalId: PID });
    await expect(resolver(base)('Octo-Cat')).resolves.toBe(PID);
    expect(seen).toEqual([{ auth: 'Bearer surface-tok', actor: 'github:Octo-Cat', contentLength: '0' }]);
  });

  it('reports a refused or disabled creator as 403', async () => {
    for (const code of ['principal_disabled', 'identity_refused']) {
      const base = await startApi(403, { code, error: 'no' });
      const err = await resolver(base)('octocat').catch(e => e);
      expect(err).toBeInstanceOf(CreatorPrincipalError);
      expect(err).toMatchObject({ status: 403, code });
      await new Promise(r => server!.close(r));
      server = undefined;
    }
  });

  // Anything that is not a well-formed principal is a failed read, never
  // "no principal".
  it.each([
    ['portal refused itself', 403, { code: 'portal_surface_required' }],
    ['unavailable', 503, { code: 'surface_identity_unavailable' }],
    ['bad request', 400, { code: 'invalid_request' }],
    ['portal token rejected', 401, {}],
    ['empty answer', 200, {}],
    ['empty principal', 200, { principalId: '' }],
    ['malformed principal', 200, { principalId: 'prn_short' }],
    ['not json', 200, 'principal'],
    ['an error that carries an id', 500, { principalId: PID }],
  ])('%s is a 503', async (_name, status, body) => {
    const base = await startApi(status as number, body);
    const err = await resolver(base)('octocat').catch(e => e);
    expect(err).toBeInstanceOf(CreatorPrincipalError);
    expect(err.status).toBe(503);
  });

  it('is a 503 when mctl-api cannot be reached', async () => {
    const err = await resolver('http://127.0.0.1:1')('octocat').catch(e => e);
    expect(err).toBeInstanceOf(CreatorPrincipalError);
    expect(err.status).toBe(503);
  });

  it('never sends a value that is not a GitHub login', async () => {
    const base = await startApi(200, { principalId: PID });
    for (const login of ['', 'octo cat', 'a:b', '-octo', 'octo\nX-Evil: 1', 'x'.repeat(40), 'a-'.repeat(20) + 'a']) {
      await expect(resolver(base)(login)).rejects.toBeInstanceOf(CreatorPrincipalError);
    }
    expect(seen).toEqual([]);
  });

  // 39 characters with inner hyphens is the longest login GitHub allows.
  it('accepts the longest hyphenated login', async () => {
    const base = await startApi(200, { principalId: PID });
    const login = 'a-'.repeat(19) + 'a';
    expect(login).toHaveLength(39);
    await expect(resolver(base)(login)).resolves.toBe(PID);
  });
});
