import {
  createBackendModule,
  coreServices,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';
import { githubAuthenticator } from '@backstage/plugin-auth-backend-module-github-provider';
import {
  AuthProvidersExtensionPoint,
  authProvidersExtensionPoint,
  createOAuthProviderFactory,
  OAuthAuthenticatorResult,
  PassportProfile,
  SignInResolver,
} from '@backstage/plugin-auth-node';

/**
 * Signs a GitHub user in only as their catalog User entity.
 *
 * Catalog Users are generated from tenant membership (tenant-backend's
 * catalog provider), so a GitHub account that belongs to no tenant has no
 * entity and is refused here. Any GitHub account can complete the OAuth
 * flow, which is why there must be no fallback session: every backend route
 * that accepts "any user" would otherwise be open to the whole of GitHub.
 *
 * Platform admins are catalog Users too (members of the admins tenant), and
 * their group ownership comes from the same entity.
 */
export function createCatalogOnlySignInResolver(
  logger: Pick<LoggerService, 'info' | 'warn'>,
): SignInResolver<OAuthAuthenticatorResult<PassportProfile>> {
  return async ({ result }, ctx) => {
    const login = (result.fullProfile.username ?? '').toLowerCase();
    if (!login) {
      throw new Error('GitHub profile missing username — cannot sign in');
    }

    try {
      const signInResult = await ctx.signInWithCatalogUser({
        entityRef: { name: login },
      });
      logger.info(`signInWithCatalogUser OK for ${login}`);
      return signInResult;
    } catch (e: any) {
      if (e?.name === 'NotFoundError') {
        logger.warn(`sign-in refused for ${login}: no catalog User`);
        throw new NotAllowedError(
          'This GitHub account is not a member of any MCTL tenant. ' +
            'Register a team at mctl.ai or ask a team owner to invite you. ' +
            'Access is available about a minute after you are added.',
        );
      }
      throw e;
    }
  };
}

/**
 * The GitHub sign-in resolver for an `auth.signIn` mode, or undefined when
 * GitHub must not sign anyone in.
 *
 * `auth.signIn: zitadel` makes ZITADEL the only way into the portal. The
 * sign-in page then hides the GitHub button, but hiding it is not enough:
 * /api/auth/github/start stays reachable, and with a resolver its callback
 * would still hand out a Backstage identity. Without one, the provider
 * keeps doing what ScmAuth and the scaffolder need it for (a GitHub access
 * token for the signed-in user) and returns no identity, so it cannot
 * be used to sign in.
 *
 * Every other value keeps the GitHub sign-in: `github` and `both` offer it,
 * and an unknown value falls back to GitHub on the sign-in page
 * (packages/app/src/signIn.ts), so turning it off here would lock everyone
 * out of a typo.
 */
export function githubSignInResolverFor(
  signInMode: string | undefined,
  logger: Pick<LoggerService, 'info' | 'warn'>,
): SignInResolver<OAuthAuthenticatorResult<PassportProfile>> | undefined {
  if (signInMode === 'zitadel') {
    return undefined;
  }
  return createCatalogOnlySignInResolver(logger);
}

/** Registers the GitHub provider with the auth backend. */
export function registerGithubProvider(
  providers: Pick<AuthProvidersExtensionPoint, 'registerProvider'>,
  signInMode: string | undefined,
  logger: Pick<LoggerService, 'info' | 'warn'>,
): void {
  const signInResolver = githubSignInResolverFor(signInMode, logger);
  if (!signInResolver) {
    logger.info(
      'GitHub sign-in is off (auth.signIn: zitadel); the GitHub provider ' +
        'only issues access tokens',
    );
  }
  providers.registerProvider({
    providerId: 'github',
    factory: createOAuthProviderFactory({
      authenticator: githubAuthenticator,
      signInResolver,
    }),
  });
}

export const githubAuthModule = createBackendModule({
  pluginId: 'auth',
  moduleId: 'github-provider',
  register(reg) {
    reg.registerInit({
      deps: {
        providers: authProvidersExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({ providers, config, logger }) {
        registerGithubProvider(
          providers,
          config.getOptionalString('auth.signIn'),
          logger,
        );
      },
    });
  },
});
