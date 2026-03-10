import {
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import { githubAuthenticator } from '@backstage/plugin-auth-backend-module-github-provider';
import {
  authProvidersExtensionPoint,
  createOAuthProviderFactory,
} from '@backstage/plugin-auth-node';

/**
 * Custom GitHub auth module:
 * 1. Any GitHub user can OAuth — no org membership required.
 * 2. For users IN catalog (in a team): full token with group ownership.
 * 3. For users NOT IN catalog yet: minimal fallback token so they can
 *    log in and browse, but have no team-scoped permissions.
 *
 * Access control is handled by tenant_members DB, not GitHub org membership.
 */
export const githubAuthModuleWithFallback = createBackendModule({
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
            async signInResolver({ result }, ctx) {
              const login =
                (result.fullProfile.username ?? '').toLowerCase();
              if (!login) {
                throw new Error(
                  'GitHub profile missing username — cannot sign in',
                );
              }

              try {
                const signInResult = await ctx.signInWithCatalogUser({
                  entityRef: { name: login },
                });
                logger.info(
                  `signInWithCatalogUser OK for ${login}`,
                );
                return signInResult;
              } catch (e: any) {
                if (e.name === 'NotFoundError') {
                  // User not yet in any team — issue minimal token so
                  // they can reach Backstage until an admin invites them.
                  logger.info(
                    `signInWithCatalogUser NOT FOUND for ${login}, using fallback`,
                  );
                  return ctx.issueToken({
                    claims: {
                      sub: `user:default/${login}`,
                      ent: [`user:default/${login}`],
                    },
                  });
                }
                throw e;
              }
            },
          }),
        });
      },
    });
  },
});
