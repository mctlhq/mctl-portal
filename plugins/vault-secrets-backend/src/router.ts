import { Router, Request, Response } from 'express';
import type { Knex } from 'knex';
import {
  HttpAuthService,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { getTenantMember, isAdminUser } from '../../tenant-backend/src/membershipLookup';
import type { VaultTokenProvider } from './vaultAuth';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  db: Knex;
  isPostgres: boolean;
  vaultAddr: string;
  /** Supplies (and can refresh) the Vault token. See vaultAuth.ts. */
  vaultTokens: VaultTokenProvider;
}

type TenantAuthResult =
  | { ok: true; userId: string; role: string; viaAdminBypass: boolean }
  | { ok: false; status: number; error: string };

// Vault KV v2 paths (relative to the secret/ mount). These mirror what the
// platform actually writes: wft-provision-database.yaml stores DB credentials
// at teams/<team>/<app>/database, and the ExternalSecret it generates reads
// back from the same place. Keep both in step — a path nothing writes reads
// back as a 404, or as a 403 if the token's policy doesn't cover the prefix.
export const databaseVaultPath = (team: string, app: string) =>
  `teams/${team}/${app}/database`;
export const secretsVaultPath = (team: string, app: string) =>
  `teams/${team}/${app}`;

/**
 * Audit trail for successful secret reads. These two routes hand out live
 * credentials — DB passwords and service secrets — and since the admin bypass
 * landed, a platform admin can read them for a tenant they are not a member
 * of. Without this the read leaves no trace at all.
 *
 * Logs metadata only: who, what, and whether membership was bypassed. Secret
 * VALUES are never logged; for /secrets the key names are recorded (they are
 * env-var names like BETTER_AUTH_SECRET, not sensitive) so an investigation
 * can tell what was exposed.
 */
export function auditSecretRead(
  logger: LoggerService,
  kind: 'database' | 'database-meta' | 'secrets' | 'secrets-meta',
  team: string,
  app: string,
  auth: { userId: string; role: string; viaAdminBypass: boolean },
  secretKeys?: string[],
): void {
  logger.info('vault-secrets read', {
    audit: 'secret_read',
    kind,
    team,
    app,
    user: auth.userId,
    role: auth.role,
    // The signal worth alerting on: a non-member reading a tenant's secrets.
    via_admin_bypass: auth.viaAdminBypass,
    ...(secretKeys ? { secret_keys: secretKeys.join(',') } : {}),
  });
}

export function createRouter(options: RouterOptions): Router {
  const { logger, httpAuth, userInfo, db, isPostgres, vaultAddr, vaultTokens } = options;
  const router = Router();

  /**
   * Express decodes each path segment before it reaches req.params, so a
   * request for /teams/team-a/..%2Fteam-b%2Fvictim/secrets arrives here with
   * app === '../team-b/victim'. requireTenantRole only ever checks `team`, so
   * that request passes RBAC as a legitimate team-a member — and then
   * databaseVaultPath/secretsVaultPath splice the dot-segments straight into
   * the Vault URL, where WHATWG URL normalisation collapses them and hands
   * back another tenant's credentials. Reject anything that is not a plain
   * kebab-case slug before either value is used for authorisation or as a
   * path component.
   */
  const rejectNonSlug = (req: Request, res: Response): boolean => {
    const { team, app } = req.params;
    if (!SLUG_RE.test(team) || !SLUG_RE.test(app)) {
      res.status(400).json({ error: 'Invalid team or app' });
      return true;
    }
    return false;
  };

  router.get('/teams/:team/:app/database', async (req: Request, res: Response) => {
    if (rejectNonSlug(req, res)) {
      return;
    }
    const { team, app } = req.params;
    const auth = await requireTenantRole(req, httpAuth, userInfo, db, isPostgres, team, 'viewer');
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    try {
      const creds = await readVaultKV(vaultAddr, vaultTokens, databaseVaultPath(team, app));
      if (!creds) {
        res.status(404).json({ error: `No database found for ${team}/${app}` });
        return;
      }
      auditSecretRead(logger, 'database-meta', team, app, auth);
      res.json({
        host: creds.host,
        port: creds.port,
        database: creds.database,
        username: creds.username,
        hasPassword: Boolean(creds.password),
      });
    } catch (err: any) {
      logger.error(`vault-secrets error for ${team}/${app}: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/teams/:team/:app/database/reveal', async (req: Request, res: Response) => {
    if (rejectNonSlug(req, res)) {
      return;
    }
    const { team, app } = req.params;
    const auth = await requireTenantRole(req, httpAuth, userInfo, db, isPostgres, team, 'developer');
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    try {
      const creds = await readVaultKV(vaultAddr, vaultTokens, databaseVaultPath(team, app));
      if (!creds) {
        res.status(404).json({ error: `No database found for ${team}/${app}` });
        return;
      }
      auditSecretRead(logger, 'database', team, app, auth);
      res.json({
        host: creds.host,
        port: creds.port,
        database: creds.database,
        username: creds.username,
        password: creds.password,
      });
    } catch (err: any) {
      logger.error(`vault-secrets error for ${team}/${app}: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/teams/:team/:app/secrets', async (req: Request, res: Response) => {
    if (rejectNonSlug(req, res)) {
      return;
    }
    const { team, app } = req.params;
    const auth = await requireTenantRole(req, httpAuth, userInfo, db, isPostgres, team, 'viewer');
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    try {
      const secrets = await readVaultKV(vaultAddr, vaultTokens, secretsVaultPath(team, app));
      auditSecretRead(logger, 'secrets-meta', team, app, auth, Object.keys(secrets ?? {}));
      res.json({ secretKeys: Object.keys(secrets ?? {}) });
    } catch (err: any) {
      logger.error(`vault-secrets error for ${team}/${app}: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  router.get('/teams/:team/:app/secrets/reveal', async (req: Request, res: Response) => {
    if (rejectNonSlug(req, res)) {
      return;
    }
    const { team, app } = req.params;
    const auth = await requireTenantRole(req, httpAuth, userInfo, db, isPostgres, team, 'developer');
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    try {
      const secrets = await readVaultKV(vaultAddr, vaultTokens, secretsVaultPath(team, app));
      auditSecretRead(logger, 'secrets', team, app, auth, Object.keys(secrets ?? {}));
      res.json({ secrets: secrets ?? {} });
    } catch (err: any) {
      logger.error(`vault-secrets error for ${team}/${app}: ${err}`);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return router;
}

async function requireTenantRole(
  req: Request,
  httpAuth: HttpAuthService,
  userInfo: UserInfoService,
  db: Knex,
  isPostgres: boolean,
  team: string,
  minimumRole: 'viewer' | 'developer' | 'owner',
): Promise<TenantAuthResult> {
  try {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
    const userId = extractUserId(ownershipEntityRefs);
    if (!userId) {
      return { ok: false, status: 401, error: 'Authentication required' };
    }
    return checkTenantRole(db, isPostgres, team, userId, minimumRole);
  } catch (err: any) {
    if (err?.name === 'AuthenticationError' || err?.message?.includes('auth')) {
      return { ok: false, status: 401, error: 'Authentication required' };
    }
    return { ok: false, status: 500, error: 'Internal authentication error' };
  }
}

// Three-value tenant role model (see plugins/tenant-backend/src/types.ts:64):
// viewer < developer < owner. Ranked so a single numeric comparison covers
// every "at least this role" check instead of a per-role equality branch.
const ROLE_RANK: Record<string, number> = { viewer: 0, developer: 1, owner: 2 };

function meetsMinimumRole(role: string, minimumRole: 'viewer' | 'developer' | 'owner'): boolean {
  return (ROLE_RANK[role] ?? -1) >= ROLE_RANK[minimumRole];
}

export async function checkTenantRole(
  db: Knex,
  isPostgres: boolean,
  team: string,
  userId: string,
  minimumRole: 'viewer' | 'developer' | 'owner',
): Promise<TenantAuthResult> {
  // Platform admins (owner role in the 'admins' tenant) bypass per-team
  // membership, mirroring tenant-backend's isAdmin pattern in resolveAuth().
  if (await isAdminUser(db, isPostgres, userId)) {
    return { ok: true, userId, role: 'owner', viaAdminBypass: true };
  }
  const member = await getTenantMember(db, isPostgres, team, userId.toLowerCase());
  if (!member) {
    return { ok: false, status: 403, error: `Access denied: not a member of team '${team}'` };
  }
  if (!meetsMinimumRole(member.role, minimumRole)) {
    return { ok: false, status: 403, error: `Access denied: ${minimumRole} role required for team '${team}'` };
  }
  return { ok: true, userId, role: member.role, viaAdminBypass: false };
}

function extractUserId(ownershipEntityRefs: string[]): string | undefined {
  const ref = ownershipEntityRefs.find(r => r.startsWith('user:default/'));
  return ref?.split('/').pop();
}

/**
 * Issues a Vault request, retrying once with a fresh token if Vault rejects
 * the credential.
 *
 * Vault answers both "token is dead" and "token lacks this path" with 403, and
 * the response body doesn't reliably distinguish them, so the retry fires on
 * either. That costs one wasted login on a genuine policy error and buys
 * automatic recovery from a revoked or expired token — the failure mode that
 * took the DB-credentials card down for months.
 */
export async function vaultFetch(
  vaultAddr: string,
  tokens: VaultTokenProvider,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; ok: boolean; json: () => Promise<any> }> {
  const send = async (token: string) =>
    fetch(`${vaultAddr}/v1/secret/data/${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'X-Vault-Token': token,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
    });

  const used = await tokens.getToken();
  let resp = await send(used);
  if (resp.status === 401 || resp.status === 403) {
    // Pass the rejected token so a concurrent request that already refreshed
    // doesn't get its fresh credential thrown away. See VaultTokenProvider.
    tokens.invalidate(used);
    resp = await send(await tokens.getToken());
  }
  return resp;
}

async function readVaultKV(vaultAddr: string, tokens: VaultTokenProvider, path: string): Promise<Record<string, string> | undefined> {
  const vaultResp = await vaultFetch(vaultAddr, tokens, path);
  if (vaultResp.status === 404) {
    return undefined;
  }
  if (!vaultResp.ok) {
    throw new Error(`Vault read failed: HTTP ${vaultResp.status}`);
  }
  const vaultData = (await vaultResp.json()) as any;
  return vaultData?.data?.data ?? undefined;
}

// Team and app names are kebab-case slugs (see CONVENTIONS.md). Both become
// Vault path components, so reject anything else up front (see rejectNonSlug).
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
