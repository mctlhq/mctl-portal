import {
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';

/**
 * Auth backend module that intercepts GitHub App installation callbacks
 * at /api/auth/github/handler/frame and redirects them to the
 * github-app-connect plugin's callback endpoint.
 *
 * Without this, the auth handler rejects the request with
 * "Must specify 'env' query to select environment" because the
 * GitHub App's Setup URL points to the auth handler path.
 */
export const authModuleGithubInstallRedirect = createBackendModule({
  pluginId: 'auth',
  moduleId: 'github-install-redirect',
  register(reg) {
    reg.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({ httpRouter, config, logger }) {
        const backendBaseUrl = config.getString('backend.baseUrl');

        httpRouter.use((req, res, next) => {
          // Only intercept GitHub App installation callbacks
          if (
            req.path === '/github/handler/frame' &&
            req.query.installation_id &&
            req.query.setup_action
          ) {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(req.query)) {
              if (value) params.append(key, String(value));
            }
            const redirectUrl = `${backendBaseUrl}/api/github-app-connect/callback?${params.toString()}`;
            logger.info(
              `Redirecting GitHub App installation callback to github-app-connect plugin: installation_id=${req.query.installation_id}`,
            );
            res.redirect(redirectUrl);
            return;
          }
          next();
        });
      },
    });
  },
});
