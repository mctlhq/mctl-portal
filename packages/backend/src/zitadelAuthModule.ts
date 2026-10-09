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
 * nonce). A refresh without a new ID token falls back to the userinfo
 * response, which came from the issuer for this session's access token.
 *
 * No other claim is ever used in its place: e-mail, preferred_username and
 * sub are not GitHub logins, and guessing one would sign a person in as
 * someone else.
 */
export function githubLoginOf(profile: OidcAuthResult): string | null {
  if (profile.tokenset?.id_token) {
    return readGithubLogin(
      profile.tokenset.claims() as Record<string, unknown>,
    );
  }
  return readGithubLogin((profile.userinfo ?? {}) as Record<string, unknown>);
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
        `ZITADEL sign-in refused: no valid ${GITHUB_LOGIN_CLAIM} claim`,
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
 * The portal UI sign-in through ZITADEL, as auth provider `oidc`
 * (/api/auth/oidc). It is inert until `auth.providers.oidc` is configured:
 * the auth backend registers no routes for a provider without config, and
 * the frontend offers it only when `auth.signIn` selects it.
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
        providers.registerProvider({
          providerId: 'oidc',
          factory: createOAuthProviderFactory({
            authenticator: oidcAuthenticator,
            signInResolver: createZitadelSignInResolver(logger),
          }),
        });
      },
    });
  },
});
