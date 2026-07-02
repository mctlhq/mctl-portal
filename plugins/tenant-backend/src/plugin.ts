import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { ArgoWorkflowsClient } from '@internal/plugin-argo-workflows-backend';
import { TenantStore } from './tenantStore';
import { TenantSync } from './tenantSync';
import { createRouter } from './router';
import { getGithubAppInstallationToken } from './githubAppToken';

export const tenantPlugin = createBackendPlugin({
  pluginId: 'tenant-management',
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
        // ── Config ─────────────────────────────────────────────────────────
        const githubOrg = config.getString('tenantManagement.githubOrg');
        const repoName = config.getString('tenantManagement.repoName');
        const tenantsPath = config.getString('tenantManagement.tenantsPath');
        const syncIntervalMinutes = config.getOptionalNumber(
          'tenantManagement.syncIntervalMinutes',
        ) ?? 5;

        // GitHub token for reading mctl-gitops
        // Falls back to GitHub App installation token if static token not set
        const staticGithubToken = config.getOptionalString('tenantManagement.githubToken') ?? '';

        // GitHub App credentials for generating installation tokens
        const appId = config.getOptionalString('githubAppConnect.appId');
        const privateKey = config.getOptionalString('githubAppConnect.privateKey');
        const installationId = config.getOptionalString('tenantManagement.githubAppInstallationId');

        // Token provider: refreshes GitHub App token before each sync (tokens expire in 1 hour)
        let cachedToken = staticGithubToken;
        let tokenExpiresAt = 0;
        const getToken = async (): Promise<string> => {
          if (cachedToken && Date.now() < tokenExpiresAt) {
            return cachedToken;
          }
          if (staticGithubToken) {
            return staticGithubToken;
          }
          if (appId && privateKey && installationId) {
            cachedToken = await getGithubAppInstallationToken(appId, privateKey, installationId);
            tokenExpiresAt = Date.now() + 50 * 60 * 1000; // refresh 10 min before expiry
            logger.info('[TenantPlugin] Refreshed GitHub App installation token');
            return cachedToken;
          }
          throw new Error('No GitHub token available');
        };

        // Argo Workflows client (reuses argoWorkflows config)
        const argoBaseUrl = config.getString('argoWorkflows.baseUrl');
        const argoToken = config.getOptionalString('argoWorkflows.token');
        const argoNamespace = config.getString('argoWorkflows.namespace');

        // ── Initialize store ───────────────────────────────────────────────
        const store = new TenantStore(database, logger);
        await store.init();

        // ── Start sync ─────────────────────────────────────────────────────
        const hasTokenSource = !!staticGithubToken || (!!appId && !!privateKey && !!installationId);
        if (hasTokenSource) {
          const sync = new TenantSync(store, logger, {
            githubOrg,
            repoName,
            tenantsPath,
            getGithubToken: getToken,
            syncIntervalMinutes,
          });
          await sync.start();
        } else {
          logger.warn(
            '[TenantPlugin] No GitHub token configured — tenant sync disabled. ' +
              'Set tenantManagement.githubToken in config.',
          );
        }

        // ── Argo client ────────────────────────────────────────────────────
        const argoClient = new ArgoWorkflowsClient({
          baseUrl: argoBaseUrl,
          token: argoToken,
        });

        // Optional static token for external callers (e.g. Cloudflare Worker landing page)
        const landingPageToken = config.getOptionalString(
          'tenantManagement.landingPageToken',
        );

        // Default resource quotas for new tenants (from config, with sensible fallbacks)
        const dqConfig = config.getOptionalConfig('tenantManagement.defaultQuotas');
        const defaultQuotas = dqConfig ? {
          cpuReq:   dqConfig.getOptionalString('cpuReq')   ?? '1',
          cpuLim:   dqConfig.getOptionalString('cpuLim')   ?? '2',
          memReq:   dqConfig.getOptionalString('memReq')   ?? '2Gi',
          memLim:   dqConfig.getOptionalString('memLim')   ?? '3Gi',
          pods:     dqConfig.getOptionalString('pods')     ?? '10',
          pvcs:     dqConfig.getOptionalString('pvcs')     ?? '2',
          services: dqConfig.getOptionalString('services') ?? '5',
        } : undefined;

        const maxTeamsPerTenant = config.getOptionalNumber('tenantManagement.maxTeamsPerTenant') ?? 1;

        // ── HTTP router ────────────────────────────────────────────────────
        const router = createRouter({
          logger,
          httpAuth,
          userInfo,
          store,
          argoClient,
          argoNamespace,
          landingPageToken,
          defaultQuotas,
          maxTeamsPerTenant,
          getGithubToken: getToken,
        });
        httpRouter.use(router);
        // The catalog's UrlReader cannot send Backstage credentials, so this must
        // bypass the auth middleware; the handler enforces the landing token
        // (Bearer header or ?token= query parameter) itself.
        httpRouter.addAuthPolicy({
          path: '/backstage/catalog.yaml',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/health',
          allow: 'unauthenticated',
        });
        // External callers (Cloudflare Worker landing page) use a static bearer token
        // handled by resolveAuth() — mark as unauthenticated at the Backstage middleware level
        // so the global auth middleware doesn't reject them before the router runs.
        httpRouter.addAuthPolicy({
          path: '/tenants',
          allow: 'unauthenticated',
        });
        httpRouter.addAuthPolicy({
          path: '/check-user',
          allow: 'unauthenticated',
        });

        logger.info(
          `[TenantPlugin] Initialized. Sync interval: ${syncIntervalMinutes} min. ` +
            `Tenants path: ${githubOrg}/${repoName}/${tenantsPath}`,
        );
      },
    });
  },
});
