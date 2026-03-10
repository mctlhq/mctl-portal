import { Router, Request, Response } from 'express';
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import { KubernetesUsageClient } from './k8sClient';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  k8sClient: KubernetesUsageClient;
}

export function createRouter(opts: RouterOptions): Router {
  const { logger, httpAuth, k8sClient } = opts;
  const router = Router();

  // ── GET /health ───────────────────────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // ── GET /namespaces/:ns/usage ─────────────────────────────────────────────
  // Returns aggregated quota + live usage for a namespace.
  // Requires Backstage user or service credentials.
  router.get('/namespaces/:ns/usage', async (req: Request, res: Response) => {
    try {
      await httpAuth.credentials(req, { allow: ['user', 'service'] });
    } catch {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { ns } = req.params;
    try {
      const usage = await k8sClient.getNamespaceUsage(ns);
      res.json(usage);
    } catch (err: any) {
      logger.error(`[resource-usage] GET /namespaces/${ns}/usage error: ${err}`);
      res.status(500).json({ error: String(err?.message ?? 'Internal error') });
    }
  });

  // ── GET /namespaces/:ns/pods ──────────────────────────────────────────────
  // Returns per-pod CPU/memory usage from metrics-server.
  router.get('/namespaces/:ns/pods', async (req: Request, res: Response) => {
    try {
      await httpAuth.credentials(req, { allow: ['user', 'service'] });
    } catch {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const { ns } = req.params;
    try {
      const pods = await k8sClient.getPodUsage(ns);
      res.json({ pods });
    } catch (err: any) {
      logger.error(`[resource-usage] GET /namespaces/${ns}/pods error: ${err}`);
      res.status(500).json({ error: String(err?.message ?? 'Internal error') });
    }
  });

  return router;
}
