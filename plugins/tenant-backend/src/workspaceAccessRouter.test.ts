import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createRouter, RouterOptions } from './router';

let server: Server | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
});

async function fixture() {
  const member = {
    tenantName: 'own',
    userId: 'prn_own',
    catalogKey: 'principal',
    principalId: 'prn_OWN',
    role: 'owner',
  };
  const readWorkspaceAccess = jest.fn().mockResolvedValue({ tenant: 'own' });
  const listMembershipsForUser = jest.fn().mockResolvedValue([member]);
  const logger = {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const options = {
    logger,
    argoClient: {},
    argoNamespace: 'argo-workflows',
    getGithubToken: jest.fn(),
    landingPageToken: 'landing-token',
    httpAuth: {
      credentials: jest.fn(async (req, opts) => {
        if (
          req.headers.authorization === 'Bearer user' &&
          opts.allow.includes('user')
        )
          return { principal: { type: 'user' } };
        if (
          req.headers.authorization === 'Bearer service' &&
          opts.allow.includes('service')
        )
          return { principal: { type: 'service' } };
        throw new Error('no credentials');
      }),
    },
    userInfo: {
      getUserInfo: jest.fn().mockResolvedValue({
        ownershipEntityRefs: ['user:default/prn_own', 'group:default/own'],
      }),
    },
    store: {
      getMemberByTenant: jest.fn().mockResolvedValue(undefined),
      listMembershipsForUser,
    },
    readWorkspaceAccess,
  } as unknown as RouterOptions;
  const app = express();
  app.use(createRouter(options));
  const base = await new Promise<string>(resolve => {
    server = app.listen(0, () =>
      resolve(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`),
    );
  });
  return { base, member, logger, readWorkspaceAccess, listMembershipsForUser };
}

it('uses only the signed-in user membership and ignores identity/tenant parameters', async () => {
  const f = await fixture();
  const response = await fetch(
    `${f.base}/me/workspace-access?tenant=foreign&principalId=foreign`,
    { headers: { Authorization: 'Bearer user' } },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(f.listMembershipsForUser).toHaveBeenCalledWith('prn_own');
  expect(f.readWorkspaceAccess).toHaveBeenCalledWith(f.member);
  expect((await response.json()).workspaces).toEqual([{ tenant: 'own' }]);
});

it.each(['', 'landing-token', 'service'])(
  'refuses non-user credential %s',
  async credential => {
    const f = await fixture();
    const response = await fetch(`${f.base}/me/workspace-access`, {
      headers: credential ? { Authorization: `Bearer ${credential}` } : {},
    });
    expect(response.status).toBe(401);
    expect(f.readWorkspaceAccess).not.toHaveBeenCalled();
  },
);

it('keeps a failed observation distinct from a verified empty membership list', async () => {
  const f = await fixture();
  f.readWorkspaceAccess.mockRejectedValueOnce(new Error('unavailable'));
  const failed = await fetch(`${f.base}/me/workspace-access`, {
    headers: { Authorization: 'Bearer user' },
  });
  expect(failed.status).toBe(503);
  expect(f.logger.warn).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      user: 'prn_own',
      tenant: 'own',
      reason: 'unavailable',
    }),
  );
  expect(await failed.json()).not.toHaveProperty('workspaces');
  f.listMembershipsForUser.mockResolvedValueOnce([]);
  const empty = await fetch(`${f.base}/me/workspace-access`, {
    headers: { Authorization: 'Bearer user' },
  });
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({
    workspaces: [],
    legacyMembership: false,
  });
});
