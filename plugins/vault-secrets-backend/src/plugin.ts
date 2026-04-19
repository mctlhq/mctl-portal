import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';

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
        const vaultToken = config.getString('vaultSecrets.token');
        const oidcLoginUrl =
          config.getOptionalString('vaultSecrets.oidcLoginUrl') ??
          '/api/oidc-provider/login';
        const backendBaseUrl = config.getString('backend.baseUrl');

        const db = await database.getClient();
        const isPostgres = db.client.config.client === 'pg';

        const router = createRouter({
          logger,
          httpAuth,
          userInfo,
          db,
          isPostgres,
          vaultAddr,
          vaultToken,
          oidcLoginUrl,
          backendBaseUrl,
        });
        httpRouter.use(router);

        // Browser-facing endpoint — bypass Backstage's default Bearer-auth
        // middleware; auth is enforced via oidc_session cookie in the handler.
        // Register both paths since httpRouter auth policy matching is exact.
        httpRouter.addAuthPolicy({
          path: '/openclaw/intake',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/openclaw/intake/',
          allow: 'unauthenticated',
        });

        logger.info('Vault Secrets plugin initialized');
      },
    });
  },
});
