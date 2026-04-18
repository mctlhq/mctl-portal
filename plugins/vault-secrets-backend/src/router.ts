import { Router, Request, Response, urlencoded } from 'express';
import fetch from 'node-fetch';
import type { Knex } from 'knex';
import {
  HttpAuthService,
  LoggerService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import { TenantStore } from '../../tenant-backend/src/tenantStore';

export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  store: TenantStore;
  db: Knex;
  isPostgres: boolean;
  vaultAddr: string;
  vaultToken: string;
  oidcLoginUrl: string;
}

type TenantAuthResult =
  | { ok: true; userId: string; role: string }
  | { ok: false; status: number; error: string };

export function createRouter(options: RouterOptions): Router {
  const { logger, httpAuth, userInfo, store, db, isPostgres, vaultAddr, vaultToken, oidcLoginUrl } = options;
  const router = Router();
  router.use(urlencoded({ extended: false }));

  router.get('/teams/:team/:app/database', async (req: Request, res: Response) => {
    const { team, app } = req.params;
    const auth = await requireTenantRole(req, httpAuth, userInfo, store, team, 'viewer');
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    try {
      const creds = await readVaultKV(vaultAddr, vaultToken, `platform/teams/${team}/${app}/database`);
      if (!creds) {
        res.status(404).json({ error: `No database found for ${team}/${app}` });
        return;
      }
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
    const { team, app } = req.params;
    const auth = await requireTenantRole(req, httpAuth, userInfo, store, team, 'viewer');
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }

    try {
      const secrets = await readVaultKV(vaultAddr, vaultToken, `teams/${team}/${app}`);
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

    const userId = await readOidcSessionUserId(req, db, isPostgres);
    if (!userId) {
      const selfUrl = buildSelfUrl(req);
      res.redirect(`${oidcLoginUrl}?returnTo=${encodeURIComponent(selfUrl)}`);
      return;
    }

    const auth = await checkTenantRole(store, team, userId, 'owner');
    if (!auth.ok) {
      res.status(auth.status).send(auth.error);
      return;
    }

    res.type('html').send(renderOpenClawIntakePage(team, service, returnTo));
  });

  router.post('/openclaw/intake', async (req: Request, res: Response) => {
    const team = String(req.body.team ?? '').trim();
    const service = String(req.body.service ?? '').trim();
    const returnTo = sanitizeReturnTo(String(req.body.returnTo ?? '').trim());
    const botToken = String(req.body.telegram_bot_token ?? '').trim();
    if (!team || !service) {
      res.status(400).send('Missing team or service');
      return;
    }
    if (!botToken) {
      res.status(400).send('Telegram bot token is required');
      return;
    }

    const userId = await readOidcSessionUserId(req, db, isPostgres);
    if (!userId) {
      res.status(401).send('Authentication required');
      return;
    }

    const auth = await checkTenantRole(store, team, userId, 'owner');
    if (!auth.ok) {
      res.status(auth.status).send(auth.error);
      return;
    }

    try {
      await writeVaultKV(vaultAddr, vaultToken, `teams/${team}/${service}/telegram`, {
        'telegram-bot-token': botToken,
      });
      if (returnTo) {
        const sep = returnTo.includes('?') ? '&' : '?';
        res.redirect(`${returnTo}${sep}telegram_saved=1`);
        return;
      }
      res.type('html').send(renderOpenClawSavedPage(team, service));
    } catch (err: any) {
      logger.error(`vault write failed for ${team}/${service}/telegram: ${err}`);
      res.status(502).send('Failed to save secret to Vault');
    }
  });

  return router;
}

async function requireTenantRole(
  req: Request,
  httpAuth: HttpAuthService,
  userInfo: UserInfoService,
  store: TenantStore,
  team: string,
  minimumRole: 'viewer' | 'owner',
): Promise<TenantAuthResult> {
  try {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
    const userId = extractUserId(ownershipEntityRefs);
    if (!userId) {
      return { ok: false, status: 401, error: 'Authentication required' };
    }
    return checkTenantRole(store, team, userId, minimumRole);
  } catch (err: any) {
    if (err?.name === 'AuthenticationError' || err?.message?.includes('auth')) {
      return { ok: false, status: 401, error: 'Authentication required' };
    }
    return { ok: false, status: 500, error: 'Internal authentication error' };
  }
}

async function checkTenantRole(
  store: TenantStore,
  team: string,
  userId: string,
  minimumRole: 'viewer' | 'owner',
): Promise<TenantAuthResult> {
  const member = await store.getMemberByTenant(team, userId.toLowerCase());
  if (!member) {
    return { ok: false, status: 403, error: `Access denied: not a member of team '${team}'` };
  }
  if (minimumRole === 'owner' && member.role !== 'owner') {
    return { ok: false, status: 403, error: `Access denied: owner role required for team '${team}'` };
  }
  return { ok: true, userId, role: member.role };
}

async function readOidcSessionUserId(
  req: Request,
  db: Knex,
  isPostgres: boolean,
): Promise<string | undefined> {
  const sessionId = parseCookie(req.headers.cookie ?? '', 'oidc_session');
  if (!sessionId) {
    return undefined;
  }
  const query = isPostgres
    ? db('oidc_sessions').withSchema('oidc-provider').where({ session_id: sessionId }).first()
    : db('oidc_sessions').where({ session_id: sessionId }).first();
  const row = await query;
  if (!row) {
    return undefined;
  }
  const expiresAt = Number(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return undefined;
  }
  return String(row.user_id);
}

function parseCookie(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function buildSelfUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
  return `${proto}://${host}${req.originalUrl}`;
}

function extractUserId(ownershipEntityRefs: string[]): string | undefined {
  const ref = ownershipEntityRefs.find(r => r.startsWith('user:default/'));
  return ref?.split('/').pop();
}

async function readVaultKV(vaultAddr: string, vaultToken: string, path: string): Promise<Record<string, string> | undefined> {
  const vaultResp = await fetch(`${vaultAddr}/v1/secret/data/${path}`, {
    headers: { 'X-Vault-Token': vaultToken },
  });
  if (vaultResp.status === 404) {
    return undefined;
  }
  if (!vaultResp.ok) {
    throw new Error(`Vault read failed: HTTP ${vaultResp.status}`);
  }
  const vaultData = (await vaultResp.json()) as any;
  return vaultData?.data?.data ?? undefined;
}

async function writeVaultKV(vaultAddr: string, vaultToken: string, path: string, data: Record<string, string>): Promise<void> {
  const vaultResp = await fetch(`${vaultAddr}/v1/secret/data/${path}`, {
    method: 'POST',
    headers: {
      'X-Vault-Token': vaultToken,
      'Content-Type': 'application/json',
    },
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

function renderOpenClawIntakePage(team: string, service: string, returnTo: string): string {
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

function renderOpenClawSavedPage(team: string, service: string): string {
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
