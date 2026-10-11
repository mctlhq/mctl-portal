import { NotFoundError } from '@backstage/errors';
import {
  createCatalogOnlySignInResolver,
  githubSignInResolverFor,
  registerGithubProvider,
} from './githubAuthModule';

// The factory is opaque once built; hand the test the options instead, so it
// can see which resolver the provider was registered with.
jest.mock('@backstage/plugin-auth-node', () => ({
  ...jest.requireActual('@backstage/plugin-auth-node'),
  createOAuthProviderFactory: (options: unknown) => options,
}));

const logger = { info: jest.fn(), warn: jest.fn() };

beforeEach(() => jest.clearAllMocks());

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

describe('githubSignInResolverFor', () => {
  it('turns the GitHub sign-in off only for zitadel', () => {
    expect(githubSignInResolverFor('zitadel', logger)).toBeUndefined();
  });

  it.each([[undefined], ['github'], ['both'], ['zitdel']])(
    'keeps it for %s',
    mode => {
      expect(githubSignInResolverFor(mode, logger)).toEqual(expect.any(Function));
    },
  );

  it('keeps the catalog-only rule while it is on', async () => {
    const resolver = githubSignInResolverFor('both', logger)!;
    await expect(resolver(signInInfo('stranger'), context([]))).rejects.toMatchObject({
      name: 'NotAllowedError',
    });
  });
});

describe('registerGithubProvider', () => {
  function register(mode: string | undefined) {
    const registerProvider = jest.fn();
    registerGithubProvider({ registerProvider }, mode, logger);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    return registerProvider.mock.calls[0][0];
  }

  it.each([['zitadel'], ['both'], [undefined]])(
    'registers provider github for %s, for ScmAuth and the scaffolder',
    mode => {
      expect(register(mode)).toMatchObject({ providerId: 'github' });
    },
  );

  it('registers no sign-in resolver for zitadel', () => {
    expect(register('zitadel').factory.signInResolver).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/sign-in is off/));
  });

  it('registers the catalog-only resolver otherwise', () => {
    expect(register('both').factory.signInResolver).toEqual(expect.any(Function));
    expect(logger.info).not.toHaveBeenCalled();
  });
});
