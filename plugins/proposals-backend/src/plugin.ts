import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { buildGitopsClient } from './gitops-client';
import { createRouter } from './router';

export const proposalsPlugin = createBackendPlugin({
  pluginId: 'proposals',
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
        // Bail out early with a clear log line if the config is missing —
        // we don't want a half-wired plugin in production.
        if (!config.has('mctl.proposals.gitopsRepo')) {
          logger.warn(
            '[proposals-backend] mctl.proposals.gitopsRepo not configured — plugin disabled',
          );
          return;
        }
        const gitops = buildGitopsClient(config, logger);

        const router = createRouter({ logger, httpAuth, userInfo, gitops });
        httpRouter.use(router);
        httpRouter.addAuthPolicy({ path: '/health', allow: 'unauthenticated' });

        logger.info(
          `[proposals-backend] Initialized. Repo: ${config.getString(
            'mctl.proposals.gitopsRepo',
          )} basePath: ${
            config.getOptionalString('mctl.proposals.basePath') ??
            'platform-gitops/agents-state'
          }`,
        );
      },
    });
  },
});
