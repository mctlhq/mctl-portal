import { Router, Request, Response, json } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { HttpAuthService, LoggerService, UserInfoService } from '@backstage/backend-plugin-api';
import { ArgoWorkflowsClient } from '@internal/plugin-argo-workflows-backend';
import { TenantStore } from './tenantStore';
import { CreateTenantRequest, InviteMemberRequest, UpdateMemberRoleRequest } from './types';
import { dump as yamlDump } from 'js-yaml';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  store: TenantStore;
  argoClient: ArgoWorkflowsClient;
  argoNamespace: string;
  getGithubToken: () => Promise<string>;
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
}

type AuthResult =
  | { authorized: true; isAdmin: boolean; callerInfo: string; userId: string | undefined }
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
function verifyLandingJwt(token: string, secret: string): Record<string, unknown> | undefined {
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
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return undefined;
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));

    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return undefined;
    }

    return payload;
  } catch {
    return undefined;
  }
}

/**
 * Resolve caller identity with three tiers:
 *   1. Landing-page JWT or static token (for Cloudflare Worker)
 *   2. Backstage user credentials (browser sessions)
 *   3. Backstage service credentials (plugin-to-plugin)
 *
 * isAdmin is only true when the user has `owner` role in the `admins` tenant (verified in DB).
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
        return { authorized: true, isAdmin: true, callerInfo: 'landing-page-jwt', userId: undefined };
      }

      // Fallback: static token comparison (backward compatibility)
      // Use timing-safe comparison to prevent timing attacks
      const tokenBuf = Buffer.from(bearerValue);
      const expectedBuf = Buffer.from(landingPageToken);
      if (tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf)) {
        return { authorized: true, isAdmin: true, callerInfo: 'landing-page', userId: undefined };
      }
    }
  }

  // ── Tier 2: Backstage user credentials ────────────────────────────────────
  try {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
    const userId = extractUserId(ownershipEntityRefs);

    // isAdmin requires owner role in admins tenant (verified in DB, not just group membership)
    let isAdmin = false;
    if (userId && ownershipEntityRefs.some(ref => ref === 'group:default/admins')) {
      const membership = await store.getMemberTenant(userId);
      isAdmin = membership?.tenantName === 'admins' && membership?.role === 'owner';
    }

    return {
      authorized: true,
      isAdmin,
      callerInfo: ownershipEntityRefs[0] ?? 'user',
      userId,
    };
  } catch {
    // not a user token — try next tier
  }

  // ── Tier 3: Backstage service credentials (plugin-to-plugin) ──────────────
  try {
    await httpAuth.credentials(req, { allow: ['service'] });
    return { authorized: true, isAdmin: true, callerInfo: 'service', userId: undefined };
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
  } = opts;
  const dq = defaultQuotas ?? {
    cpuReq: '1', cpuLim: '2',
    memReq: '2Gi', memLim: '3Gi',
    pods: '10', pvcs: '2', services: '5',
  };
  const router = Router();
  router.use(json());

  /**
   * Look up a GitHub user by username. Returns user info or null if not found.
   * Throws on unexpected errors.
   */
  async function lookupGithubUser(username: string): Promise<{ login: string; name: string | null; avatarUrl: string } | null> {
    const token = await getGithubToken();
    const res = await fetch(`https://api.github.com/users/${username}`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub API error: HTTP ${res.status}`);
    const data = await res.json() as { login: string; name: string | null; avatar_url: string };
    return { login: data.login, name: data.name, avatarUrl: data.avatar_url };
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
  router.get('/check-user', async (req: Request, res: Response) => {
    const auth = await resolveAuth(req, httpAuth, userInfo, landingPageToken, store);
    if (!auth.authorized) {
      res.status(401).json({ error: 'Authentication required' });
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
      res.json({ exists: true, login: user.login, name: user.name, avatarUrl: user.avatarUrl });
    } catch (err: any) {
      logger.warn(`[tenant-backend] GET /check-user error: ${err}`);
      // On network/API errors, return unknown (don't block the UI)
      res.json({ exists: null, error: String(err?.message ?? 'GitHub API unavailable') });
    }
  });


  // Returns all tenants. Requires authentication.
  router.get('/tenants', async (req: Request, res: Response) => {
    const auth = await resolveAuth(req, httpAuth, userInfo, landingPageToken, store);
    if (!auth.authorized) {
      res.status(401).json({ error: 'Authentication required' });
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
  router.get('/tenants/:name', async (req: Request, res: Response) => {
    const { name } = req.params;
    const auth = await resolveAuth(req, httpAuth, userInfo, landingPageToken, store);
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
      res.json({ tenant });
    } catch (err: any) {
      logger.error(`[tenant-backend] GET /tenants/${name} error: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── POST /tenants ─────────────────────────────────────────────────────────
  // Creates a new tenant via wft-create-tenant Argo WorkflowTemplate.
  // Requires: admin user, service token, or landing-page static token.
  router.post('/tenants', async (req: Request, res: Response) => {
    const auth = await resolveAuth(req, httpAuth, userInfo, landingPageToken, store);

    if (!auth.authorized) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!auth.isAdmin) {
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
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(body.tenantName)) {
        res.status(400).json({
          error: 'tenantName must match ^[a-z0-9][a-z0-9-]{1,62}$',
        });
        return;
      }

      // Check if tenant already exists in DB cache
      const existing = await store.findByName(body.tenantName);
      if (existing) {
        res.status(409).json({ error: `Tenant '${body.tenantName}' already exists` });
        return;
      }

      logger.info(
        `[tenant-backend] Creating tenant '${body.tenantName}' requested by ${auth.callerInfo}`,
      );

      // Write to DB immediately so the tenant is visible in Backstage catalog
      // without waiting for TenantSync (which polls git every 5 min).
      await store.upsert({
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
      });
      logger.info(`[tenant-backend] Tenant '${body.tenantName}' written to DB`);

      // Submit Argo WorkflowTemplate (handles K8s namespace, Vault, ArgoCD RBAC)
      const workflowName = await argoClient.submitWorkflow({
        resourceKind: 'ClusterWorkflowTemplate',
        resourceName: 'create-tenant',
        namespace: argoNamespace,
        parameters: [
          `tenant_name=${body.tenantName}`,
          `display_name=${body.displayName}`,
          `description=${body.description ?? ''}`,
          `quota_cpu_req=${body.quotaCpuReq ?? dq.cpuReq}`,
          `quota_cpu_lim=${body.quotaCpuLim ?? dq.cpuLim}`,
          `quota_memory_req=${body.quotaMemoryReq ?? dq.memReq}`,
          `quota_memory_lim=${body.quotaMemoryLim ?? dq.memLim}`,
          `quota_pods=${body.quotaPods ?? dq.pods}`,
          `allow_internet_egress=${body.allowInternetEgress ? 'true' : 'false'}`,
          `contact_email=${body.contactEmail ?? ''}`,
          `creator_user_id=${body.creatorUserId ?? ''}`,
        ],
        labels: { 'submitted-by': `backstage-${auth.callerInfo}` },
      });

      res.status(202).json({
        message: `Tenant creation workflow submitted`,
        workflowName,
        workflowUrl: `https://workflows.mctl.me/workflows/${argoNamespace}/${workflowName}`,
      });

      // If creatorUserId is provided, register the creator as owner immediately
      if (body.creatorUserId) {
        try {
          await store.addMember({
            tenantName: body.tenantName,
            userId: body.creatorUserId.toLowerCase(),
            role: 'owner',
            invitedAt: new Date().toISOString(),
            invitedBy: 'system',
          });
          logger.info(
            `[tenant-backend] Registered creator '${body.creatorUserId}' as owner of '${body.tenantName}'`,
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
  router.delete('/tenants/:name', async (req: Request, res: Response) => {
    try {
      const auth = await resolveAuth(req, httpAuth, userInfo, landingPageToken, store);
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
      const reserved = ['admins', 'argocd', 'argo-workflows', 'kube-system', 'default', 'vault', 'monitoring'];
      if (reserved.includes(name)) {
        res.status(400).json({ error: `Tenant '${name}' is protected and cannot be deleted` });
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

      logger.info(`[tenant-backend] Safe delete workflow '${workflowName}' submitted for tenant '${name}'`);

      res.status(202).json({
        message: `Tenant '${name}' deletion queued`,
        workflowName,
        workflowUrl: `https://workflows.mctl.me/workflows/${argoNamespace}/${workflowName}`,
      });
    } catch (err: any) {
      logger.error(`[tenant-backend] DELETE /tenants/${req.params.name} error: ${err}`);
      res.status(500).json({ error: String(err?.message ?? 'Internal error') });
    }
  });

  // ── GET /me/tenant ────────────────────────────────────────────────────────
  // Returns the tenant and role for the currently authenticated user.
  router.get('/me/tenant', async (req: Request, res: Response) => {
    const auth = await resolveAuth(req, httpAuth, userInfo, landingPageToken, store);
    if (!auth.authorized) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!auth.userId) {
      res.status(200).json({ tenant: null });
      return;
    }
    try {
      const membership = await store.getMemberTenant(auth.userId);
      if (!membership) {
        res.status(200).json({ tenant: null });
        return;
      }
      const tenant = await store.findByName(membership.tenantName);
      res.json({ tenant, role: membership.role });
    } catch (err: any) {
      logger.error(`[tenant-backend] GET /me/tenant error: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── GET /tenants/:name/members ────────────────────────────────────────────
  // List all members of a tenant. Requires auth (any member or admin).
  router.get('/tenants/:name/members', async (req: Request, res: Response) => {
    const { name } = req.params;
    const auth = await resolveAuth(req, httpAuth, userInfo, landingPageToken, store);
    if (!auth.authorized) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      // Check access: admin or member of this tenant
      if (!auth.isAdmin && auth.userId) {
        const membership = await store.getMemberTenant(auth.userId);
        if (!membership || membership.tenantName !== name) {
          res.status(403).json({ error: 'Access denied' });
          return;
        }
      }
      const members = await store.listMembers(name);
      res.json({ members });
    } catch (err: any) {
      logger.error(`[tenant-backend] GET /tenants/${name}/members error: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── POST /tenants/:name/members ───────────────────────────────────────────
  // Invite a user to a tenant. Requires: tenant owner or admin.
  router.post('/tenants/:name/members', async (req: Request, res: Response) => {
    const { name } = req.params;
    const auth = await resolveAuth(req, httpAuth, userInfo, landingPageToken, store);
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
        const membership = await store.getMemberTenant(auth.userId);
        if (!membership || membership.tenantName !== name || membership.role !== 'owner') {
          res.status(403).json({ error: 'Only tenant owners can invite members' });
          return;
        }
      }

      const body: InviteMemberRequest = req.body;
      if (!body.userId || typeof body.userId !== 'string') {
        res.status(400).json({ error: 'userId is required' });
        return;
      }
      const userId = body.userId.toLowerCase().trim();
      if (!/^[a-z0-9]([a-z0-9-]{0,37}[a-z0-9])?$/i.test(userId)) {
        res.status(400).json({ error: 'Invalid GitHub username format' });
        return;
      }
      const role = body.role ?? 'developer';
      if (!['owner', 'developer', 'viewer'].includes(role)) {
        res.status(400).json({ error: 'role must be owner, developer, or viewer' });
        return;
      }

      // Validate that the GitHub user actually exists
      try {
        const ghUser = await lookupGithubUser(userId);
        if (ghUser === null) {
          res.status(400).json({ error: `GitHub user '${userId}' not found` });
          return;
        }
        // Use canonical casing from GitHub
        // (userId is already lowercased above, but GitHub login is canonical)
      } catch (ghErr: any) {
        // GitHub API unavailable — log and allow through (best-effort)
        logger.warn(`[tenant-backend] Could not verify GitHub user '${userId}' (allowing anyway): ${ghErr?.message}`);
      }

      await store.addMember({
        tenantName: name,
        userId,
        role,
        invitedAt: new Date().toISOString(),
        invitedBy: auth.userId ?? auth.callerInfo,
      });

      logger.info(
        `[tenant-backend] User '${userId}' invited to tenant '${name}' as ${role} by ${auth.userId ?? auth.callerInfo}`,
      );
      res.status(201).json({ message: `User '${userId}' invited as ${role}` });
    } catch (err: any) {
      logger.error(`[tenant-backend] POST /tenants/${name}/members error: ${err}`);
      if (err?.message?.includes('already a member')) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: String(err?.message ?? 'Internal error') });
    }
  });

  // ── DELETE /tenants/:name/members/:userId ─────────────────────────────────
  // Remove a member from a tenant. Requires: tenant owner or admin.
  router.delete('/tenants/:name/members/:userId', async (req: Request, res: Response) => {
    const { name, userId } = req.params;
    const auth = await resolveAuth(req, httpAuth, userInfo, landingPageToken, store);
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
        const membership = await store.getMemberTenant(auth.userId);
        if (!membership || membership.tenantName !== name || membership.role !== 'owner') {
          res.status(403).json({ error: 'Only tenant owners can remove members' });
          return;
        }
        // Owner can't remove themselves if they're the only owner
        if (userId === auth.userId) {
          const members = await store.listMembers(name);
          const owners = members.filter(m => m.role === 'owner');
          if (owners.length <= 1) {
            res.status(400).json({ error: 'Cannot remove the only owner of a tenant' });
            return;
          }
        }
      }
      await store.removeMember(name, userId);
      logger.info(`[tenant-backend] User '${userId}' removed from tenant '${name}'`);
      res.status(204).send();
    } catch (err: any) {
      logger.error(`[tenant-backend] DELETE /tenants/${name}/members/${userId} error: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── PUT /tenants/:name/members/:userId/role ────────────────────────────────
  // Change a member's role. Requires: tenant owner or admin.
  router.put('/tenants/:name/members/:userId/role', async (req: Request, res: Response) => {
    const { name, userId } = req.params;
    const auth = await resolveAuth(req, httpAuth, userInfo, landingPageToken, store);
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
        const membership = await store.getMemberTenant(auth.userId);
        if (!membership || membership.tenantName !== name || membership.role !== 'owner') {
          res.status(403).json({ error: 'Only tenant owners can change roles' });
          return;
        }
      }
      const body: UpdateMemberRoleRequest = req.body;
      const { role } = body;
      if (!role || !['owner', 'developer', 'viewer'].includes(role)) {
        res.status(400).json({ error: 'role must be owner, developer, or viewer' });
        return;
      }
      await store.updateMemberRole(name, userId, role);
      logger.info(
        `[tenant-backend] Role of '${userId}' in '${name}' changed to ${role} by ${auth.userId ?? auth.callerInfo}`,
      );
      res.json({ message: `Role updated to ${role}` });
    } catch (err: any) {
      logger.error(
        `[tenant-backend] PUT /tenants/${name}/members/${userId}/role error: ${err}`,
      );
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // ── GET /backstage/catalog.yaml ────────────────────────────────────────────
  // Returns all tenant User and Group entities as Backstage catalog YAML.
  // No auth required — registered as a catalog location in app-config.
  router.get('/backstage/catalog.yaml', async (_req: Request, res: Response) => {
    try {
      const [tenants, allMembers] = await Promise.all([
        store.listAll(),
        store.listAllMembers(),
      ]);

      const docs: object[] = [];

      // Group entities: one main group per tenant + viewer marker groups
      for (const tenant of tenants) {
        const tenantMembers = allMembers.filter(m => m.tenantName === tenant.name);
        const viewers = tenantMembers.filter(m => m.role === 'viewer').map(m => m.userId);

        // Main team group — all members (owner, developer, viewer)
        docs.push({
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Group',
          metadata: {
            name: tenant.name,
            namespace: 'default',
            title: tenant.displayName,
            ...(tenant.description ? { description: tenant.description } : {}),
            annotations: {
              'mctl.me/tenant-name': tenant.name,
            },
          },
          spec: {
            type: 'team',
            owner: `group:default/${tenant.name}`,
            profile: {
              displayName: tenant.displayName,
              ...(tenant.contactEmail ? { email: tenant.contactEmail } : {}),
            },
            children: [],
            members: tenantMembers.map(m => m.userId),
          },
        });

        // Viewer marker group — used by permission policy to restrict scaffolder access
        if (viewers.length > 0) {
          docs.push({
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: {
              name: `viewer-${tenant.name}`,
              namespace: 'default',
              title: `${tenant.displayName} (Viewers)`,
              annotations: {
                'mctl.me/tenant-name': tenant.name,
                'mctl.me/role-marker': 'viewer',
              },
            },
            spec: {
              type: 'virtual',
              owner: `group:default/${tenant.name}`,
              profile: { displayName: `${tenant.displayName} Viewers` },
              children: [],
              members: viewers,
            },
          });
        }
      }

      // System entities: one per tenant (auto-managed)
      for (const tenant of tenants) {
        docs.push({
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'System',
          metadata: {
            name: `team-${tenant.name}`,
            namespace: 'default',
            description: `${tenant.displayName} workloads`,
            annotations: {
              'mctl.me/tenant-name': tenant.name,
            },
          },
          spec: {
            owner: `group:default/${tenant.name}`,
          },
        });
      }

      // User entities — one per unique user, memberOf includes ALL their tenants.
      // Viewers get an extra viewer-{tenant} marker group per tenant for policy detection.
      const userMemberships = new Map<string, Array<typeof allMembers[0]>>();
      for (const m of allMembers) {
        const existing = userMemberships.get(m.userId) ?? [];
        existing.push(m);
        userMemberships.set(m.userId, existing);
      }
      for (const [userId, memberships] of userMemberships.entries()) {
        const memberOf: string[] = [];
        for (const m of memberships) {
          memberOf.push(m.tenantName);
          if (m.role === 'viewer') memberOf.push(`viewer-${m.tenantName}`);
        }
        const primary = memberships[0];
        docs.push({
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'User',
          metadata: {
            name: userId,
            namespace: 'default',
            annotations: {
              'github.com/user-login': userId,
              'mctl.me/tenant-role': primary.role,
            },
          },
          spec: {
            profile: { displayName: userId },
            memberOf,
            owner: `group:default/${primary.tenantName}`,
          },
        });
      }

      const yamlContent = docs.map(d => yamlDump(d)).join('---\n');
      res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
      res.send(yamlContent);
    } catch (err: any) {
      logger.error(`[tenant-backend] GET /backstage/catalog.yaml error: ${err}`);
      res.status(500).send('# Error generating catalog YAML');
    }
  });

  return router;
}
