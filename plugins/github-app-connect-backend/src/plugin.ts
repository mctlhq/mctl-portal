import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { RepoConnectionStore } from './store';

export const githubAppConnectPlugin = createBackendPlugin({
  pluginId: 'github-app-connect',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        database: coreServices.database,
      },
      async init({ config, logger, httpRouter, database }) {
        const appSlug = config.getString('githubAppConnect.appSlug');
        const appId = config.getString('githubAppConnect.appId');
        const privateKey = config.getString('githubAppConnect.privateKey');
        const baseUrl = config.getString('app.baseUrl');

        const knex = await database.getClient();
        const store = new RepoConnectionStore(knex);
        await store.initialize();
        logger.info('repo_connections table initialized');

        const router = createRouter({
          logger: logger as any,
          store,
          appSlug,
          appId,
          privateKey,
          baseUrl,
        });

        httpRouter.use(router);
        httpRouter.addAuthPolicy({
          path: '/callback',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/install-url',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/repo-access',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/install-status',
          allow: 'unauthenticated',
        });

        logger.info('GitHub App Connect plugin initialized');
      },
    });
  },
});
