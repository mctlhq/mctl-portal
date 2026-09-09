import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { MctlApiDomainsClient } from './mctlApiClient';

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

const DEFAULT_MCTL_API_BASE_URL = 'https://api.mctl.ai';

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
        config: coreServices.rootConfig,
      },
      async init({ logger, httpRouter, database, httpAuth, userInfo, config }) {
        const knex = await database.getClient();
        const isPostgres = knex.client.config.client === 'pg';

        const baseUrl =
          config.getOptionalString('customDomains.baseUrl') ?? DEFAULT_MCTL_API_BASE_URL;
        if (!baseUrl) {
          throw new Error(
            'customDomains.baseUrl resolved empty; cannot reach the mctl-api domains registry',
          );
        }
        const token = config.getOptionalString('customDomains.token');
        const domainsClient = new MctlApiDomainsClient({ baseUrl, token });

        const router = createRouter({
          logger,
          domains: domainsClient,
          httpAuth,
          userInfo,
          db: knex,
          isPostgres,
        });
        httpRouter.use(router);
        registerAuthPolicies(httpRouter);

        logger.info(`Custom Domains plugin initialized as a gateway to mctl-api (${baseUrl})`);
      },
    });
  },
});
