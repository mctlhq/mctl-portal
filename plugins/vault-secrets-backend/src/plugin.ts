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
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
      },
      async init({ config, logger, httpRouter, httpAuth, userInfo }) {
        const vaultAddr = config.getString('vaultSecrets.endpoint');
        const vaultToken = config.getString('vaultSecrets.token');

        const router = createRouter({ logger, httpAuth, userInfo, vaultAddr, vaultToken });
        httpRouter.use(router);

        logger.info('Vault Secrets plugin initialized');
      },
    });
  },
});
