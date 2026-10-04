import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { KubernetesUsageClient } from './k8sClient';
import { createRouter } from './router';

export const resourceUsagePlugin = createBackendPlugin({
  pluginId: 'resource-usage',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
        database: coreServices.database,
      },
      async init({ config, logger, httpRouter, httpAuth, userInfo, database }) {
        // ── K8s config ─────────────────────────────────────────────────────────
        const kubeConfigType = (
          config.getOptionalString('resourceUsage.kubeConfigType') ?? 'inCluster'
        ) as 'inCluster' | 'default' | 'token';

        const kubeApiUrl = config.getOptionalString('resourceUsage.kubeApiUrl');
        const kubeToken = config.getOptionalString('resourceUsage.kubeToken');
        const skipTLSVerify = config.getOptionalBoolean('resourceUsage.skipTLSVerify') ?? false;
        const caFile = config.getOptionalString('resourceUsage.caFile');

        // ── K8s client ─────────────────────────────────────────────────────────
        const k8sClient = new KubernetesUsageClient({
          logger,
          kubeConfigType,
          kubeApiUrl,
          kubeToken,
          skipTLSVerify,
          caFile,
          cacheTtlMs: 30_000, // 30s cache to avoid hammering K8s API
        });

        // ── HTTP router ────────────────────────────────────────────────────────
        // Tenant membership lives in tenant-backend's tenant_members table.
        const db = await database.getClient();
        const isPostgres = db.client.config.client === 'pg';
        const router = createRouter({ logger, httpAuth, userInfo, db, isPostgres, k8sClient });
        httpRouter.use(router);

        logger.info(
          `[ResourceUsagePlugin] Initialized. kubeConfigType: ${kubeConfigType}`,
        );
      },
    });
  },
});
