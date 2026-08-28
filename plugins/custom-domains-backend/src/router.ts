import { Router, json, Request, Response } from 'express';
import { HttpAuthService, LoggerService, UserInfoService } from '@backstage/backend-plugin-api';
import type { Knex } from 'knex';
import { CustomDomainStore } from './store';
import { getTenantMember, isAdminUser } from '../../tenant-backend/src/membershipLookup';
import * as crypto from 'crypto';
import { resolve as dnsResolve } from 'dns';
import { promisify } from 'util';

const resolveCname = promisify(dnsResolve);

export interface RouterOptions {
  logger: LoggerService;
  store: CustomDomainStore;
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
 * ingress-update workflow (wft-add-custom-domain.yaml), which calls
 * GET /domains and POST /domains/:id/activate without a Backstage user
 * session. The workflow authenticates with the Backstage external-access
 * static token (backend.auth.externalAccess, subject mctl-api, restricted
 * to the custom-domains plugin).
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

// Validate domain is a proper FQDN and not a platform domain
function isValidCustomDomain(domain: string): boolean {
  const fqdnRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;
  if (!fqdnRegex.test(domain)) return false;
  // Reject platform domains — those are auto-generated
  if (domain.endsWith('.mctl.ai') || domain.endsWith('.mctl.me')) return false;
  return true;
}

// DNS verification: check if domain has CNAME pointing to expected target
async function verifyDns(
  domain: string,
  expectedTarget: string,
): Promise<{ ok: boolean; actual: string | null; error?: string }> {
  try {
    const addresses = await resolveCname(domain);
    if (!addresses || addresses.length === 0) {
      return { ok: false, actual: null, error: 'No DNS records found' };
    }
    // CNAME should resolve to the expected auto-domain
    const normalized = addresses.map((a: string) => a.replace(/\.$/, '').toLowerCase());
    const target = expectedTarget.toLowerCase();
    const match = normalized.some((a: string) => a === target || a.endsWith('.' + target));
    return {
      ok: match,
      actual: normalized.join(', '),
      error: match ? undefined : `CNAME points to ${normalized.join(', ')}, expected ${target}`,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, actual: null, error: `DNS lookup failed: ${message}` };
  }
}

export function createRouter(options: RouterOptions): Router {
  const { logger, store, httpAuth, userInfo, db, isPostgres } = options;
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
      const domains = await store.list(team, service as string | undefined);
      res.json({ domains });
    } catch (err) {
      logger.error(`Failed to list domains: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // POST /domains — register a new custom domain
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
    if (!isValidCustomDomain(domain)) {
      res.status(400).json({
        error: 'Invalid domain. Must be a valid FQDN and not a *.mctl.ai or *.mctl.me domain.',
      });
      return;
    }

    // Check uniqueness
    const existing = await store.getByDomain(domain);
    if (existing) {
      res.status(409).json({
        error: `Domain ${domain} is already registered for ${existing.team}/${existing.service}`,
      });
      return;
    }

    const id = crypto.randomUUID();
    const autoDomain = `${team}-${service}.mctl.ai`;

    try {
      await store.create({
        id,
        team,
        service,
        domain,
        auto_domain: autoDomain,
        status: 'pending',
        verified_at: null,
        // Forced to the authenticated caller rather than trusting the
        // request body, closing a related IDOR-adjacent spoofing gap
        // flagged during proposal review.
        created_by: caller.userId,
      });
      logger.info(`Custom domain registered: ${domain} → ${autoDomain}`);
      res.status(201).json({
        id,
        domain,
        auto_domain: autoDomain,
        status: 'pending',
        cname_target: autoDomain,
        instructions: `Create a CNAME record: ${domain} → ${autoDomain}`,
      });
    } catch (err) {
      logger.error(`Failed to register domain: ${err}`);
      res.status(500).json({ error: 'Failed to register domain' });
    }
  });

  // POST /domains/:id/verify — check DNS and update status
  router.post('/domains/:id/verify', async (req: Request, res: Response) => {
    const { id } = req.params;
    const caller = await resolveCallerId(req, httpAuth, userInfo);
    if ('status' in caller) {
      res.status(caller.status).json({ error: caller.error });
      return;
    }
    const entry = await store.getById(id);
    if (!entry) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }
    const auth = await authorizeForTeam(db, isPostgres, caller.userId, entry.team);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    const result = await verifyDns(entry.domain, entry.auto_domain);
    if (result.ok) {
      await store.updateStatus(id, 'verified', new Date().toISOString());
      logger.info(`Domain verified: ${entry.domain} → ${entry.auto_domain}`);
      res.json({ status: 'verified', domain: entry.domain, cname: result.actual });
    } else {
      await store.updateStatus(id, 'pending');
      res.json({
        status: 'pending',
        domain: entry.domain,
        error: result.error,
        expected_cname: entry.auto_domain,
        actual_cname: result.actual,
      });
    }
  });

  // POST /domains/:id/activate — mark as active (called by workflow after ingress update)
  router.post('/domains/:id/activate', async (req: Request, res: Response) => {
    const { id } = req.params;
    const isWorkflow = await isWorkflowCaller(req, httpAuth);
    let callerId: string | undefined;
    if (!isWorkflow) {
      const caller = await resolveCallerId(req, httpAuth, userInfo);
      if ('status' in caller) {
        res.status(caller.status).json({ error: caller.error });
        return;
      }
      callerId = caller.userId;
    }
    const entry = await store.getById(id);
    if (!entry) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }
    if (!isWorkflow) {
      const auth = await authorizeForTeam(db, isPostgres, callerId as string, entry.team);
      if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error });
        return;
      }
    }
    await store.updateStatus(id, 'active');
    logger.info(`Domain activated: ${entry.domain}`);
    res.json({ status: 'active', domain: entry.domain });
  });

  // DELETE /domains/:id — remove a custom domain
  router.delete('/domains/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const caller = await resolveCallerId(req, httpAuth, userInfo);
    if ('status' in caller) {
      res.status(caller.status).json({ error: caller.error });
      return;
    }
    const entry = await store.getById(id);
    if (!entry) {
      res.status(404).json({ error: 'Domain not found' });
      return;
    }
    const auth = await authorizeForTeam(db, isPostgres, caller.userId, entry.team);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    await store.delete(id);
    logger.info(`Domain deleted: ${entry.domain}`);
    res.json({ deleted: true, domain: entry.domain });
  });

  // GET /health
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  return router;
}
