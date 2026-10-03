import { createBackendPlugin, coreServices } from '@backstage/backend-plugin-api';
import { createRouter } from './router';
import { MctlApiWorkItemsClient } from './mctlApiClient';

/** Only `/health` is public; everything else requires a Backstage session. */
export function registerAuthPolicies(httpRouter: {
  addAuthPolicy: (policy: { path: string; allow: 'unauthenticated' | 'user-cookie' }) => void;
}): void {
  httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });
}

const DEFAULT_MCTL_API_BASE_URL = 'https://api.mctl.ai';

export const workItemsPlugin = createBackendPlugin({
  pluginId: 'work-items',
  register(env) {
    env.registerInit({
      deps: {
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
        config: coreServices.rootConfig,
      },
      async init({ logger, httpRouter, httpAuth, userInfo, config }) {
        const baseUrl = config.getOptionalString('workItems.baseUrl') || DEFAULT_MCTL_API_BASE_URL;
        // The surface:portal token only. Never fall back to an admin credential.
        const surfaceToken = config.getOptionalString('workItems.surfaceToken');
        const actionsEnabled = config.getOptionalBoolean('workItems.actionsEnabled') ?? false;
        const client = new MctlApiWorkItemsClient({
          baseUrl,
          surfaceToken,
          executionCanvasUrlTemplate: config.getOptionalString('workItems.executionCanvasUrlTemplate'),
          logger,
        });
        httpRouter.use(createRouter({ logger, workItems: client, httpAuth, userInfo, actionsEnabled }));
        registerAuthPolicies(httpRouter);
        if (!surfaceToken) {
          logger.warn('workItems.surfaceToken is unset; work item routes answer 503');
        }
        logger.info(`Work Items plugin initialized (mctl-api ${baseUrl}, actionsEnabled=${actionsEnabled})`);
      },
    });
  },
});
