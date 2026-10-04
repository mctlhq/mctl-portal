import {
  createBackendModule,
  coreServices,
  LoggerService,
} from '@backstage/backend-plugin-api';
import { NotAllowedError } from '@backstage/errors';
import { githubAuthenticator } from '@backstage/plugin-auth-backend-module-github-provider';
import {
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

export const githubAuthModule = createBackendModule({
  pluginId: 'auth',
  moduleId: 'github-provider',
  register(reg) {
    reg.registerInit({
      deps: {
        providers: authProvidersExtensionPoint,
        logger: coreServices.logger,
      },
      async init({ providers, logger }) {
        providers.registerProvider({
          providerId: 'github',
          factory: createOAuthProviderFactory({
            authenticator: githubAuthenticator,
            signInResolver: createCatalogOnlySignInResolver(logger),
          }),
        });
      },
    });
  },
});
