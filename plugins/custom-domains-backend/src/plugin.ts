import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { CustomDomainStore } from './store';

export const customDomainsPlugin = createBackendPlugin({
  pluginId: 'custom-domains',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        database: coreServices.database,
      },
      async init({ logger, httpRouter, database }) {
        const knex = await database.getClient();
        const store = new CustomDomainStore(knex);
        await store.initialize();
        logger.info('custom_domains table initialized');

        const router = createRouter({ logger, store });
        httpRouter.use(router);
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });

        logger.info('Custom Domains plugin initialized');
      },
    });
  },
});
