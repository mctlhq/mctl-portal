import {
  createBackendModule,
  coreServices,
  LoggerService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';
import {
  oidcAuthenticator,
  OidcAuthResult,
} from '@backstage/plugin-auth-backend-module-oidc-provider';
import {
  AuthProvidersExtensionPoint,
  authProvidersExtensionPoint,
  createOAuthProviderFactory,
  OAuthAuthenticatorResult,
  SignInResolver,
} from '@backstage/plugin-auth-node';
import {
  GITHUB_LOGIN_CLAIM,
  readGithubLogin,
} from '@internal/plugin-oidc-provider-backend';
import {
  createZitadelCustomerResolver,
  ZitadelCustomerError,
  ZitadelCustomerResolver,
} from '@internal/plugin-tenant-backend';

/**
 * The GitHub login a ZITADEL sign-in maps to, or null when it maps to none.
 *
 * The portal knows people by GitHub login (catalog Users, tenant
 * membership), so a ZITADEL user is mapped through the `mctl:github_login`
 * claim, which ZITADEL emits for the portal's clients from metadata only the
 * IaC writes (mctlhq/mctl-portal#150). The ID token is read when the result
 * has one: openid-client has verified it (signature, issuer, audience,
 * nonce). A token response without an ID token, which ZITADEL returns on
 * refresh and could in principle return on any exchange, falls back to the
 * userinfo response, which the backend fetched from the issuer with this
 * session's access token.
 *
 * No other claim is ever used in its place: e-mail, preferred_username and
 * sub are not GitHub logins, and guessing one would sign a person in as
 * someone else.
 */
export function githubLoginOf(profile: OidcAuthResult): string | null {
  const claims = identityClaims(profile);
  return claims ? readGithubLogin(claims) : null;
}

// The claims a sign-in is judged on: the verified ID token when there is
// one, otherwise userinfo. An undecodable ID token yields null, so "the
// claim is unusable" always means "not mapped" rather than a 500.
function identityClaims(
  profile: OidcAuthResult,
): Record<string, unknown> | null {
  if (profile.tokenset?.id_token) {
    try {
      return profile.tokenset.claims() as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return (profile.userinfo ?? {}) as Record<string, unknown>;
}

// The ZITADEL subject, for correlating a refused sign-in with the ZITADEL
// audit log. Logged only; never used to decide who someone is.
function subjectOf(profile: OidcAuthResult): string {
  const sub = identityClaims(profile)?.sub;
  return typeof sub === 'string' && sub ? sub : 'unknown';
}

/** The claim naming the organization a ZITADEL user belongs to. */
export const RESOURCE_OWNER_CLAIM = 'urn:zitadel:iam:user:resourceowner:id';

// Claims only mctl-api's identity hook sets, and only for the customers
// organization. Any of them marks the token as a customer's even when the
// organization claim says otherwise. `mctl:github_login` is not among them:
// staff tokens carry it too.
const CUSTOMER_MARKERS = ['mctl:org', 'mctl:idp', 'mctl:github_id', 'mctl:refused'];

/**
 * Who a ZITADEL sign-in is: `staff` (an organization other than customers,
 * mapped by GitHub login as before), `customer` (a self-service account,
 * mapped by principal through mctl-api), or `unknown` when the organization
 * could not be observed. Unknown is never staff: a customer whose token lost
 * the organization claim would otherwise sign in by a login that GitHub can
 * hand to someone else.
 */
export function accountKindOf(
  claims: Record<string, unknown> | null,
  customersOrgId: string | undefined,
): 'staff' | 'customer' | 'unknown' {
  if (!claims || !customersOrgId) return 'unknown';
  if (CUSTOMER_MARKERS.some(k => k in claims)) return 'customer';
  const owner = claims[RESOURCE_OWNER_CLAIM];
  if (typeof owner !== 'string' || !owner) return 'unknown';
  return owner === customersOrgId ? 'customer' : 'staff';
}

export interface CustomerSignInOptions {
  /** ZITADEL id of the customers organization; unset refuses every sign-in. */
  organizationId?: string;
  /** mctl-api surface-principals/zitadel; unset refuses every customer. */
  resolve?: ZitadelCustomerResolver;
}

const NOT_A_MEMBER =
  'This account is not a member of any MCTL tenant. ' +
  'Register a team at mctl.ai or ask a team owner to invite you. ' +
  'Access is available about a minute after you are added.';

const UNAVAILABLE =
  'Signing in is unavailable right now. Try again in a few minutes.';

/**
 * Signs a ZITADEL user in only as an existing catalog User, never a user
 * created from the sign-in itself:
 * - staff: the User of their mapped GitHub login, the same entity,
 *   membership and ownership as a GitHub sign-in
 *   (createCatalogOnlySignInResolver);
 * - customers: the User named by their principal (lowercased, as TenantSync
 *   names principal-keyed members), which mctl-api resolves from the ID
 *   token by the GitHub id the identity hook proved.
 */
export function createZitadelSignInResolver(
  logger: Pick<LoggerService, 'info' | 'warn'>,
  customers: CustomerSignInOptions = {},
): SignInResolver<OAuthAuthenticatorResult<OidcAuthResult>> {
  return async ({ result }, ctx) => {
    const profile = result.fullProfile;
    const kind = accountKindOf(identityClaims(profile), customers.organizationId);
    const sub = subjectOf(profile);

    if (kind === 'unknown') {
      logger.warn(
        `ZITADEL sign-in refused: the organization of sub=${sub} could not be observed` +
          (customers.organizationId ? '' : ' (no customers organization configured)'),
      );
      throw new NotAllowedError(UNAVAILABLE);
    }

    let name: string;
    if (kind === 'customer') {
      name = await customerEntityName(profile, sub, customers.resolve, logger);
    } else {
      const login = githubLoginOf(profile);
      if (!login) {
        logger.warn(
          `ZITADEL sign-in refused: no valid ${GITHUB_LOGIN_CLAIM} claim ` +
            `for sub=${sub}`,
        );
        throw new NotAllowedError(
          'Your MCTL account is not mapped to a portal user yet. ' +
            'Ask a platform admin to declare your GitHub login for it.',
        );
      }
      name = login;
    }

    try {
      const signInResult = await ctx.signInWithCatalogUser({
        entityRef: { name },
      });
      logger.info(`ZITADEL signInWithCatalogUser OK for ${name}`);
      return signInResult;
    } catch (e: any) {
      if (e?.name === 'NotFoundError') {
        logger.warn(`ZITADEL sign-in refused for ${name}: no catalog User`);
        throw new NotAllowedError(NOT_A_MEMBER);
      }
      throw e;
    }
  };
}

// The catalog name of a customer: their principal, lowercased.
async function customerEntityName(
  profile: OidcAuthResult,
  sub: string,
  resolve: ZitadelCustomerResolver | undefined,
  logger: Pick<LoggerService, 'info' | 'warn'>,
): Promise<string> {
  if (!resolve) {
    logger.warn(`ZITADEL customer sign-in refused for sub=${sub}: mctl-api is not configured`);
    throw new NotAllowedError(UNAVAILABLE);
  }
  // mctl-api verifies the ID token itself; a token response without one
  // (a refresh) cannot be resolved, and userinfo is no substitute.
  const idToken = profile.tokenset?.id_token;
  if (!idToken) {
    logger.warn(`ZITADEL customer sign-in refused for sub=${sub}: no ID token`);
    throw new NotAllowedError('Your session has expired. Sign in again.');
  }
  try {
    const { principalId } = await resolve(idToken, 'signin');
    return principalId.toLowerCase();
  } catch (e) {
    if (e instanceof ZitadelCustomerError && e.kind === 'refused') {
      logger.warn(`ZITADEL customer sign-in refused for sub=${sub}: ${e.code ?? 'refused'}`);
      throw new NotAllowedError(
        'This MCTL account cannot sign in to the portal. ' +
          'Contact MCTL support if you think this is a mistake.',
      );
    }
    logger.warn(`ZITADEL customer sign-in for sub=${sub} could not be resolved: ${e}`);
    throw new NotAllowedError(UNAVAILABLE);
  }
}

/**
 * The auth provider id of the ZITADEL sign-in, which is also its route
 * (/api/auth/oidc). It must equal ZITADEL_AUTH_PROVIDER_ID in
 * packages/app/src/signIn.ts: a mismatch is a 404 at sign-in that no type
 * check sees. Both sides pin it to 'oidc' in their tests.
 */
export const ZITADEL_AUTH_PROVIDER_ID = 'oidc';

/** Registers the ZITADEL sign-in with the auth backend. */
export function registerZitadelProvider(
  providers: Pick<AuthProvidersExtensionPoint, 'registerProvider'>,
  logger: Pick<LoggerService, 'info' | 'warn'>,
  customers: CustomerSignInOptions = {},
): void {
  providers.registerProvider({
    providerId: ZITADEL_AUTH_PROVIDER_ID,
    factory: createOAuthProviderFactory({
      authenticator: oidcAuthenticator,
      signInResolver: createZitadelSignInResolver(logger, customers),
    }),
  });
}

/**
 * The portal UI sign-in through ZITADEL, as auth provider `oidc`.
 *
 * Two independent switches:
 * - `auth.providers.oidc`: without it the auth backend registers no routes
 *   for the provider. With it, /api/auth/oidc/start works for anyone who
 *   calls it, whatever the sign-in page shows.
 * - `auth.signIn`: which buttons the sign-in page shows. For ZITADEL it
 *   changes only what is offered. `zitadel` also turns the GitHub sign-in
 *   off on the backend (githubSignInResolverFor in githubAuthModule.ts).
 * Who can sign in through ZITADEL is decided only by
 * createZitadelSignInResolver.
 *
 * `@backstage/plugin-auth-backend-module-oidc-provider` is pinned exactly in
 * package.json, to the version that matches the Backstage release in use
 * (0.4.16 for 1.51.1). A caret range resolves a newer release that brings a
 * second copy of `plugin-auth-node`; restore the exact pin if a
 * `versions:bump` turns it back into a range.
 */
export const zitadelAuthModule = createBackendModule({
  pluginId: 'auth',
  moduleId: 'zitadel-provider',
  register(reg) {
    reg.registerInit({
      deps: {
        providers: authProvidersExtensionPoint,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
      },
      async init({ providers, logger, config }) {
        registerZitadelProvider(providers, logger, customerSignInOptions(config, logger));
      },
    });
  },
});

/**
 * `zitadelCustomers.organizationId` names the customers organization; the
 * portal's client must ask for `urn:zitadel:iam:user:resourceowner`
 * (auth.providers.oidc.<env>.additionalScopes) so tokens carry it. Without
 * it no ZITADEL sign-in is accepted, since staff could not be told from
 * customers. mctl-api is reached with the work-items surface credentials,
 * as tenant-backend does.
 */
export function customerSignInOptions(
  config: Pick<RootConfigService, 'getOptionalString'>,
  logger: Pick<LoggerService, 'warn' | 'error'>,
): CustomerSignInOptions {
  const organizationId = config.getOptionalString('zitadelCustomers.organizationId') || undefined;
  const baseUrl = config.getOptionalString('workItems.baseUrl');
  const surfaceToken = config.getOptionalString('workItems.surfaceToken');
  if (!organizationId) {
    logger.warn('zitadelCustomers.organizationId is not set: every ZITADEL sign-in is refused');
  }
  return {
    organizationId,
    resolve:
      baseUrl && surfaceToken
        ? createZitadelCustomerResolver({ baseUrl, surfaceToken, logger })
        : undefined,
  };
}
