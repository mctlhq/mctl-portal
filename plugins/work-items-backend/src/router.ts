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
/** mctl-api execution ids are `we_<uuid>` (contract "ID scheme"). */
const EXECUTION_ID = /^we_[A-Za-z0-9-]{1,64}$/;
/**
 * The key ends up in the Idempotency-Key header and in mctl-api's per-item key
 * space, so it is bounded and header-safe (no CR/LF). The UI sends
 * `portal-<uuid>`.
 */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * mctl-api's bound on a portal external id (`externalIDPattern[SurfacePortal]`
 * in mctl-api internal/surfaceid/store.go). An `X-MCTL-Surface-Actor` that does
 * not match is answered 400 `invalid_request` by every relay route and by
 * redeem, so the portal must never send one.
 */
export const MCTL_API_PORTAL_EXTERNAL_ID = /^[A-Za-z0-9._:@|-]{1,256}$/;

// Backstage's isValidObjectName (@backstage/catalog-model
// KubernetesValidatorFunctions), applied after lowercasing: 1-63 characters,
// first and last alphanumeric, `-`, `_` and `.` anywhere in between (repeats
// allowed). It is used for both parts: for names it is exactly Backstage's
// rule, and for namespaces it is a superset of Backstage's default (a DNS
// label) that also admits a custom namespace validator's `_`/`.`. Neither
// part can contain ':' or '/', which is what makes the encoding injective.
const ENTITY_PART = /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/;

/**
 * Derive the portal external id sent as `X-MCTL-Surface-Actor` from a Backstage
 * user entity ref: `user:<namespace>/<name>` becomes `user:<namespace>:<name>`,
 * lowercased. See CONTRACT.md "Actor id".
 *
 * - Only `user` refs are accepted; anything else is refused (undefined).
 * - Lowercasing matches Backstage, which compares entity refs
 *   case-insensitively, so `user:default/Alice` and `user:default/alice` are
 *   one user there and one id here.
 * - Namespace and name are checked against Backstage's object-name grammar
 *   (ENTITY_PART), which forbids ':' and '/'. The id therefore splits back into exactly one
 *   (namespace, name) pair, so two different users can never share an id.
 *   A ref outside that grammar is refused rather than escaped.
 * - The result only uses [a-z0-9._:-] and is at most 132 characters, inside
 *   mctl-api's pattern. It is also checked against that pattern here.
 *
 * Changing this rule orphans every existing SurfaceIdentityLink, so it is part
 * of the pinned contract.
 */
export function toSurfaceActorId(userEntityRef: string): string | undefined {
  const m = /^([^:/]+):([^:/]+)\/([^:/]+)$/.exec(userEntityRef.toLowerCase());
  if (!m) return undefined;
  const [, kind, namespace, name] = m;
  if (kind !== 'user') return undefined;
  if (!ENTITY_PART.test(namespace) || !ENTITY_PART.test(name)) return undefined;
  const id = `user:${namespace}:${name}`;
  return MCTL_API_PORTAL_EXTERNAL_ID.test(id) ? id : undefined;
}

/**
 * Resolve the caller from a Backstage USER credential only (service
 * credentials are refused). The actor sent upstream as X-MCTL-Surface-Actor is
 * derived from the stable user entity ref by toSurfaceActorId. mctl-api
 * resolves it through a verified SurfaceIdentityLink; being a portal admin
 * grants nothing extra here.
 */
export async function resolveCallerId(
  req: Request,
  httpAuth: HttpAuthService,
  userInfo: UserInfoService,
  logger?: LoggerService,
): Promise<CallerId> {
  try {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { userEntityRef } = await userInfo.getUserInfo(credentials);
    const actor = userEntityRef ? toSurfaceActorId(userEntityRef) : undefined;
    if (!actor) {
      // An entity ref is a catalog identifier, not a secret; naming it is what
      // makes a refused user diagnosable.
      logger?.warn(
        `work-items: user entity ref ${JSON.stringify(userEntityRef ?? null)} is not representable as a surface actor id`,
      );
      return { status: 401, error: 'Authentication required' };
    }
    return { actor };
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
  // Anything that is not a contract-pinned upstream answer (for example a
  // relay-allowlist violation, which is a bug in this plugin) is logged here
  // and reaches the browser only as a generic 502.
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
    const caller = await resolveCallerId(req, httpAuth, userInfo, logger);
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
    const caller = await resolveCallerId(req, httpAuth, userInfo, logger);
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
    const caller = await resolveCallerId(req, httpAuth, userInfo, logger);
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
    if (
      (b.idempotencyKey !== undefined &&
        (typeof b.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(b.idempotencyKey))) ||
      (b.resumedFromExecutionId !== undefined &&
        (typeof b.resumedFromExecutionId !== 'string' || !EXECUTION_ID.test(b.resumedFromExecutionId)))
    ) {
      res.status(400).json({ error: 'idempotencyKey or resumedFromExecutionId is malformed' });
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
