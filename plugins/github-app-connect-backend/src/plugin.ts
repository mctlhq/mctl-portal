import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { notificationService } from '@backstage/plugin-notifications-node';
import { createRouter } from './router';
import { RepoConnectionStore } from './store';
import fetch from 'node-fetch';

export const githubAppConnectPlugin = createBackendPlugin({
  pluginId: 'github-app-connect',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        database: coreServices.database,
        discovery: coreServices.discovery,
        auth: coreServices.auth,
        notifications: notificationService,
      },
      async init({ config, logger, httpRouter, database, discovery, auth, notifications }) {
        const appSlug = config.getString('githubAppConnect.appSlug');
        const appId = config.getString('githubAppConnect.appId');
        const privateKey = config.getString('githubAppConnect.privateKey');
        const baseUrl = config.getString('app.baseUrl');
        const webhookSecret = config.getOptionalString('githubAppConnect.webhookSecret');

        const knex = await database.getClient();
        const store = new RepoConnectionStore(knex);
        await store.initialize();
        logger.info('repo_connections table initialized');

        // Build lightweight catalog client using discovery + auth
        const catalogClient = {
          async getEntities(request: { filter: Record<string, string> }) {
            const catalogUrl = await discovery.getBaseUrl('catalog');
            const filterStr = Object.entries(request.filter)
              .map(([k, v]) => `${k}=${v}`)
              .join(',');
            const { token } = await auth.getPluginRequestToken({
              onBehalfOf: await auth.getOwnServiceCredentials(),
              targetPluginId: 'catalog',
            });
            const resp = await fetch(`${catalogUrl}/entities?filter=${encodeURIComponent(filterStr)}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!resp.ok) throw new Error(`Catalog API error: ${resp.status}`);
            const items = await resp.json();
            return { items };
          },
        };

        // Build lightweight scaffolder client
        const scaffolderClient = {
          async createTask(request: { templateRef: string; values: Record<string, unknown> }) {
            const scaffolderUrl = await discovery.getBaseUrl('scaffolder');
            const { token } = await auth.getPluginRequestToken({
              onBehalfOf: await auth.getOwnServiceCredentials(),
              targetPluginId: 'scaffolder',
            });
            const resp = await fetch(`${scaffolderUrl}/v2/tasks`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                templateRef: request.templateRef,
                values: request.values,
              }),
            });
            if (!resp.ok) {
              const text = await resp.text();
              throw new Error(`Scaffolder API error: ${resp.status} ${text}`);
            }
            return resp.json();
          },
        };

        const router = createRouter({
          logger: logger as any,
          store,
          appSlug,
          appId,
          privateKey,
          baseUrl,
          webhookSecret,
          catalogClient,
          scaffolderClient,
          notifications,
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
        httpRouter.addAuthPolicy({
          path: '/repos',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/popup-done',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/repo-tags',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/service-config',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/webhook',
          allow: 'unauthenticated',
        });

        logger.info('GitHub App Connect plugin initialized');
      },
    });
  },
});
