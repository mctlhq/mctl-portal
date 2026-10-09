import { NotFoundError } from '@backstage/errors';
import {
  createZitadelSignInResolver,
  githubLoginOf,
} from './zitadelAuthModule';

const logger = { info: jest.fn(), warn: jest.fn() };

// The shape oidcAuthenticator hands the resolver: an openid-client TokenSet
// (claims() decodes the already verified ID token) and the userinfo response.
function profile(
  idClaims: Record<string, unknown> | undefined,
  userinfo: Record<string, unknown> = {},
) {
  return {
    tokenset: {
      id_token: idClaims ? 'header.payload.signature' : undefined,
      claims: () => {
        if (!idClaims) throw new Error('id_token not present in TokenSet');
        return idClaims;
      },
    },
    userinfo,
  } as any;
}

function signInInfo(p: any) {
  return { result: { fullProfile: p }, profile: {} } as any;
}

function context(catalogUsers: string[]) {
  return {
    signInWithCatalogUser: jest.fn(
      async ({ entityRef }: { entityRef: { name: string } }) => {
        if (!catalogUsers.includes(entityRef.name)) {
          throw new NotFoundError(`User ${entityRef.name} not found`);
        }
        return { token: `catalog-token-for-${entityRef.name}` };
      },
    ),
    issueToken: jest.fn(async () => ({ token: 'fallback-token' })),
  } as any;
}

describe('githubLoginOf', () => {
  it('reads the claim from the ID token, lowercased', () => {
    expect(githubLoginOf(profile({ 'mctl:github_login': 'MashkovD' }))).toBe(
      'mashkovd',
    );
  });

  it('prefers the ID token over userinfo', () => {
    expect(
      githubLoginOf(
        profile(
          { 'mctl:github_login': 'carol' },
          { 'mctl:github_login': 'mallory' },
        ),
      ),
    ).toBe('carol');
  });

  it('does not fall back to userinfo when the ID token lacks the claim', () => {
    expect(
      githubLoginOf(profile({ sub: '1' }, { 'mctl:github_login': 'mallory' })),
    ).toBeNull();
  });

  it('reads userinfo when a refresh returned no ID token', () => {
    expect(
      githubLoginOf(profile(undefined, { 'mctl:github_login': 'carol' })),
    ).toBe('carol');
  });

  it.each([
    ['missing', {}],
    ['empty', { 'mctl:github_login': '' }],
    ['not a string', { 'mctl:github_login': ['carol'] }],
    ['not a login shape', { 'mctl:github_login': 'carol@example.com' }],
    ['too long', { 'mctl:github_login': 'a'.repeat(40) }],
  ])('maps a %s claim to no one', (_name, claims) => {
    expect(githubLoginOf(profile(claims))).toBeNull();
  });

  it('maps an undecodable ID token to no one instead of throwing', () => {
    const p = profile(undefined, { 'mctl:github_login': 'mallory' });
    p.tokenset.id_token = 'not.a.jwt';
    expect(githubLoginOf(p)).toBeNull();
  });

  it('never uses email, preferred_username or sub in place of the claim', () => {
    const claims = {
      email: 'carol@example.com',
      preferred_username: 'carol',
      sub: 'carol',
    };
    expect(githubLoginOf(profile(claims, claims))).toBeNull();
  });
});

describe('createZitadelSignInResolver', () => {
  const resolver = createZitadelSignInResolver(logger);

  it('signs a mapped catalog User in as that entity', async () => {
    const ctx = context(['carol']);
    await expect(
      resolver(signInInfo(profile({ 'mctl:github_login': 'Carol' })), ctx),
    ).resolves.toEqual({ token: 'catalog-token-for-carol' });
    expect(ctx.signInWithCatalogUser).toHaveBeenCalledWith({
      entityRef: { name: 'carol' },
    });
  });

  it('refuses an unmapped account without looking anyone up', async () => {
    const ctx = context(['carol']);
    await expect(
      resolver(
        signInInfo(profile({ sub: '3141', email: 'carol@example.com' })),
        ctx,
      ),
    ).rejects.toMatchObject({
      name: 'NotAllowedError',
      message: expect.stringMatching(/not mapped/),
    });
    expect(ctx.signInWithCatalogUser).not.toHaveBeenCalled();
    expect(ctx.issueToken).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('sub=3141'),
    );
  });

  it('refuses a mapped login without a catalog User and issues no token', async () => {
    const ctx = context(['carol']);
    await expect(
      resolver(signInInfo(profile({ 'mctl:github_login': 'stranger' })), ctx),
    ).rejects.toMatchObject({
      name: 'NotAllowedError',
      message: expect.stringMatching(/not a member/),
    });
    expect(ctx.issueToken).not.toHaveBeenCalled();
  });

  it('propagates catalog failures instead of signing in', async () => {
    const ctx = context([]);
    ctx.signInWithCatalogUser.mockRejectedValue(
      new Error('catalog unavailable'),
    );
    await expect(
      resolver(signInInfo(profile({ 'mctl:github_login': 'carol' })), ctx),
    ).rejects.toThrow('catalog unavailable');
    expect(ctx.issueToken).not.toHaveBeenCalled();
  });
});
