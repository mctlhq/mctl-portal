import { Router, json, Request, Response } from 'express';
import { HttpAuthService, LoggerService, UserInfoService } from '@backstage/backend-plugin-api';
import type { Knex } from 'knex';
import { DomainsClient, MctlApiError } from './mctlApiClient';
import { getTenantMember, isAdminUser } from '../../tenant-backend/src/membershipLookup';

export interface RouterOptions {
  logger: LoggerService;
  domains: DomainsClient;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  db: Knex;
  isPostgres: boolean;
}

type CallerId = { userId: string } | { status: 401; error: string };

type TeamAuthResult = { ok: true } | { ok: false; status: 403; error: string };

/** Extract GitHub username from ownershipEntityRefs (user:default/{username}) */
function extractUserId(ownershipEntityRefs: string[]): string | undefined {
  const ref = ownershipEntityRefs.find(r => r.startsWith('user:default/'));
  return ref?.split('/').pop();
}

/**
 * Resolve the authenticated caller's userId from a Backstage user credential.
 * Returns a 401 result (not a thrown error) when no valid user credential is
 * present, so callers can respond consistently without a try/catch.
 */
export async function resolveCallerId(
  req: Request,
  httpAuth: HttpAuthService,
  userInfo: UserInfoService,
): Promise<CallerId> {
  try {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
    const userId = extractUserId(ownershipEntityRefs);
    if (!userId) {
      return { status: 401, error: 'Authentication required' };
    }
    return { userId };
  } catch {
    return { status: 401, error: 'Authentication required' };
  }
}

/**
 * Authorize userId against team: platform admins (owner role in the 'admins'
 * tenant) bypass membership, mirroring vault-secrets-backend's
 * checkTenantRole. No role tiering — any tenant role authorizes.
 */
export async function authorizeForTeam(
  db: Knex,
  isPostgres: boolean,
  userId: string,
  team: string,
): Promise<TeamAuthResult> {
  if (await isAdminUser(db, isPostgres, userId)) {
    return { ok: true };
  }
  const member = await getTenantMember(db, isPostgres, team, userId.toLowerCase());
  if (!member) {
    return { ok: false, status: 403, error: `Access denied: not a member of team '${team}'` };
  }
  return { ok: true };
}

/**
 * Tier accepted in addition to tenant membership/admin for the Argo
 * ingress-update workflow (wft-add-custom-domain.yaml), which historically
 * called GET /domains and POST /domains/:id/activate without a Backstage
 * user session. The workflow authenticates with the Backstage external-access
 * static token (backend.auth.externalAccess, subject mctl-api, restricted
 * to the custom-domains plugin).
 *
 * Verified against mctl-gitops main at the time of this change: nothing in
 * wft-add-custom-domain.yaml calls this plugin any more (mctl-gitops#1085
 * repointed it at mctl-api directly), so this tier now only matters for
 * GET /domains — /activate itself always answers 410 regardless of caller
 * tier (see below). Left in place rather than removed with the rest of the
 * cleanup so a change on either side degrades to a diagnosable 410/403
 * instead of a routing 404.
 *
 * The subject allowlist below is load-bearing: accessRestrictions only
 * scope the *external* static token, so a bare `allow: ['service']` check
 * would also admit every other backend plugin's plugin-to-plugin
 * credential (subject `plugin:<id>`) and silently bypass authorizeForTeam.
 * Only the workflow's external identity may take this tier. Both the
 * `external:`-prefixed form (current Backstage principal shape for
 * external access) and the bare configured subject are accepted so a
 * framework change in prefixing degrades to the same identity, never to
 * plugin-to-plugin access.
 */
const WORKFLOW_CALLER_SUBJECTS = new Set(['external:mctl-api', 'mctl-api']);

export async function isWorkflowCaller(req: Request, httpAuth: HttpAuthService): Promise<boolean> {
  try {
    const credentials = await httpAuth.credentials(req, { allow: ['service'] });
    const principal = credentials.principal as { subject?: string };
    return WORKFLOW_CALLER_SUBJECTS.has(principal?.subject ?? '');
  } catch {
    return false;
  }
}

/**
 * Maps an error from the DomainsClient onto an HTTP response. A MctlApiError
 * already carries the status the caller should see (upstream status for a
 * 4xx, 502 for anything else — see MctlApiError's own doc comment); any
 * other thrown value is an unexpected local failure and also becomes a 502,
 * never a 200, so an upstream outage or a bug here can't silently look like
 * an empty-but-successful response.
 */
function respondToDomainsError(res: Response, logger: LoggerService, context: string, err: unknown): void {
  if (err instanceof MctlApiError) {
    logger.error(`${context}: ${err.message}`);
    res.status(err.status).json({ error: err.message });
    return;
  }
  logger.error(`${context}: ${err}`);
  res.status(502).json({ error: 'Upstream domains registry unavailable' });
}

/**
 * Confirms `id` actually belongs to `team` before verify/delete are allowed
 * to proceed. This plugin's bearer token is a platform-wide mctl-api service
 * credential that clears mctl-api's own admin bypass regardless of team (see
 * MctlApiDomainsClient's doc comment), so mctl-api's `?team=` check on the
 * verify/delete routes cannot be relied on to reject a mismatched id — it
 * never even runs for this caller. Without this check, authorizeForTeam only
 * proves the caller belongs to the team *they named*, not that they may
 * touch the specific `id` in the URL: a member of team-a could otherwise
 * verify or delete team-b's domain by passing `?team=team-a` alongside
 * team-b's id. Listing the caller's own team's domains and requiring the id
 * to appear in that list restores the ownership check store.getById used to
 * provide before this plugin lost its local table.
 */
async function domainBelongsToTeam(domains: DomainsClient, id: string, team: string): Promise<boolean> {
  const rows = await domains.list(team);
  return rows.some(d => d.id === id);
}

export function createRouter(options: RouterOptions): Router {
  const { logger, domains, httpAuth, userInfo, db, isPostgres } = options;
  const router = Router();
  router.use(json());

  // GET /domains?team=X&service=Y (service is optional)
  router.get('/domains', async (req: Request, res: Response) => {
    const { team, service } = req.query;
    if (!team || typeof team !== 'string') {
      res.status(400).json({ error: 'Missing required param: team' });
      return;
    }
    if (!(await isWorkflowCaller(req, httpAuth))) {
      const caller = await resolveCallerId(req, httpAuth, userInfo);
      if ('status' in caller) {
        res.status(caller.status).json({ error: caller.error });
        return;
      }
      const auth = await authorizeForTeam(db, isPostgres, caller.userId, team);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
    }
    try {
      const list = await domains.list(team, service as string | undefined);
      res.json({ domains: list });
    } catch (err) {
      respondToDomainsError(res, logger, `Failed to list domains for team '${team}'`, err);
    }
  });

  // POST /domains — register a new custom domain via mctl-api's registry
  router.post('/domains', async (req: Request, res: Response) => {
    const { team, service, domain } = req.body;
    if (!team || !service || !domain) {
      res.status(400).json({ error: 'Missing required fields: team, service, domain' });
      return;
    }
    const caller = await resolveCallerId(req, httpAuth, userInfo);
    if ('status' in caller) {
      res.status(caller.status).json({ error: caller.error });
      return;
    }
    const auth = await authorizeForTeam(db, isPostgres, caller.userId, team);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    // Domain syntax validation, platform-domain rejection, and uniqueness
    // are no longer checked here — mctl-api's AddDomain now owns all three
    // (validateHostname, isPlatformDomain, the store's conflict check).
    try {
      const created = await domains.create({ team, service, domain, actor: caller.userId });
      logger.info(
        `Custom domain registered via mctl-api: ${domain} (team=${team}, service=${service}, actor=${caller.userId})`,
      );
      res.status(201).json(created);
    } catch (err) {
      respondToDomainsError(res, logger, `Failed to register domain '${domain}'`, err);
    }
  });

  // POST /domains/:id/verify?team=X — trigger TXT/CNAME verification
  router.post('/domains/:id/verify', async (req: Request, res: Response) => {
    const { id } = req.params;
    const { team } = req.query;
    if (!team || typeof team !== 'string') {
      res.status(400).json({ error: 'Missing required param: team' });
      return;
    }
    const caller = await resolveCallerId(req, httpAuth, userInfo);
    if ('status' in caller) {
      res.status(caller.status).json({ error: caller.error });
      return;
    }
    const auth = await authorizeForTeam(db, isPostgres, caller.userId, team);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    if (!(await domainBelongsToTeam(domains, id, team))) {
      res.status(404).json({ error: 'domain not found' });
      return;
    }
    try {
      const result = await domains.verify(id, team);
      res.json(result);
    } catch (err) {
      respondToDomainsError(res, logger, `Failed to verify domain '${id}'`, err);
    }
  });

  // POST /domains/:id/activate — retired. mctl-api now activates a domain
  // itself once its own remove/add-custom-domain workflow finishes updating
  // ingress and TLS (PATCH /api/v1/domains/{id}, restricted to its service
  // principal); this plugin has no store to flip a status on any more.
  // Verified (not assumed) against mctl-gitops main at the time of this
  // change: platform-gitops/argo-workflows/cluster-templates/wft-add-custom-domain.yaml
  // no longer references this plugin or a Backstage `/activate` call
  // anywhere — mctl-gitops#1085 repointed it at mctl-api's PATCH endpoint
  // directly. The route stays registered (rather than 404ing, which would
  // look like a routing bug) but calls no client method and requires no
  // auth tier — it has nothing left to authorize.
  router.post('/domains/:id/activate', (_req: Request, res: Response) => {
    res.status(410).json({
      error:
        'This route is retired: mctl-api is now the system of record for custom domains and ' +
        'owns activation directly. See mctlhq/mctl-api internal/api/handlers_domains.go (UpdateDomainStatus).',
    });
  });

  // DELETE /domains/:id?team=X — remove a custom domain
  router.delete('/domains/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const { team } = req.query;
    if (!team || typeof team !== 'string') {
      res.status(400).json({ error: 'Missing required param: team' });
      return;
    }
    const caller = await resolveCallerId(req, httpAuth, userInfo);
    if ('status' in caller) {
      res.status(caller.status).json({ error: caller.error });
      return;
    }
    const auth = await authorizeForTeam(db, isPostgres, caller.userId, team);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    if (!(await domainBelongsToTeam(domains, id, team))) {
      res.status(404).json({ error: 'domain not found' });
      return;
    }
    try {
      const result = await domains.remove(id, team);
      logger.info(`Domain deleted via mctl-api: ${id} (team=${team}, actor=${caller.userId})`);
      res.json(result);
    } catch (err) {
      respondToDomainsError(res, logger, `Failed to delete domain '${id}'`, err);
    }
  });

  // GET /health
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  return router;
}
