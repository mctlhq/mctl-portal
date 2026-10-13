import { Router, Request, Response } from 'express';
import type { Knex } from 'knex';
import {
  HttpAuthService,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { getTenantMember, isAdminUser } from '../../tenant-backend/src/membershipLookup';
import { KubernetesUsageClient } from './k8sClient';
import { createRateLimiters, RateLimits } from '../../tenant-backend/src/rateLimit';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  db: Knex;
  isPostgres: boolean;
  k8sClient: Pick<KubernetesUsageClient, 'getNamespaceUsage' | 'getPodUsage'>;
  /** Per-client budgets; defaults to DEFAULT_LIMITS. Tests lower them. */
  rateLimits?: RateLimits;
}

type NamespaceAccess = { ok: true } | { ok: false; status: number; error: string };

export function createRouter(opts: RouterOptions): Router {
  const { logger, httpAuth, userInfo, db, isPostgres, k8sClient } = opts;
  const router = Router();
  const limit = createRateLimiters(opts.rateLimits);

  // The k8s client reads with the backend's own cluster-wide credentials, so
  // the namespace in the URL must belong to the caller: a member of the
  // tenant of the same name (any role), or a platform admin. Only user
  // credentials are accepted; no backend plugin calls these routes.
  async function authorizeNamespace(req: Request, ns: string): Promise<NamespaceAccess> {
    let userId: string | undefined;
    try {
      const credentials = await httpAuth.credentials(req, { allow: ['user'] });
      const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
      userId = ownershipEntityRefs
        .find(r => r.startsWith('user:default/'))
        ?.split('/')
        .pop();
    } catch {
      return { ok: false, status: 401, error: 'Authentication required' };
    }
    if (!userId) {
      return { ok: false, status: 401, error: 'Authentication required' };
    }
    if (await isAdminUser(db, isPostgres, userId)) {
      return { ok: true };
    }
    if (await getTenantMember(db, isPostgres, ns, userId.toLowerCase())) {
      return { ok: true };
    }
    return { ok: false, status: 403, error: `Access denied: not a member of team '${ns}'` };
  }

  // ── GET /health ───────────────────────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // ── GET /namespaces/:ns/usage ─────────────────────────────────────────────
  // Returns aggregated quota + live usage for a namespace.
  // Requires a user who belongs to the namespace's tenant, or a platform admin.
  router.get('/namespaces/:ns/usage', limit.read, async (req: Request, res: Response) => {
    const { ns } = req.params;
    try {
      const access = await authorizeNamespace(req, ns);
      if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
      }
      const usage = await k8sClient.getNamespaceUsage(ns);
      res.json(usage);
    } catch (err: any) {
      logger.error(`[resource-usage] GET /namespaces/${ns}/usage error: ${err}`);
      res.status(500).json({ error: String(err?.message ?? 'Internal error') });
    }
  });

  // ── GET /namespaces/:ns/pods ──────────────────────────────────────────────
  // Returns per-pod CPU/memory usage from metrics-server.
  router.get('/namespaces/:ns/pods', limit.read, async (req: Request, res: Response) => {
    const { ns } = req.params;
    try {
      const access = await authorizeNamespace(req, ns);
      if (!access.ok) {
        res.status(access.status).json({ error: access.error });
        return;
      }
      const pods = await k8sClient.getPodUsage(ns);
      res.json({ pods });
    } catch (err: any) {
      logger.error(`[resource-usage] GET /namespaces/${ns}/pods error: ${err}`);
      res.status(500).json({ error: String(err?.message ?? 'Internal error') });
    }
  });

  return router;
}
