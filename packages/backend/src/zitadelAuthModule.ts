import {
  createBackendModule,
  coreServices,
  LoggerService,
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

/**
 * Signs a ZITADEL user in only as the catalog User of their mapped GitHub
 * login: the same entity, membership and ownership as a GitHub sign-in
 * (createCatalogOnlySignInResolver), and never a user created from the
 * sign-in itself.
 */
export function createZitadelSignInResolver(
  logger: Pick<LoggerService, 'info' | 'warn'>,
): SignInResolver<OAuthAuthenticatorResult<OidcAuthResult>> {
  return async ({ result }, ctx) => {
    const login = githubLoginOf(result.fullProfile);
    if (!login) {
      logger.warn(
        `ZITADEL sign-in refused: no valid ${GITHUB_LOGIN_CLAIM} claim ` +
          `for sub=${subjectOf(result.fullProfile)}`,
      );
      throw new NotAllowedError(
        'Your MCTL account is not mapped to a portal user yet. ' +
          'Ask a platform admin to declare your GitHub login for it.',
      );
    }

    try {
      const signInResult = await ctx.signInWithCatalogUser({
        entityRef: { name: login },
      });
      logger.info(`ZITADEL signInWithCatalogUser OK for ${login}`);
      return signInResult;
    } catch (e: any) {
      if (e?.name === 'NotFoundError') {
        logger.warn(`ZITADEL sign-in refused for ${login}: no catalog User`);
        throw new NotAllowedError(
          'This account is not a member of any MCTL tenant. ' +
            'Register a team at mctl.ai or ask a team owner to invite you. ' +
            'Access is available about a minute after you are added.',
        );
      }
      throw e;
    }
  };
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
): void {
  providers.registerProvider({
    providerId: ZITADEL_AUTH_PROVIDER_ID,
    factory: createOAuthProviderFactory({
      authenticator: oidcAuthenticator,
      signInResolver: createZitadelSignInResolver(logger),
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
      },
      async init({ providers, logger }) {
        registerZitadelProvider(providers, logger);
      },
    });
  },
});
