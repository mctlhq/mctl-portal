import { json, Request, Response, Router } from 'express';
import Router_ from 'express-promise-router';
import { HttpAuthService, LoggerService, UserInfoService } from '@backstage/backend-plugin-api';
import { MctlApiError, WorkItemsClient } from './mctlApiClient';

export interface RouterOptions {
  logger: LoggerService;
  workItems: WorkItemsClient;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  actionsEnabled: boolean;
}

type CallerId = { actor: string } | { status: 401; error: string };

const WORK_ITEM_ID = /^wi_[A-Za-z0-9-]{1,64}$/;

/**
 * Resolve the caller from a Backstage USER credential only (service
 * credentials are refused). The actor sent upstream as X-MCTL-Surface-Actor is
 * the stable user entity ref. mctl-api resolves it through a verified
 * SurfaceIdentityLink; being a portal admin grants nothing extra here.
 */
export async function resolveCallerId(
  req: Request,
  httpAuth: HttpAuthService,
  userInfo: UserInfoService,
): Promise<CallerId> {
  try {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { userEntityRef } = await userInfo.getUserInfo(credentials);
    if (!userEntityRef || userEntityRef.length > 256) {
      return { status: 401, error: 'Authentication required' };
    }
    return { actor: userEntityRef };
  } catch {
    return { status: 401, error: 'Authentication required' };
  }
}

function respondWithError(res: Response, err: unknown, logger: LoggerService): void {
  if (err instanceof MctlApiError) {
    res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }
  logger.error(`work-items request failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  res.status(502).json({ error: 'work items request failed' });
}

export function createRouter(options: RouterOptions): Router {
  const { logger, workItems, httpAuth, userInfo, actionsEnabled } = options;
  const router = Router_();
  router.use(json({ limit: '16kb' }));

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const requireConfigured = (res: Response): boolean => {
    if (!workItems.isConfigured()) {
      res.status(503).json({ error: 'work items are not configured', code: 'work_items_unconfigured' });
      return false;
    }
    return true;
  };

  router.get('/work-items/:id', async (req: Request, res: Response) => {
    const caller = await resolveCallerId(req, httpAuth, userInfo);
    if (!('actor' in caller)) {
      res.status(caller.status).json({ error: caller.error });
      return;
    }
    const id = req.params.id;
    if (!WORK_ITEM_ID.test(id)) {
      res.status(400).json({ error: 'invalid work item id' });
      return;
    }
    if (!requireConfigured(res)) return;
    try {
      res.json({ ...(await workItems.getWorkItem(id, caller.actor)), actionsEnabled });
    } catch (err) {
      respondWithError(res, err, logger);
    }
  });

  router.post('/surface-identities/redeem', async (req: Request, res: Response) => {
    const caller = await resolveCallerId(req, httpAuth, userInfo);
    if (!('actor' in caller)) {
      res.status(caller.status).json({ error: caller.error });
      return;
    }
    const code = req.body?.code;
    if (typeof code !== 'string' || code.length === 0 || code.length > 256) {
      res.status(400).json({ error: 'code is required' });
      return;
    }
    if (!requireConfigured(res)) return;
    try {
      await workItems.redeemIdentity(code, caller.actor);
      res.status(201).json({ status: 'linked' });
    } catch (err) {
      respondWithError(res, err, logger);
    }
  });

  // The only mutation the UI uses: ask the platform to start/resume a run.
  // There is no generic /actions route.
  router.post('/work-items/:id/execution-requests', async (req: Request, res: Response) => {
    const caller = await resolveCallerId(req, httpAuth, userInfo);
    if (!('actor' in caller)) {
      res.status(caller.status).json({ error: caller.error });
      return;
    }
    if (!actionsEnabled) {
      res.status(403).json({ error: 'actions are disabled', code: 'actions_disabled' });
      return;
    }
    const id = req.params.id;
    if (!WORK_ITEM_ID.test(id)) {
      res.status(400).json({ error: 'invalid work item id' });
      return;
    }
    const b = req.body ?? {};
    if (
      (b.kind !== 'start' && b.kind !== 'resume') ||
      !Number.isInteger(b.expectedStateVersion) ||
      b.expectedStateVersion < 0
    ) {
      res.status(400).json({ error: 'kind (start|resume) and expectedStateVersion are required' });
      return;
    }
    if (!requireConfigured(res)) return;
    try {
      const result = await workItems.createExecutionRequest(id, caller.actor, {
        kind: b.kind,
        expectedStateVersion: b.expectedStateVersion,
        resumedFromExecutionId:
          typeof b.resumedFromExecutionId === 'string' ? b.resumedFromExecutionId : undefined,
        intentId: Number.isInteger(b.intentId) ? b.intentId : undefined,
        idempotencyKey: typeof b.idempotencyKey === 'string' ? b.idempotencyKey : undefined,
      });
      res.status(result.replay ? 200 : 201).json({ executionRequest: result.executionRequest });
    } catch (err) {
      respondWithError(res, err, logger);
    }
  });

  return router;
}
