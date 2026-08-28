import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { CustomDomainStore } from './store';

/**
 * Registers the plugin's HTTP auth policies. Only `/health` is public; every
 * other route (notably `/domains*`) falls back to the Backstage default of
 * requiring authentication. Exported so a unit test can assert that the
 * previously-present unauthenticated `/domains` policies are not reintroduced.
 */
export function registerAuthPolicies(httpRouter: {
  addAuthPolicy: (policy: { path: string; allow: 'unauthenticated' | 'user-cookie' }) => void;
}): void {
  httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
}

export const customDomainsPlugin = createBackendPlugin({
  pluginId: 'custom-domains',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        database: coreServices.database,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
      },
      async init({ logger, httpRouter, database, httpAuth, userInfo }) {
        const knex = await database.getClient();
        const isPostgres = knex.client.config.client === 'pg';
        const store = new CustomDomainStore(knex);
        await store.initialize();
        logger.info('custom_domains table initialized');

        const router = createRouter({
          logger,
          store,
          httpAuth,
          userInfo,
          db: knex,
          isPostgres,
        });
        httpRouter.use(router);
        registerAuthPolicies(httpRouter);

        logger.info('Custom Domains plugin initialized');
      },
    });
  },
});
