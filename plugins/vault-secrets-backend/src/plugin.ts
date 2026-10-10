import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import {
  kubernetesTokenProvider,
  staticTokenProvider,
  VaultTokenProvider,
} from './vaultAuth';
import { isPostgresClient } from '../../tenant-backend/src/membershipLookup';

export const vaultSecretsPlugin = createBackendPlugin({
  pluginId: 'vault-secrets',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        database: coreServices.database,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
      },
      async init({ config, logger, database, httpRouter, httpAuth, userInfo }) {
        const vaultAddr = config.getString('vaultSecrets.endpoint');
        // Kubernetes auth is preferred: the pod proves its identity with its
        // own projected ServiceAccount token and Vault issues a short-lived
        // credential it can re-mint. The static token stays supported for
        // local dev and as a fallback, but it is the mode that broke in
        // production when the token was revoked with nothing to renew it.
        const kubernetesRole = config.getOptionalString(
          'vaultSecrets.kubernetesRole',
        );
        const staticToken = config.getOptionalString('vaultSecrets.token');

        let vaultTokens: VaultTokenProvider;
        if (kubernetesRole) {
          vaultTokens = kubernetesTokenProvider({
            vaultAddr,
            role: kubernetesRole,
            authPath: config.getOptionalString('vaultSecrets.kubernetesAuthPath'),
            jwtPath: config.getOptionalString(
              'vaultSecrets.serviceAccountTokenPath',
            ),
            logger,
          });
        } else if (staticToken) {
          logger.warn(
            'vault-secrets: using a static Vault token. Set vaultSecrets.kubernetesRole to authenticate with the pod ServiceAccount instead — a static token cannot recover if it is revoked.',
          );
          vaultTokens = staticTokenProvider(staticToken);
        } else {
          throw new Error(
            'vault-secrets: set either vaultSecrets.kubernetesRole or vaultSecrets.token',
          );
        }

        const db = await database.getClient();
        const isPostgres = isPostgresClient(db);

        const router = createRouter({
          logger,
          httpAuth,
          userInfo,
          db,
          isPostgres,
          vaultAddr,
          vaultTokens,
        });
        httpRouter.use(router);

        logger.info('Vault Secrets plugin initialized');
      },
    });
  },
});
