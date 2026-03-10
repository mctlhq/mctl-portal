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
      },
      async init({ config, logger, httpRouter, httpAuth }) {
        // ── K8s config ─────────────────────────────────────────────────────────
        const kubeConfigType = (
          config.getOptionalString('resourceUsage.kubeConfigType') ?? 'inCluster'
        ) as 'inCluster' | 'default' | 'token';

        const kubeApiUrl = config.getOptionalString('resourceUsage.kubeApiUrl');
        const kubeToken = config.getOptionalString('resourceUsage.kubeToken');
        const skipTLSVerify = config.getOptionalBoolean('resourceUsage.skipTLSVerify') ?? false;

        // ── K8s client ─────────────────────────────────────────────────────────
        const k8sClient = new KubernetesUsageClient({
          logger,
          kubeConfigType,
          kubeApiUrl,
          kubeToken,
          skipTLSVerify,
          cacheTtlMs: 30_000, // 30s cache to avoid hammering K8s API
        });

        // ── HTTP router ────────────────────────────────────────────────────────
        const router = createRouter({ logger, httpAuth, k8sClient });
        httpRouter.use(router);

        logger.info(
          `[ResourceUsagePlugin] Initialized. kubeConfigType: ${kubeConfigType}`,
        );
      },
    });
  },
});
