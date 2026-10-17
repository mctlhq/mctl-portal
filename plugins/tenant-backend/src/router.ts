import { CustomerDeletionConflictError } from './customerDeletionSchema';
import { Router, Request, Response, json } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  HttpAuthService,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { ArgoWorkflowsClient } from '@internal/plugin-argo-workflows-backend';
import {
  CustomerHasTenantError,
  TenantExistsError,
  TenantStore,
} from './tenantStore';
import {
  CreateTenantRequest,
  InviteMemberRequest,
  UpdateMemberRoleRequest,
} from './types';
import { dump as yamlDump } from 'js-yaml';
import { buildTenantCatalogEntities } from './catalogEntities';
import {
  CreatorPrincipalError,
  CreatorPrincipalResolver,
  isGitHubLogin,
} from './creatorPrincipal';
import { createRateLimiters, RateLimits } from './rateLimit';
import { CatalogKey, ROLES } from './memberKeys';
import {
  ZitadelCustomer,
  ZitadelCustomerError,
  ZitadelCustomerResolver,
} from './zitadelCustomer';
import { WorkspaceAccessReader } from './workspaceAccess';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  store: TenantStore;
  argoClient: ArgoWorkflowsClient;
  argoNamespace: string;
  getGithubToken: () => Promise<string>;
  /** Internal workflow cleanup; refuses until GitOps absence is observed. */
  cleanupDeletedTenant?: (name: string, principalId?: string, login?: string) => Promise<void>;
  /**
   * Shared secret for verifying landing-page JWT tokens (HMAC-SHA256).
   * The Cloudflare Worker signs a JWT with this secret; Backstage verifies it.
   * Also accepts the raw secret as a static Bearer token for backward compatibility.
   * Configure via: tenantManagement.landingPageToken / BACKSTAGE_LANDING_TOKEN env var.
   */
  landingPageToken?: string;
  /** Default resource quotas applied when creating a new tenant (from config). */
  defaultQuotas?: {
    cpuReq: string;
    cpuLim: string;
    memReq: string;
    memLim: string;
    pods: string;
    pvcs: string;
    services: string;
  };
  /** Maximum number of teams (Group entities) per tenant. Default: 1 */
  maxTeamsPerTenant?: number;
  /**
   * Resolves a creator's GitHub login to the canonical principal for the
   * owner entry (mctl-api#377). Unset, POST /tenants refuses any request that
   * names a creator: an owner without a principalId has no access once
   * mctl-api authorizes by principal.
   */
  resolveCreatorPrincipal?: CreatorPrincipalResolver;
  /**
   * Resolves a self-service customer's ZITADEL ID token to the principal
   * (stage C2). Unset, a landing request with creatorIdToken is refused.
   */
  resolveZitadelCustomer?: ZitadelCustomerResolver;
  /** Per-client budgets; defaults to DEFAULT_LIMITS. Tests lower them. */
  rateLimits?: RateLimits;
  readWorkspaceAccess?: WorkspaceAccessReader;
  workflowBaseUrl?: string;
}

/** A tenant name: the Kubernetes namespace it becomes. */
const TENANT_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;

type AuthResult =
  | {
      authorized: true;
      isAdmin: boolean;
      isLanding: boolean;
      callerInfo: string;
      userId: string | undefined;
    }
  | { authorized: false; reason: string };

/** Extract GitHub username from ownershipEntityRefs (user:default/{username}) */
function extractUserId(ownershipEntityRefs: string[]): string | undefined {
  const ref = ownershipEntityRefs.find(r => r.startsWith('user:default/'));
  return ref?.split('/').pop();
}

/**
 * Verify a JWT (HMAC-SHA256) signed with the landing-page secret.
 * Returns the decoded payload if valid, or undefined if invalid/expired.
 */
function verifyLandingJwt(
  token: string,
  secret: string,
): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;

  try {
    const sigInput = `${parts[0]}.${parts[1]}`;
    const expectedSig = createHmac('sha256', secret)
      .update(sigInput)
      .digest('base64url');

    // Timing-safe comparison to prevent timing attacks
    const sigBuf = Buffer.from(parts[2], 'base64url');
    const expectedBuf = Buffer.from(expectedSig, 'base64url');
    if (
      sigBuf.length !== expectedBuf.length ||
      !timingSafeEqual(sigBuf, expectedBuf)
    ) {
      return undefined;
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    );

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return undefined;
    }

    return payload;
  } catch {
    return undefined;
  }
}

/** Timing-safe comparison of a caller-supplied static token against the configured one. */
export function staticTokenEquals(
  provided: string | undefined,
  expected: string | undefined,
): boolean {
  if (!provided || !expected) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  return (
    providedBuf.length === expectedBuf.length &&
    timingSafeEqual(providedBuf, expectedBuf)
  );
}

/**
 * Resolve caller identity with three tiers:
 *   1. Landing-page JWT or static token (for Cloudflare Worker)
 *   2. Backstage user credentials (browser sessions)
 *   3. Backstage service credentials (plugin-to-plugin)
 *
 * isAdmin is only true when the user has `owner` role in the `admins` tenant (verified in DB).
 * The landing-page token is NOT admin: it may create a tenant and check a name, nothing else.
 * A Backstage service credential is authenticated but carries no user and no admin role:
 * no plugin calls these routes on its own behalf (scaffolder steps call on behalf of the
 * initiating user), so a service credential here can only be a confused deputy.
 *
 * Group membership in `group:default/admins` alone is not sufficient — a developer/viewer
 * member of the admins team must NOT receive admin privileges.
 */
async function resolveAuth(
  req: Request,
  httpAuth: HttpAuthService,
  userInfo: UserInfoService,
  landingPageToken: string | undefined,
  store: import('./tenantStore').TenantStore,
): Promise<AuthResult> {
  // ── Tier 1: landing-page token (JWT or static) ──────────────────────────────
  if (landingPageToken) {
    const authHeader = req.headers['authorization'];
    if (authHeader?.startsWith('Bearer ')) {
      const bearerValue = authHeader.slice(7);

      // Try JWT verification first (preferred)
      const jwtPayload = verifyLandingJwt(bearerValue, landingPageToken);
      if (jwtPayload) {
        return {
          authorized: true,
          isAdmin: false,
          isLanding: true,
          callerInfo: 'landing-page-jwt',
          userId: undefined,
        };
      }

      // Fallback: static token comparison (backward compatibility)
      if (staticTokenEquals(bearerValue, landingPageToken)) {
        return {
          authorized: true,
          isAdmin: false,
          isLanding: true,
          callerInfo: 'landing-page',
          userId: undefined,
        };
      }
    }
  }

  // ── Tier 2: Backstage user credentials ────────────────────────────────────
  try {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
    const userId = extractUserId(ownershipEntityRefs);

    // isAdmin requires owner role in admins tenant — always verified via DB, not catalog groups.
    // Catalog-based ownership may lag or reflect the wrong primary tenant for multi-tenant users.
    let isAdmin = false;
    if (userId) {
      const adminMembership = await store.getMemberByTenant('admins', userId);
      isAdmin = adminMembership?.role === 'owner';
    }

    return {
      authorized: true,
      isAdmin,
      isLanding: false,
      callerInfo: ownershipEntityRefs[0] ?? 'user',
      userId,
    };
  } catch {
    // not a user token — try next tier
  }

  // ── Tier 3: Backstage service credentials (plugin-to-plugin) ──────────────
  try {
    await httpAuth.credentials(req, { allow: ['service'] });
    return {
      authorized: true,
      isAdmin: false,
      isLanding: false,
      callerInfo: 'service',
      userId: undefined,
    };
  } catch {
    return { authorized: false, reason: 'No valid credentials' };
  }
}

export function createRouter(opts: RouterOptions): Router {
  const {
    logger,
    httpAuth,
    userInfo,
    store,
    argoClient,
    argoNamespace,
    landingPageToken,
    getGithubToken,
    defaultQuotas,
    resolveCreatorPrincipal,
    resolveZitadelCustomer,
    rateLimits,
  } = opts;
  const dq = defaultQuotas ?? {
    cpuReq: '1',
    cpuLim: '2',
    memReq: '2Gi',
    memLim: '3Gi',
    pods: '10',
    pvcs: '2',
    services: '5',
  };
  const workflowBaseUrl = (
    opts.workflowBaseUrl ?? 'https://workflows.mctl.ai'
  ).replace(/\/$/, '');
  const router = Router();
  const limit = createRateLimiters(rateLimits);
  router.use(json());

  router.post('/internal/tenants/:name/customer-deletion/:stage', limit.write, async (req, res) => {
    let allowed = false;
    try {
      const { principal } = await httpAuth.credentials(req, { allow: ['service'] });
      const subject = (principal as { subject?: string }).subject;
      allowed = principal.type === 'service' && subject === 'external:mctl-api';
    } catch { logger.warn('Customer lifecycle service credential rejected'); }
    if (!allowed) { res.status(403).json({ error: 'Workflow principal required' }); return; }
    const { name, stage } = req.params;
    const { principal_id: pid, login } = req.body ?? {};
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name) || name === 'admins' ||
        typeof pid !== 'string' || !/^prn_[0-9A-HJKMNP-TV-Z]{26}$/.test(pid) ||
        typeof login !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(login) ||
        !['prepare', 'release'].includes(stage)) {
      res.status(400).json({ error: 'Invalid customer deletion target' }); return;
    }
    try {
      if (stage === 'prepare') await store.freezeCustomerDeletion(name, pid, login);
      else await store.releaseCustomerDeletion(name, pid);
      res.json({ tenant: name, principal_id: pid, stage, complete: true });
    } catch (err) {
      logger.warn('Customer lifecycle stage failed', { stage, reason: err instanceof Error ? err.message : 'unknown' });
      res.status(err instanceof CustomerDeletionConflictError ? 409 : 503).json({ error: 'Customer lifecycle stage incomplete' });
    }
  });

  router.post('/internal/tenants/:name/cleanup', limit.write, async (req, res) => {
    let allowed = false;
    try {
      const credentials = await httpAuth.credentials(req, { allow: ['service'] });
      const subject = (credentials.principal as { subject?: string }).subject;
      allowed = credentials.principal.type === 'service' && subject === 'external:mctl-api';
    } catch { logger.warn('Tenant cleanup service credential rejected'); }
    if (!allowed) { res.status(403).json({ error: 'Workflow principal required' }); return; }
    const name = req.params.name;
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(name) ||
        ['admins', 'backstage', 'platform', 'zitadel'].includes(name)) {
      res.status(400).json({ error: 'Invalid or protected tenant' }); return;
    }
    if (!opts.cleanupDeletedTenant) {
      res.status(503).json({ error: 'Tenant cleanup is not configured' }); return;
    }
    try {
      const principalId = req.body?.principal_id;
      const login = req.body?.login;
      if ((principalId !== undefined || login !== undefined) && (typeof principalId !== 'string' || !/^prn_[0-9A-HJKMNP-TV-Z]{26}$/.test(principalId) ||
          typeof login !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(login))) {
        res.status(400).json({ error: 'Invalid customer identity' }); return;
      }
      await opts.cleanupDeletedTenant(name, principalId, login);
      res.json({ tenant: name, cleaned: true, scope: principalId ? 'customer' : 'workspace' });
    } catch (err) {
      logger.warn(`[TenantCleanup] Cleanup of ${name} is not complete`, { reason: err instanceof Error ? err.message : 'unknown' });
      res.status(503).json({ error: 'Tenant cleanup is incomplete; retry' });
    }
  });

  // Identity always comes from the authenticated Backstage user, never a
  // caller-supplied principal, tenant, login, or the landing-page credential.
  router.get(
    '/me/workspace-access',
    limit.read,
    async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      let observedUser = 'unresolved';
      let observedTenant = 'membership-list';
      try {
        const caller = await resolveAuth(
          req,
          httpAuth,
          userInfo,
          landingPageToken,
          store,
        );
        if (!caller.authorized || caller.isLanding || !caller.userId) {
          res
            .status(401)
            .json({ error: 'A signed-in portal user is required' });
          return;
        }
        observedUser = caller.userId;
        if (!opts.readWorkspaceAccess) {
          res.status(503).json({
            error: 'Workspace access could not be verified. Try again later.',
          });
          return;
        }
        const memberships = await store.listMembershipsForUser(caller.userId);
        const customers = memberships.filter(m => m.catalogKey === 'principal');
        const workspaces = [];
        for (const member of customers) {
          observedTenant = member.tenantName;
          workspaces.push(await opts.readWorkspaceAccess(member));
        }
        res.json({
          workspaces,
          legacyMembership: memberships.some(m => m.catalogKey !== 'principal'),
        });
      } catch (err) {
        logger.warn(
          '[WorkspaceAccess] Current access observation unavailable',
          {
            user: observedUser,
            tenant: observedTenant,
            reason: err instanceof Error ? err.message : 'unknown error',
          },
        );
        res.status(503).json({
          error: 'Workspace access could not be verified. Try again later.',
        });
      }
    },
  );

  /**
   * Look up a GitHub user by username. Returns user info or null if not found.
   * Throws on unexpected errors.
   */
  async function lookupGithubUser(
    username: string,
  ): Promise<{ login: string; name: string | null; avatarUrl: string } | null> {
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username)) {
      throw new Error('Invalid GitHub username');
    }
    const token = await getGithubToken();
    const res = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API error: HTTP ${res.status}`);
    const data = (await res.json()) as {
      login: string;
      name: string | null;
      avatar_url: string;
    };
    return { login: data.login, name: data.name, avatarUrl: data.avatar_url };
  }

  type Creator = {
    /** tenant_members.user_id / catalog name. */
    userId: string;
    login: string;
    principalId: string;
    catalogKey: CatalogKey;
  };
  type CreatorResult =
    | { creator?: Creator }
    | { status: number; body: Record<string, unknown> };

  /**
   * Who becomes the owner of a tenant being created, keyed by principal:
   * - landing page, creatorIdToken: a self-service customer, resolved by
   *   mctl-api from the site's ID token (purpose create) and keyed by
   *   principal in the catalog;
   * - landing page, creatorUserId: the legacy GitHub OAuth flow, by login;
   * - the portal (admins): only the caller themself, by the server-side
   *   identity; a body naming anyone else is refused.
   * Nothing named, no owner.
   */
  async function resolveCreator(
    body: CreateTenantRequest,
    auth: { isLanding: boolean; userId?: string },
  ): Promise<CreatorResult> {
    const named = (v: unknown) => v !== undefined && v !== '';
    if (named(body.creatorIdToken)) {
      if (!auth.isLanding) {
        return {
          status: 403,
          body: {
            error: 'creatorIdToken is accepted from the landing page only',
          },
        };
      }
      if (named(body.creatorUserId)) {
        return {
          status: 400,
          body: { error: 'creatorIdToken and creatorUserId are exclusive' },
        };
      }
      if (typeof body.creatorIdToken !== 'string') {
        return {
          status: 400,
          body: { error: 'creatorIdToken must be a string' },
        };
      }
      const customer = await resolveCustomer(body.creatorIdToken);
      if ('status' in customer) return customer;
      return {
        creator: {
          userId: customer.principalId.toLowerCase(),
          login: customer.githubLogin,
          principalId: customer.principalId,
          catalogKey: 'principal',
        },
      };
    }
    if (!named(body.creatorUserId)) return {};
    if (
      typeof body.creatorUserId !== 'string' ||
      !isGitHubLogin(body.creatorUserId)
    ) {
      return {
        status: 400,
        body: { error: 'creatorUserId must be a GitHub login' },
      };
    }
    if (!auth.isLanding && body.creatorUserId.toLowerCase() !== auth.userId) {
      return {
        status: 400,
        body: { error: 'creatorUserId must be the caller' },
      };
    }
    if (!resolveCreatorPrincipal) {
      logger.error(
        '[tenant-backend] creator principal resolution is not configured (workItems.baseUrl/surfaceToken)',
      );
      return {
        status: 503,
        body: { error: 'Tenant creation is unavailable right now' },
      };
    }
    try {
      const principalId = await resolveCreatorPrincipal(body.creatorUserId);
      return {
        creator: {
          userId: body.creatorUserId.toLowerCase(),
          login: body.creatorUserId,
          principalId,
          catalogKey: 'login',
        },
      };
    } catch (err) {
      if (err instanceof CreatorPrincipalError && err.status === 403) {
        return { status: 403, body: { error: err.message, code: err.code } };
      }
      logger.error(
        `[tenant-backend] creator principal for '${body.creatorUserId}' unresolved: ${err}`,
      );
      return {
        status: 503,
        body: { error: 'Tenant creation is unavailable right now' },
      };
    }
  }

  /** A customer by the site's ID token, or the answer to send instead. */
  async function resolveCustomer(
    idToken: string,
  ): Promise<
    ZitadelCustomer | { status: number; body: Record<string, unknown> }
  > {
    if (!resolveZitadelCustomer) {
      logger.error(
        '[tenant-backend] ZITADEL customer resolution is not configured (workItems.baseUrl/surfaceToken)',
      );
      return {
        status: 503,
        body: { error: 'Tenant creation is unavailable right now' },
      };
    }
    try {
      return await resolveZitadelCustomer(idToken, 'create');
    } catch (err) {
      if (err instanceof ZitadelCustomerError && err.kind === 'refused') {
        return {
          status: 403,
          body: {
            error: 'This account cannot create a workspace',
            code: err.code,
          },
        };
      }
      // The resolver logs what it models; anything else is a portal bug.
      if (!(err instanceof ZitadelCustomerError)) {
        logger.error(
          `[tenant-backend] ZITADEL customer resolution failed: ${err}`,
        );
      }
      return {
        status: 503,
        body: { error: 'Tenant creation is unavailable right now' },
      };
    }
  }

  // ── GET /health ───────────────────────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // ── GET /config ─────────────────────────────────────────────────────────
  router.get('/config', (_req: Request, res: Response) => {
    res.json({ maxTeamsPerTenant: opts.maxTeamsPerTenant ?? 1 });
  });

  // ── GET /check-user ───────────────────────────────────────────────────────
  // Look up a GitHub user. Used by the frontend to validate username before invite.
  // Requires authentication.
  router.get(
    '/check-user',
    limit.write,
    async (req: Request, res: Response) => {
      const auth = await resolveAuth(
        req,
        httpAuth,
        userInfo,
        landingPageToken,
        store,
      );
      if (!auth.authorized) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (auth.isLanding) {
        res.status(403).json({ error: 'Landing token cannot look up users' });
        return;
      }
      const { username } = req.query as { username?: string };
      if (!username || typeof username !== 'string' || !username.trim()) {
        res.status(400).json({ error: 'username query parameter is required' });
        return;
      }
      try {
        const user = await lookupGithubUser(username.trim().toLowerCase());
        if (!user) {
          res.json({ exists: false });
          return;
        }
        res.json({
          exists: true,
          login: user.login,
          name: user.name,
          avatarUrl: user.avatarUrl,
        });
      } catch (err: any) {
        logger.warn(`[tenant-backend] GET /check-user error: ${err}`);
        // On network/API errors, return unknown (don't block the UI)
        res.json({
          exists: null,
          error: String(err?.message ?? 'GitHub API unavailable'),
        });
      }
    },
  );

  // Returns all tenants. Requires authentication.
  router.get('/tenants', limit.read, async (req: Request, res: Response) => {
    const auth = await resolveAuth(
      req,
      httpAuth,
      userInfo,
      landingPageToken,
      store,
    );
    if (!auth.authorized) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (auth.isLanding) {
      res.status(403).json({ error: 'Landing token cannot list tenants' });
      return;
    }
    // The full list carries every tenant's contact email and quotas.
    if (!auth.isAdmin) {
      res.status(403).json({ error: 'Only admin users can list tenants' });
      return;
    }
    try {
      const tenants = await store.listAll();
      res.json({ tenants });
    } catch (err: any) {
      logger.error(`[tenant-backend] GET /tenants error: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── GET /tenants/:name ────────────────────────────────────────────────────
  // Returns a single tenant by name. Used by landing page to check availability.
  // Accessible with landing-page token (no Backstage session required).
  router.get(
    '/tenants/:name',
    limit.read,
    async (req: Request, res: Response) => {
      const { name } = req.params;
      const auth = await resolveAuth(
        req,
        httpAuth,
        userInfo,
        landingPageToken,
        store,
      );
      if (!auth.authorized) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      try {
        const tenant = await store.findByName(name);
        if (!tenant) {
          res.status(404).json({ error: `Tenant '${name}' not found` });
          return;
        }
        // Landing page and the tenant-name field only need existence for
        // name-availability checks; full details are for members and admins.
        const isMember =
          !!auth.userId &&
          !!(await store.getMemberByTenant(tenant.name, auth.userId));
        if (!auth.isAdmin && !isMember) {
          res.json({ tenant: { name: tenant.name } });
          return;
        }
        res.json({ tenant });
      } catch (err: any) {
        logger.error(`[tenant-backend] GET /tenants/${name} error: ${err}`);
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  // ── POST /tenants/availability ──────────────────────────────────────────
  // The landing page's name check for a self-service customer (stage C2):
  // body {name, creatorIdToken}. The token is resolved first (purpose
  // create), so a refused or disabled account hears so before it picks a
  // name; then the name, and whether the customer already has a workspace.
  // The read budget, as for GET /tenants/:name: the site calls it while the
  // customer types, and a shared write bucket would starve POST /tenants.
  router.post(
    '/tenants/availability',
    limit.read,
    async (req: Request, res: Response) => {
      const auth = await resolveAuth(
        req,
        httpAuth,
        userInfo,
        landingPageToken,
        store,
      );
      if (!auth.authorized) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (!auth.isLanding) {
        res
          .status(403)
          .json({ error: 'Only the landing page checks availability' });
        return;
      }
      const { name, creatorIdToken } = (req.body ?? {}) as {
        name?: unknown;
        creatorIdToken?: unknown;
      };
      if (typeof name !== 'string' || !TENANT_NAME.test(name)) {
        res
          .status(400)
          .json({ error: `name must match ${TENANT_NAME.source}` });
        return;
      }
      if (typeof creatorIdToken !== 'string' || !creatorIdToken) {
        res.status(400).json({ error: 'creatorIdToken is required' });
        return;
      }
      try {
        const customer = await resolveCustomer(creatorIdToken);
        if ('status' in customer) {
          res.status(customer.status).json(customer.body);
          return;
        }
        if (await store.getMemberTenant(customer.principalId.toLowerCase())) {
          res.json({ name, available: false, reason: 'creator_has_tenant' });
          return;
        }
        if (await store.isTenantDeleting?.(name) || await store.findByName(name)) {
          res.json({ name, available: false, reason: 'name_taken' });
          return;
        }
        res.json({ name, available: true });
      } catch (err: any) {
        logger.error(
          `[tenant-backend] POST /tenants/availability error: ${err}`,
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  // ── POST /tenants ─────────────────────────────────────────────────────────
  // Creates a new tenant via wft-create-tenant Argo WorkflowTemplate.
  // Requires: admin user, service token, or landing-page token (JWT/static).
  router.post('/tenants', limit.write, async (req: Request, res: Response) => {
    const auth = await resolveAuth(
      req,
      httpAuth,
      userInfo,
      landingPageToken,
      store,
    );

    if (!auth.authorized) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!auth.isAdmin && !auth.isLanding) {
      res.status(403).json({ error: 'Only admin users can create tenants' });
      return;
    }

    try {
      const body: CreateTenantRequest = req.body;

      // Basic validation
      if (!body.tenantName) {
        res.status(400).json({ error: 'tenantName is required' });
        return;
      }
      if (!body.displayName) {
        res.status(400).json({ error: 'displayName is required' });
        return;
      }
      if (!TENANT_NAME.test(body.tenantName)) {
        res.status(400).json({
          error: `tenantName must match ${TENANT_NAME.source}`,
        });
        return;
      }

      // Check if tenant already exists in DB cache
      const existing = await store.findByName(body.tenantName);
      if (existing) {
        res.status(409).json({
          error: `Tenant '${body.tenantName}' already exists`,
          code: 'name_taken',
        });
        return;
      }

      if (await store.isTenantDeleting?.(body.tenantName)) {
        res.status(409).json({ error: 'Workspace deletion is in progress', code: 'name_taken' }); return;
      }

      // The owner entry is keyed by principal (mctl-api#377). Resolve it
      // before anything is written; without it, refuse rather than create a
      // tenant whose owner cannot reach it.
      const resolved = await resolveCreator(body, auth);
      if ('status' in resolved) {
        res.status(resolved.status).json(resolved.body);
        return;
      }
      const { creator } = resolved;

      if (
        creator?.catalogKey === 'principal' &&
        (typeof body.contactEmail !== 'string' ||
          body.contactEmail.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.contactEmail))
      ) {
        res
          .status(400)
          .json({ error: 'A valid customer contact email is required' });
        return;
      }

      logger.info(
        `[tenant-backend] Creating tenant '${body.tenantName}' requested by ${auth.callerInfo}`,
      );

      // Write to DB immediately so the tenant is visible in Backstage catalog
      // without waiting for TenantSync (which polls git every 5 min).
      const tenantRecord = {
        name: body.tenantName,
        displayName: body.displayName,
        description: body.description ?? '',
        contactEmail: body.contactEmail ?? '',
        quotas: {
          'requests.cpu': body.quotaCpuReq ?? dq.cpuReq,
          'requests.memory': body.quotaMemoryReq ?? dq.memReq,
          'limits.cpu': body.quotaCpuLim ?? dq.cpuLim,
          'limits.memory': body.quotaMemoryLim ?? dq.memLim,
          pods: body.quotaPods ?? dq.pods,
          persistentvolumeclaims: dq.pvcs,
          services: dq.services,
        },
        networking: {
          allowIntraNamespace: true,
          allowClusterEgress: true,
          allowInternetEgress: body.allowInternetEgress ?? false,
        },
        syncedAt: new Date().toISOString(),
      };
      const customer =
        creator?.catalogKey === 'principal' ? creator : undefined;
      if (customer) {
        // One workspace per customer, held by the store: the tenant and its
        // owner are written together, so a concurrent second request for the
        // same customer gets 409 and leaves nothing behind.
        try {
          await store.createCustomerTenant(tenantRecord, {
            tenantName: body.tenantName,
            userId: customer.userId,
            role: 'owner',
            invitedAt: new Date().toISOString(),
            invitedBy: 'system',
            catalogKey: 'principal',
            principalId: customer.principalId,
            login: customer.login,
          });
        } catch (err) {
          if (err instanceof CustomerHasTenantError) {
            res
              .status(409)
              .json({ error: err.message, code: 'creator_has_tenant' });
            return;
          }
          if (err instanceof TenantExistsError) {
            res.status(409).json({ error: err.message, code: 'name_taken' });
            return;
          }
          throw err;
        }
      } else {
        await store.upsert(tenantRecord);
      }
      logger.info(`[tenant-backend] Tenant '${body.tenantName}' written to DB`);

      // Submit Argo WorkflowTemplate (handles K8s namespace, Vault, ArgoCD RBAC)
      const workflowSpec: Parameters<ArgoWorkflowsClient['submitWorkflow']>[0] =
        {
          resourceKind: 'ClusterWorkflowTemplate',
          resourceName: 'create-tenant',
          namespace: argoNamespace,
          parameters: [
            `tenant_name=${body.tenantName}`,
            `display_name=${body.displayName}`,
            `description=${body.description ?? ''}`,
            // Preserve the workflow parameter contract without private data.
            'contact_email=',
            `quota_cpu_req=${body.quotaCpuReq ?? dq.cpuReq}`,
            `quota_cpu_lim=${body.quotaCpuLim ?? dq.cpuLim}`,
            `quota_memory_req=${body.quotaMemoryReq ?? dq.memReq}`,
            `quota_memory_lim=${body.quotaMemoryLim ?? dq.memLim}`,
            `quota_pods=${body.quotaPods ?? dq.pods}`,
            `allow_internet_egress=${
              body.allowInternetEgress ? 'true' : 'false'
            }`,
            `creator_user_id=${creator?.login ?? ''}`,
            `creator_principal_id=${creator?.principalId ?? ''}`,
            `creator_catalog_key=${creator?.catalogKey ?? 'login'}`,
          ],
          labels: { 'submitted-by': `backstage-${auth.callerInfo}` },
        };
      let workflowName: string;
      try {
        workflowName = await argoClient.submitWorkflow(workflowSpec);
      } catch (err) {
        // A customer's reservation without a workflow would hold their one
        // workspace forever; release it so they can try again.
        if (customer) {
          await store
            .delete(body.tenantName)
            .catch(e =>
              logger.error(
                `[tenant-backend] Could not release '${body.tenantName}' after a failed submit: ${e}`,
              ),
            );
        }
        throw err;
      }

      res.status(202).json({
        message: `Tenant creation workflow submitted`,
        workflowName,
        workflowUrl: `${workflowBaseUrl}/workflows/${argoNamespace}/${workflowName}`,
      });

      // Register a login-keyed creator as owner; TenantSync confirms it
      // from values.yaml once the workflow has committed it. A customer's
      // owner row was written with the tenant above.
      if (creator && !customer) {
        try {
          await store.addMember({
            tenantName: body.tenantName,
            userId: creator.userId,
            role: 'owner',
            invitedAt: new Date().toISOString(),
            invitedBy: 'system',
            catalogKey: creator.catalogKey,
            principalId: creator.principalId,
          });
          logger.info(
            `[tenant-backend] Registered creator '${creator.userId}' as owner of '${body.tenantName}'`,
          );
        } catch (memberErr: any) {
          // Non-fatal — log and continue
          logger.warn(
            `[tenant-backend] Could not register creator as owner: ${memberErr?.message}`,
          );
        }
      }
    } catch (err: any) {
      logger.error(`[tenant-backend] POST /tenants error: ${err}`);
      res.status(500).json({ error: String(err?.message ?? 'Internal error') });
    }
  });

  // ── DELETE /tenants/:name ──────────────────────────────────────────────────
  // Safely delete a tenant by submitting an orchestrated Argo workflow that
  // retires services first and then removes the tenant from GitOps/K8s/Vault.
  // DB cleanup is performed later by tenant sync once the tenant disappears from Git.
  // Admin-only.
  router.delete(
    '/tenants/:name',
    limit.write,
    async (req: Request, res: Response) => {
      try {
        const auth = await resolveAuth(
          req,
          httpAuth,
          userInfo,
          landingPageToken,
          store,
        );
        if (!auth.authorized) {
          res.status(401).json({ error: auth.reason });
          return;
        }
        if (!auth.isAdmin) {
          res.status(403).json({ error: 'Admin only' });
          return;
        }

        const { name } = req.params;

        // Protect reserved tenants
        const reserved = [
          'admins',
          'argocd',
          'argo-workflows',
          'kube-system',
          'default',
          'vault',
          'monitoring',
        ];
        if (reserved.includes(name)) {
          res.status(400).json({
            error: `Tenant '${name}' is protected and cannot be deleted`,
          });
          return;
        }

        const existing = await store.findByName(name);
        if (!existing) {
          res.status(404).json({ error: `Tenant '${name}' not found` });
          return;
        }

        // Submit Argo delete-tenant workflow. The workflow retires services first,
        // then removes the tenant from GitOps. DB cleanup happens later via tenant sync.
        const workflowName = await argoClient.submitWorkflow({
          resourceKind: 'ClusterWorkflowTemplate',
          resourceName: 'delete-tenant-safe',
          namespace: argoNamespace,
          parameters: [`tenant_name=${name}`],
          labels: { 'submitted-by': `backstage-${auth.callerInfo}` },
        });

        logger.info(
          `[tenant-backend] Safe delete workflow '${workflowName}' submitted for tenant '${name}'`,
        );

        res.status(202).json({
          message: `Tenant '${name}' deletion queued`,
          workflowName,
          workflowUrl: `${workflowBaseUrl}/workflows/${argoNamespace}/${workflowName}`,
        });
      } catch (err: any) {
        logger.error(
          `[tenant-backend] DELETE /tenants/${req.params.name} error: ${err}`,
        );
        res
          .status(500)
          .json({ error: String(err?.message ?? 'Internal error') });
      }
    },
  );

  // ── GET /me/tenant ────────────────────────────────────────────────────────
  // Returns the tenant and role for the currently authenticated user.
  router.get('/me/tenant', limit.read, async (req: Request, res: Response) => {
    const auth = await resolveAuth(
      req,
      httpAuth,
      userInfo,
      landingPageToken,
      store,
    );
    if (!auth.authorized) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!auth.userId) {
      res.status(200).json({ tenant: null });
      return;
    }
    try {
      const memberships = await store.listMembershipsForUser(auth.userId);
      if (!memberships.length) {
        res.status(200).json({ tenant: null });
        return;
      }
      // Primary: owner > developer > viewer, then alphabetical within the same role.
      const roleRank = (r: string) =>
        r === 'owner' ? 0 : r === 'developer' ? 1 : 2;
      const primary = memberships
        .slice()
        .sort(
          (a, b) =>
            roleRank(a.role) - roleRank(b.role) ||
            a.tenantName.localeCompare(b.tenantName),
        )[0];
      const tenant = await store.findByName(primary.tenantName);
      res.json({
        tenant,
        role: primary.role,
        tenants: memberships.map(m => ({
          tenantName: m.tenantName,
          role: m.role,
        })),
      });
    } catch (err: any) {
      logger.error(`[tenant-backend] GET /me/tenant error: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── GET /tenants/:name/members ────────────────────────────────────────────
  // List all members of a tenant. Requires auth (any member or admin).
  router.get(
    '/tenants/:name/members',
    limit.read,
    async (req: Request, res: Response) => {
      const { name } = req.params;
      const auth = await resolveAuth(
        req,
        httpAuth,
        userInfo,
        landingPageToken,
        store,
      );
      if (!auth.authorized) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      try {
        // Check access: admin or member of this tenant. Landing tokens have
        // neither, so they must not fall through to the member list.
        if (!auth.isAdmin) {
          if (!auth.userId) {
            res.status(403).json({ error: 'Access denied' });
            return;
          }
          const membership = await store.getMemberByTenant(name, auth.userId);
          if (!membership) {
            res.status(403).json({ error: 'Access denied' });
            return;
          }
        }
        const members = await store.listMembers(name);
        res.json({ members });
      } catch (err: any) {
        logger.error(
          `[tenant-backend] GET /tenants/${name}/members error: ${err}`,
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  // ── POST /tenants/:name/members ───────────────────────────────────────────
  // Invite a user to a tenant. Requires: tenant owner or admin.
  router.post(
    '/tenants/:name/members',
    limit.write,
    async (req: Request, res: Response) => {
      const { name } = req.params;
      const auth = await resolveAuth(
        req,
        httpAuth,
        userInfo,
        landingPageToken,
        store,
      );
      if (!auth.authorized) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      try {
        // Check access: admin or owner of this tenant
        if (!auth.isAdmin) {
          if (!auth.userId) {
            res.status(403).json({ error: 'Access denied' });
            return;
          }
          const membership = await store.getMemberByTenant(name, auth.userId);
          if (!membership || membership.role !== 'owner') {
            res
              .status(403)
              .json({ error: 'Only tenant owners can invite members' });
            return;
          }
        }

        const body: InviteMemberRequest = req.body;
        if (!body.userId || typeof body.userId !== 'string') {
          res.status(400).json({ error: 'userId is required' });
          return;
        }
        const userId = body.userId.toLowerCase().trim();
        // The shape TenantSync holds values.yaml members to (seedMemberOf): a
        // looser one would invite someone the next sync then skips.
        if (!isGitHubLogin(userId)) {
          res.status(400).json({ error: 'Invalid GitHub username format' });
          return;
        }
        const role = body.role ?? 'developer';
        if (!(ROLES as readonly string[]).includes(role)) {
          res
            .status(400)
            .json({ error: 'role must be owner, developer, or viewer' });
          return;
        }

        // Validate that the GitHub user actually exists
        try {
          const ghUser = await lookupGithubUser(userId);
          if (ghUser === null) {
            res
              .status(400)
              .json({ error: `GitHub user '${userId}' not found` });
            return;
          }
          // Use canonical casing from GitHub
          // (userId is already lowercased above, but GitHub login is canonical)
        } catch (ghErr: any) {
          // GitHub API unavailable — log and allow through (best-effort)
          logger.warn(
            `[tenant-backend] Could not verify GitHub user '${userId}' (allowing anyway): ${ghErr?.message}`,
          );
        }

        await store.addMember({
          tenantName: name,
          userId,
          role,
          invitedAt: new Date().toISOString(),
          invitedBy: auth.userId ?? auth.callerInfo,
        });

        logger.info(
          `[tenant-backend] User '${userId}' invited to tenant '${name}' as ${role} by ${
            auth.userId ?? auth.callerInfo
          }`,
        );
        res
          .status(201)
          .json({ message: `User '${userId}' invited as ${role}` });
      } catch (err: any) {
        logger.error(
          `[tenant-backend] POST /tenants/${name}/members error: ${err}`,
        );
        if (err?.message?.includes('already a member')) {
          res.status(409).json({ error: err.message });
          return;
        }
        res
          .status(500)
          .json({ error: String(err?.message ?? 'Internal error') });
      }
    },
  );

  // ── DELETE /tenants/:name/members/:userId ─────────────────────────────────
  // Remove a member from a tenant. Requires: tenant owner or admin.
  router.delete(
    '/tenants/:name/members/:userId',
    limit.write,
    async (req: Request, res: Response) => {
      const { name, userId } = req.params;
      const auth = await resolveAuth(
        req,
        httpAuth,
        userInfo,
        landingPageToken,
        store,
      );
      if (!auth.authorized) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      try {
        if (!auth.isAdmin) {
          if (!auth.userId) {
            res.status(403).json({ error: 'Access denied' });
            return;
          }
          const membership = await store.getMemberByTenant(name, auth.userId);
          if (!membership || membership.role !== 'owner') {
            res
              .status(403)
              .json({ error: 'Only tenant owners can remove members' });
            return;
          }
          // Owner can't remove themselves if they're the only owner
          if (userId === auth.userId) {
            const members = await store.listMembers(name);
            const owners = members.filter(m => m.role === 'owner');
            if (owners.length <= 1) {
              res
                .status(400)
                .json({ error: 'Cannot remove the only owner of a tenant' });
              return;
            }
          }
        }
        await store.removeMember(name, userId);
        logger.info(
          `[tenant-backend] User '${userId}' removed from tenant '${name}'`,
        );
        res.status(204).send();
      } catch (err: any) {
        logger.error(
          `[tenant-backend] DELETE /tenants/${name}/members/${userId} error: ${err}`,
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  // ── PUT /tenants/:name/members/:userId/role ────────────────────────────────
  // Change a member's role. Requires: tenant owner or admin.
  router.put(
    '/tenants/:name/members/:userId/role',
    limit.write,
    async (req: Request, res: Response) => {
      const { name, userId } = req.params;
      const auth = await resolveAuth(
        req,
        httpAuth,
        userInfo,
        landingPageToken,
        store,
      );
      if (!auth.authorized) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      try {
        if (!auth.isAdmin) {
          if (!auth.userId) {
            res.status(403).json({ error: 'Access denied' });
            return;
          }
          const membership = await store.getMemberByTenant(name, auth.userId);
          if (!membership || membership.role !== 'owner') {
            res
              .status(403)
              .json({ error: 'Only tenant owners can change roles' });
            return;
          }
        }
        const body: UpdateMemberRoleRequest = req.body;
        const { role } = body;
        if (!role || !(ROLES as readonly string[]).includes(role)) {
          res
            .status(400)
            .json({ error: 'role must be owner, developer, or viewer' });
          return;
        }
        await store.updateMemberRole(name, userId, role);
        logger.info(
          `[tenant-backend] Role of '${userId}' in '${name}' changed to ${role} by ${
            auth.userId ?? auth.callerInfo
          }`,
        );
        res.json({ message: `Role updated to ${role}` });
      } catch (err: any) {
        logger.error(
          `[tenant-backend] PUT /tenants/${name}/members/${userId}/role error: ${err}`,
        );
        res.status(500).json({ error: 'Internal error' });
      }
    },
  );

  // ── GET /backstage/catalog.yaml ────────────────────────────────────────────
  // Optional Bearer-only dump for operators. The catalog itself is fed by
  // TenantCatalogEntityProvider (no URL, no query token). Query-string tokens
  // are rejected so a leaked location URL cannot fetch PII.
  router.get('/backstage/catalog.yaml', async (req: Request, res: Response) => {
    if (!landingPageToken) {
      res
        .status(503)
        .send(
          '# catalog export disabled: tenantManagement.landingPageToken is not configured',
        );
      return;
    }
    const authHeader = req.headers['authorization'];
    const provided = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : undefined;
    if (!staticTokenEquals(provided, landingPageToken)) {
      res.status(401).send('# unauthorized');
      return;
    }
    try {
      const [tenants, allMembers] = await Promise.all([
        store.listAll(),
        store.listAllMembers(),
      ]);
      const yamlContent = buildTenantCatalogEntities(tenants, allMembers)
        .map(d => yamlDump(d))
        .join('---\n');
      res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
      res.send(yamlContent);
    } catch (err: any) {
      logger.error(
        `[tenant-backend] GET /backstage/catalog.yaml error: ${err}`,
      );
      res.status(500).send('# Error generating catalog YAML');
    }
  });

  return router;
}
