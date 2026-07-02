import { Router, Request, Response, json } from 'express';
import {
  HttpAuthService,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { GitopsClient, GitopsConflictError } from './gitops-client';
import { ProposalStatus, StatusYaml } from './types';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  gitops: GitopsClient;
}

// Owner-role virtual marker group, not the broad `admins` team group which
// also includes developer/viewer roles. Matches tenant-backend's DB-verified
// owner check, the permission policy, and the frontend's useIsAdmin hook.
const ADMIN_GROUP_REF = 'group:default/admins-owners';
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

interface AdminAuth {
  ok: boolean;
  isAdmin: boolean;
  /** GitHub login extracted from `user:default/<login>` ownership ref. */
  userId?: string;
  reason?: string;
}

/**
 * Resolve the caller as a Backstage user and verify membership of
 * `group:default/admins-owners`. Service tokens (plugin-to-plugin) are
 * authenticated for read access only — they are never marked as admin
 * so they cannot drive write endpoints (`accept`/`reject`). Admin write
 * authority must come from a user credential whose ownership refs
 * include `group:default/admins-owners`.
 */
async function resolveAdmin(
  req: Request,
  httpAuth: HttpAuthService,
  userInfo: UserInfoService,
): Promise<AdminAuth> {
  try {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
    const isAdmin = ownershipEntityRefs.some(ref => ref === ADMIN_GROUP_REF);
    const userRef = ownershipEntityRefs.find(ref =>
      ref.startsWith('user:default/'),
    );
    const userId = userRef?.split('/').pop();
    return { ok: true, isAdmin, userId };
  } catch {
    // not a user token — try service
  }
  try {
    await httpAuth.credentials(req, { allow: ['service'] });
    // Service principals are read-only: never grant admin write access.
    return { ok: true, isAdmin: false };
  } catch {
    return { ok: false, isAdmin: false, reason: 'No valid credentials' };
  }
}

/**
 * Allowed status transition matrix for admin-driven decisions.
 *
 * Allowed:
 *   proposed  → accepted   (Accept button)
 *   proposed  → rejected   (Reject button)
 *   accepted  → rejected   (change of mind before Tier 2 starts)
 *   rejected  → accepted   (reversal)
 *
 * Forbidden (by design):
 *   any transition to/from `in-progress`  (only Tier 2 implementer writes that)
 *   any transition to/from `implemented`  (terminal)
 *   no-op transitions (`accepted` → `accepted`, `rejected` → `rejected`)
 */
function isAllowedTransition(
  current: ProposalStatus,
  attempted: Extract<ProposalStatus, 'accepted' | 'rejected'>,
): boolean {
  if (attempted === 'accepted') {
    return current === 'proposed' || current === 'rejected';
  }
  if (attempted === 'rejected') {
    return current === 'proposed' || current === 'accepted';
  }
  return false;
}

function validateRouteParams(req: Request, res: Response): boolean {
  const { service, slug } = req.params;
  if (!service || !SLUG_RE.test(service)) {
    res.status(400).json({ error: 'Invalid service name' });
    return false;
  }
  if (!slug || !SLUG_RE.test(slug)) {
    res.status(400).json({ error: 'Invalid slug' });
    return false;
  }
  return true;
}

export function createRouter(opts: RouterOptions): Router {
  const { logger, httpAuth, userInfo, gitops } = opts;
  const router = Router();
  router.use(json());

  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // ── GET /proposals ────────────────────────────────────────────────────
  router.get('/proposals', async (req: Request, res: Response) => {
    const auth = await resolveAdmin(req, httpAuth, userInfo);
    if (!auth.ok) {
      res.status(401).json({ error: auth.reason });
      return;
    }
    try {
      const items = await gitops.listProposals();
      res.json({ proposals: items });
    } catch (err: any) {
      logger.error(`[proposals-backend] GET /proposals error: ${err}`);
      res.status(500).json({ error: String(err?.message ?? 'Internal error') });
    }
  });

  // ── GET /proposals/:service/:slug ─────────────────────────────────────
  router.get('/proposals/:service/:slug', async (req: Request, res: Response) => {
    const auth = await resolveAdmin(req, httpAuth, userInfo);
    if (!auth.ok) {
      res.status(401).json({ error: auth.reason });
      return;
    }
    if (!validateRouteParams(req, res)) return;
    const { service, slug } = req.params;
    try {
      const detail = await gitops.getProposal(service, slug);
      if (!detail) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }
      res.json(detail);
    } catch (err: any) {
      logger.error(
        `[proposals-backend] GET /proposals/${service}/${slug} error: ${err}`,
      );
      res.status(500).json({ error: String(err?.message ?? 'Internal error') });
    }
  });

  async function writeDecision(
    req: Request,
    res: Response,
    nextStatus: Extract<ProposalStatus, 'accepted' | 'rejected'>,
  ): Promise<void> {
    const auth = await resolveAdmin(req, httpAuth, userInfo);
    if (!auth.ok) {
      res.status(401).json({ error: auth.reason });
      return;
    }
    if (!auth.isAdmin) {
      res.status(403).json({ error: 'Only admins can change proposal status' });
      return;
    }
    if (!validateRouteParams(req, res)) return;

    const { service, slug } = req.params;
    const body = (req.body ?? {}) as { notes?: unknown };
    const notes = typeof body.notes === 'string' ? body.notes.trim() : '';

    if (nextStatus === 'rejected' && !notes) {
      res.status(400).json({ error: 'notes are required to reject a proposal' });
      return;
    }

    try {
      // Make sure the proposal actually exists before writing the status file.
      const detail = await gitops.getProposal(service, slug);
      if (!detail) {
        res.status(404).json({ error: 'Proposal not found' });
        return;
      }

      // Server-side terminal-status guard. The UI disables these actions but
      // a direct API call must not be able to overwrite an `in-progress` or
      // `implemented` proposal, nor perform a no-op re-decision.
      if (!isAllowedTransition(detail.status, nextStatus)) {
        res.status(409).json({
          error: 'invalid status transition',
          current: detail.status,
          attempted: nextStatus,
        });
        return;
      }

      const payload: StatusYaml = {
        status: nextStatus,
        updated_at: new Date().toISOString(),
        updated_by: auth.userId ?? 'backstage',
        ...(detail.pr ? { pr: detail.pr } : {}),
        ...(notes ? { notes } : detail.notes ? { notes: detail.notes } : {}),
      };
      const commitMessage = `chore(proposals): ${nextStatus === 'accepted' ? 'accept' : 'reject'} ${service}/${slug}`;
      await gitops.writeStatus(service, slug, payload, commitMessage);
      res.json({
        ok: true,
        status: nextStatus,
        updated_by: payload.updated_by,
        updated_at: payload.updated_at,
      });
    } catch (err: any) {
      logger.error(
        `[proposals-backend] write ${nextStatus} for ${service}/${slug}: ${err}`,
      );
      if (err instanceof GitopsConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: String(err?.message ?? 'Internal error') });
    }
  }

  // ── POST /proposals/:service/:slug/accept ─────────────────────────────
  router.post(
    '/proposals/:service/:slug/accept',
    async (req: Request, res: Response) => writeDecision(req, res, 'accepted'),
  );

  // ── POST /proposals/:service/:slug/reject ─────────────────────────────
  router.post(
    '/proposals/:service/:slug/reject',
    async (req: Request, res: Response) => writeDecision(req, res, 'rejected'),
  );

  return router;
}
