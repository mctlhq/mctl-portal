import { NotFoundError } from '@backstage/errors';
import { ZitadelCustomerError } from '@internal/plugin-tenant-backend';
import {
  accountKindOf,
  createZitadelSignInResolver,
  customerSignInOptions,
  githubLoginOf,
  registerZitadelProvider,
  ZITADEL_AUTH_PROVIDER_ID,
} from './zitadelAuthModule';

const CUSTOMERS = '395272528420931285';
const STAFF_ORG = '111111111111111111';
const OWNER = 'urn:zitadel:iam:user:resourceowner:id';
const staff = (claims: Record<string, unknown>) => ({ [OWNER]: STAFF_ORG, ...claims });

const logger = { info: jest.fn(), warn: jest.fn() };

// Log assertions must see only the calls of their own test.
beforeEach(() => jest.clearAllMocks());

describe('registerZitadelProvider', () => {
  it('registers the sign-in as provider oidc', () => {
    // Pinned on both sides: packages/app/src/signIn.test.ts asserts the
    // frontend id is 'oidc' too. A mismatch is a 404 at sign-in.
    expect(ZITADEL_AUTH_PROVIDER_ID).toBe('oidc');
    const registerProvider = jest.fn();
    registerZitadelProvider({ registerProvider }, logger);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect(registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'oidc' }),
    );
  });
});

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
  const resolver = createZitadelSignInResolver(logger, { organizationId: CUSTOMERS });

  it('signs a mapped catalog User in as that entity', async () => {
    const ctx = context(['carol']);
    await expect(
      resolver(signInInfo(profile(staff({ 'mctl:github_login': 'Carol' }))), ctx),
    ).resolves.toEqual({ token: 'catalog-token-for-carol' });
    expect(ctx.signInWithCatalogUser).toHaveBeenCalledWith({
      entityRef: { name: 'carol' },
    });
  });

  it('refuses an unmapped account without looking anyone up', async () => {
    const ctx = context(['carol']);
    await expect(
      resolver(
        signInInfo(profile(staff({ sub: '3141', email: 'carol@example.com' }))),
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
      resolver(signInInfo(profile(staff({ 'mctl:github_login': 'stranger' }))), ctx),
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
      resolver(signInInfo(profile(staff({ 'mctl:github_login': 'carol' }))), ctx),
    ).rejects.toThrow('catalog unavailable');
    expect(ctx.issueToken).not.toHaveBeenCalled();
  });
});

describe('accountKindOf', () => {
  it.each([
    ['another organization', { [OWNER]: STAFF_ORG }, 'staff'],
    ['the customers organization', { [OWNER]: CUSTOMERS }, 'customer'],
    ['a hook claim on another organization', { [OWNER]: STAFF_ORG, 'mctl:github_id': '42' }, 'customer'],
    ['a hook refusal', { [OWNER]: STAFF_ORG, 'mctl:refused': 'login_reserved' }, 'customer'],
    ['no organization claim', { 'mctl:github_login': 'carol' }, 'unknown'],
    ['an empty organization claim', { [OWNER]: '' }, 'unknown'],
    ['a non-string organization claim', { [OWNER]: 42 }, 'unknown'],
  ])('reads %s', (_name, claims, kind) => {
    expect(accountKindOf(claims, CUSTOMERS)).toBe(kind);
  });

  it('is unknown when no customers organization is configured', () => {
    expect(accountKindOf({ [OWNER]: STAFF_ORG }, undefined)).toBe('unknown');
  });
});

describe('createZitadelSignInResolver for customers', () => {
  const BOB = 'prn_01M45DR1GWC87109EH88VBJX25';
  // Bob registered `alice` after Alice, a staff member signed in as
  // user:default/alice, gave it up.
  const bobClaims = {
    sub: '900',
    [OWNER]: CUSTOMERS,
    'mctl:org': 'customers',
    'mctl:idp': 'github',
    'mctl:github_id': '77',
    'mctl:github_login': 'alice',
  };
  const resolveTo = (principalId: string) =>
    jest.fn(async () => ({ principalId, githubId: '77', githubLogin: 'alice' }));

  it('signs a customer in as their principal-keyed User, never by login', async () => {
    const resolve = resolveTo(BOB);
    const ctx = context(['alice', BOB.toLowerCase()]);
    await expect(
      createZitadelSignInResolver(logger, { organizationId: CUSTOMERS, resolve })(
        signInInfo(profile(bobClaims)),
        ctx,
      ),
    ).resolves.toEqual({ token: `catalog-token-for-${BOB.toLowerCase()}` });
    expect(resolve).toHaveBeenCalledWith('header.payload.signature', 'signin');
    expect(ctx.signInWithCatalogUser).toHaveBeenCalledTimes(1);
    expect(ctx.signInWithCatalogUser).toHaveBeenCalledWith({ entityRef: { name: BOB.toLowerCase() } });
  });

  it('refuses a customer without a principal-keyed User', async () => {
    const ctx = context(['alice']);
    await expect(
      createZitadelSignInResolver(logger, { organizationId: CUSTOMERS, resolve: resolveTo(BOB) })(
        signInInfo(profile(bobClaims)),
        ctx,
      ),
    ).rejects.toMatchObject({ name: 'NotAllowedError', message: expect.stringMatching(/not a member/) });
  });

  it.each([
    ['mctl-api refuses the customer', new ZitadelCustomerError('refused', 'no', 'customer_conflict'), /cannot sign in/],
    ['mctl-api is unavailable', new ZitadelCustomerError('unavailable', 'down'), /unavailable/],
    ['the call throws something else', new Error('boom'), /unavailable/],
  ])('refuses without a catalog lookup when %s', async (_name, err, message) => {
    const ctx = context(['alice']);
    const resolve = jest.fn(async () => {
      throw err;
    });
    await expect(
      createZitadelSignInResolver(logger, { organizationId: CUSTOMERS, resolve })(
        signInInfo(profile(bobClaims)),
        ctx,
      ),
    ).rejects.toMatchObject({ name: 'NotAllowedError', message: expect.stringMatching(message) });
    expect(ctx.signInWithCatalogUser).not.toHaveBeenCalled();
  });

  it('refuses a customer when mctl-api is not configured', async () => {
    const ctx = context(['alice']);
    await expect(
      createZitadelSignInResolver(logger, { organizationId: CUSTOMERS })(signInInfo(profile(bobClaims)), ctx),
    ).rejects.toMatchObject({ name: 'NotAllowedError', message: expect.stringMatching(/unavailable/) });
    expect(ctx.signInWithCatalogUser).not.toHaveBeenCalled();
  });

  it('refuses a customer refresh without an ID token instead of reading userinfo', async () => {
    const resolve = resolveTo(BOB);
    const ctx = context(['alice', BOB.toLowerCase()]);
    await expect(
      createZitadelSignInResolver(logger, { organizationId: CUSTOMERS, resolve })(
        signInInfo(profile(undefined, bobClaims)),
        ctx,
      ),
    ).rejects.toMatchObject({ name: 'NotAllowedError', message: expect.stringMatching(/Sign in again/) });
    expect(resolve).not.toHaveBeenCalled();
    expect(ctx.signInWithCatalogUser).not.toHaveBeenCalled();
  });

  it.each([
    ['carries no organization claim', { 'mctl:github_login': 'alice' }, { organizationId: CUSTOMERS }],
    ['meets no configured customers organization', staff({ 'mctl:github_login': 'alice' }), {}],
  ])('refuses a token that %s rather than sign it in by login', async (_name, claims, opts) => {
    const ctx = context(['alice']);
    await expect(
      createZitadelSignInResolver(logger, opts)(signInInfo(profile(claims)), ctx),
    ).rejects.toMatchObject({ name: 'NotAllowedError', message: expect.stringMatching(/unavailable/) });
    expect(ctx.signInWithCatalogUser).not.toHaveBeenCalled();
  });
});

describe('customerSignInOptions', () => {
  const config = (values: Record<string, string>) => ({ getOptionalString: (k: string) => values[k] });
  const log = { warn: jest.fn(), error: jest.fn() };

  it('wires the organization and the mctl-api resolver', () => {
    const o = customerSignInOptions(
      config({ 'zitadelCustomers.organizationId': CUSTOMERS, 'workItems.baseUrl': 'http://api', 'workItems.surfaceToken': 't' }),
      log,
    );
    expect(o.organizationId).toBe(CUSTOMERS);
    expect(o.resolve).toEqual(expect.any(Function));
  });

  it('leaves both unset, and says so, without configuration', () => {
    const o = customerSignInOptions(config({ 'zitadelCustomers.organizationId': '' }), log);
    expect(o).toEqual({ organizationId: undefined, resolve: undefined });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('every ZITADEL sign-in is refused'));
  });
});
