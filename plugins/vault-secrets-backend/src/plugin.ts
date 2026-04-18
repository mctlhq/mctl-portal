import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { TenantStore } from '../../tenant-backend/src/tenantStore';

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
        const store = new TenantStore(database, logger);
        await store.init();

        const db = await database.getClient();
        const isPostgres = db.client.config.client === 'pg';

        const router = createRouter({
          logger,
          httpAuth,
          userInfo,
          store,
          db,
          isPostgres,
          vaultAddr,
          vaultToken,
          oidcLoginUrl,
        });
        httpRouter.use(router);

        httpRouter.addAuthPolicy({
          path: '/openclaw/intake',
          allow: 'unauthenticated',
        });

        logger.info('Vault Secrets plugin initialized');
      },
    });
  },
});
