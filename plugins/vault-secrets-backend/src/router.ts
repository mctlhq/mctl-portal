import { Router, Request, Response, urlencoded } from 'express';
import fetch from 'node-fetch';
import type { Knex } from 'knex';
import {
  HttpAuthService,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { getTenantMember, isAdminUser } from '../../tenant-backend/src/membershipLookup';
import { readOidcSessionUserId } from '../../oidc-provider-backend/src/sessionAuth';
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
  oidcLoginUrl: string;
  /** Public base URL of this backend (e.g. https://app.mctl.ai). Trusted source of truth for building self-referential URLs. */
  backendBaseUrl: string;
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
  const { logger, httpAuth, userInfo, db, isPostgres, vaultAddr, vaultTokens, oidcLoginUrl, backendBaseUrl } = options;
  const router = Router();
  router.use(urlencoded({ extended: false }));

  const trustedOrigin = deriveOrigin(backendBaseUrl);

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

  router.get('/openclaw/intake', async (req: Request, res: Response) => {
    const team = String(req.query.team ?? '').trim();
    const service = String(req.query.service ?? '').trim();
    const returnTo = sanitizeReturnTo(String(req.query.returnTo ?? '').trim());
    if (!team || !service) {
      res.status(400).send('Missing team or service');
      return;
    }
    if (!SLUG_RE.test(team) || !SLUG_RE.test(service)) {
      res.status(400).send('Invalid team or service name');
      return;
    }

    try {
      const userId = await readOidcSessionUserId(req.headers.cookie, db, isPostgres);
      if (!userId) {
        const selfUrl = buildSelfUrl(trustedOrigin, req.originalUrl);
        res.redirect(`${oidcLoginUrl}?returnTo=${encodeURIComponent(selfUrl)}`);
        return;
      }

      const auth = await checkTenantRole(db, isPostgres, team, userId, 'owner');
      if (!auth.ok) {
        res.status(auth.status).send(auth.error);
        return;
      }

      // Override Backstage's default Referrer-Policy: no-referrer so that
      // the form POST from this page keeps its Origin/Referer headers,
      // which our CSRF check relies on.
      res.setHeader('Referrer-Policy', 'same-origin');
      res.type('html').send(renderOpenClawIntakePage(team, service, returnTo));
    } catch (err: any) {
      logger.error(`openclaw intake GET failed: ${err?.stack ?? err}`);
      res.status(500).send('Internal error');
    }
  });

  router.post('/openclaw/intake', async (req: Request, res: Response) => {
    if (!isSameOrigin(req, trustedOrigin)) {
      res.status(403).send('Cross-site request blocked');
      return;
    }

    const team = String(req.body.team ?? '').trim();
    const service = String(req.body.service ?? '').trim();
    const returnTo = sanitizeReturnTo(String(req.body.returnTo ?? '').trim());
    const botToken = String(req.body.telegram_bot_token ?? '').trim();
    if (!team || !service) {
      res.status(400).send('Missing team or service');
      return;
    }
    if (!SLUG_RE.test(team) || !SLUG_RE.test(service)) {
      res.status(400).send('Invalid team or service name');
      return;
    }
    if (!botToken) {
      res.status(400).send('Telegram bot token is required');
      return;
    }

    try {
      const userId = await readOidcSessionUserId(req.headers.cookie, db, isPostgres);
      if (!userId) {
        res.status(401).send('Authentication required');
        return;
      }

      const auth = await checkTenantRole(db, isPostgres, team, userId, 'owner');
      if (!auth.ok) {
        res.status(auth.status).send(auth.error);
        return;
      }

      await writeVaultKV(vaultAddr, vaultTokens, `teams/${team}/${service}/telegram`, {
        'telegram-bot-token': botToken,
      });
      if (returnTo) {
        const sep = returnTo.includes('?') ? '&' : '?';
        res.redirect(`${returnTo}${sep}telegram_saved=1`);
        return;
      }
      res.type('html').send(renderOpenClawSavedPage(team, service));
    } catch (err: any) {
      logger.error(`openclaw intake POST failed for ${team}/${service}: ${err?.stack ?? err}`);
      res.status(500).send('Internal error');
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

function deriveOrigin(backendBaseUrl: string): string {
  try {
    return new URL(backendBaseUrl).origin;
  } catch {
    throw new Error(`vault-secrets: invalid backend.baseUrl: ${backendBaseUrl}`);
  }
}

function buildSelfUrl(trustedOrigin: string, originalUrl: string): string {
  return `${trustedOrigin}${originalUrl}`;
}

function isSameOrigin(req: Request, trustedOrigin: string): boolean {
  // Primary: Origin header. Sent by browsers for POST except under
  // Referrer-Policy: no-referrer (which Chrome honors by dropping Origin too).
  const origin = String(req.headers.origin ?? '').trim();
  if (origin) {
    return origin === trustedOrigin;
  }
  // Fallback: Referer header. Same caveat — suppressed under no-referrer.
  const referer = String(req.headers.referer ?? '').trim();
  if (referer) {
    try {
      return new URL(referer).origin === trustedOrigin;
    } catch {
      return false;
    }
  }
  // Last resort: Sec-Fetch-Site. Modern Fetch-Metadata header that can't be
  // set by JavaScript and is sent regardless of Referrer-Policy. 'same-origin'
  // means the browser initiated the request from the same origin as the
  // target, which is exactly the CSRF safety we need.
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '').trim();
  if (fetchSite === 'same-origin') {
    return true;
  }
  return false;
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

async function writeVaultKV(vaultAddr: string, tokens: VaultTokenProvider, path: string, data: Record<string, string>): Promise<void> {
  const vaultResp = await vaultFetch(vaultAddr, tokens, path, {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
  if (!vaultResp.ok) {
    throw new Error(`Vault write failed: HTTP ${vaultResp.status}`);
  }
}

function sanitizeReturnTo(value: string): string {
  if (!value) {
    return '';
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:') {
      return '';
    }
    if (!parsed.hostname.endsWith('.mctl.ai') && !parsed.hostname.endsWith('.mctl.me')) {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

// Team and service names are kebab-case slugs (see CONVENTIONS.md). Both are
// interpolated into intake HTML below, so reject anything else up front.
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderOpenClawIntakePage(rawTeam: string, rawService: string, rawReturnTo: string): string {
  const team = escapeHtml(rawTeam);
  const service = escapeHtml(rawService);
  const returnTo = escapeHtml(rawReturnTo);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Connect Telegram Bot</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      main { max-width: 720px; margin: 48px auto; padding: 32px; background: #111827; border-radius: 20px; box-shadow: 0 16px 48px rgba(0,0,0,0.35); }
      h1 { margin-top: 0; font-size: 28px; }
      p, li { line-height: 1.5; color: #cbd5e1; }
      code { background: #1e293b; padding: 2px 6px; border-radius: 6px; }
      label { display: block; margin-top: 20px; margin-bottom: 8px; font-weight: 600; color: #f8fafc; }
      input[type=text] { width: 100%; padding: 14px 16px; border: 1px solid #334155; border-radius: 12px; background: #020617; color: #f8fafc; box-sizing: border-box; }
      button { margin-top: 24px; padding: 14px 18px; border: 0; border-radius: 12px; background: #22c55e; color: #052e16; font-weight: 700; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <h1>Save Telegram Bot Token</h1>
      <p>This stores the bot token directly in Vault for <code>${team}/${service}</code>. The token is not echoed back into Claude or the dashboard.</p>
      <ol>
        <li>Paste the token from <code>@BotFather</code>.</li>
        <li>Click save.</li>
        <li>Go back to Claude and continue with <code>resume-openclaw-deploy</code>.</li>
      </ol>
      <form method="post" action="/api/vault-secrets/openclaw/intake">
        <input type="hidden" name="team" value="${team}" />
        <input type="hidden" name="service" value="${service}" />
        <input type="hidden" name="returnTo" value="${returnTo}" />
        <label for="telegram_bot_token">Telegram bot token</label>
        <input id="telegram_bot_token" name="telegram_bot_token" type="text" autocomplete="off" spellcheck="false" placeholder="123456789:AA..." />
        <button type="submit">Save Secret</button>
      </form>
    </main>
  </body>
</html>`;
}

export function renderOpenClawSavedPage(rawTeam: string, rawService: string): string {
  const team = escapeHtml(rawTeam);
  const service = escapeHtml(rawService);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Secret Saved</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f8fafc; color: #0f172a; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      main { max-width: 640px; padding: 32px; }
      code { background: #e2e8f0; padding: 2px 6px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Secret saved</h1>
      <p>The Telegram bot token for <code>${team}/${service}</code> is now stored in Vault.</p>
      <p>Return to Claude and continue with <code>resume-openclaw-deploy</code>.</p>
    </main>
  </body>
</html>`;
}
