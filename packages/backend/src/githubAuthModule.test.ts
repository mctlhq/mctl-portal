import { NotFoundError } from '@backstage/errors';
import { createCatalogOnlySignInResolver } from './githubAuthModule';

const logger = { info: jest.fn(), warn: jest.fn() };

function signInInfo(username: string | undefined) {
  return { result: { fullProfile: { username } }, profile: {} } as any;
}

function context(catalogUsers: string[]) {
  return {
    signInWithCatalogUser: jest.fn(async ({ entityRef }: { entityRef: { name: string } }) => {
      if (!catalogUsers.includes(entityRef.name)) {
        throw new NotFoundError(`User ${entityRef.name} not found`);
      }
      return { token: `catalog-token-for-${entityRef.name}` };
    }),
    issueToken: jest.fn(async () => ({ token: 'fallback-token' })),
  } as any;
}

describe('createCatalogOnlySignInResolver', () => {
  const resolver = createCatalogOnlySignInResolver(logger);

  it('signs a catalog User in as that entity', async () => {
    const ctx = context(['carol']);
    await expect(resolver(signInInfo('Carol'), ctx)).resolves.toEqual({
      token: 'catalog-token-for-carol',
    });
    expect(ctx.signInWithCatalogUser).toHaveBeenCalledWith({ entityRef: { name: 'carol' } });
  });

  it('refuses a GitHub account without a catalog User and issues no token', async () => {
    const ctx = context(['carol']);
    await expect(resolver(signInInfo('stranger'), ctx)).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
    expect(ctx.issueToken).not.toHaveBeenCalled();
  });

  it('propagates catalog failures instead of signing in', async () => {
    const ctx = context([]);
    ctx.signInWithCatalogUser.mockRejectedValue(new Error('catalog unavailable'));
    await expect(resolver(signInInfo('carol'), ctx)).rejects.toThrow('catalog unavailable');
    expect(ctx.issueToken).not.toHaveBeenCalled();
  });

  it('refuses a profile without a username', async () => {
    const ctx = context(['carol']);
    await expect(resolver(signInInfo(undefined), ctx)).rejects.toThrow(/missing username/);
    expect(ctx.signInWithCatalogUser).not.toHaveBeenCalled();
    expect(ctx.issueToken).not.toHaveBeenCalled();
  });
});
