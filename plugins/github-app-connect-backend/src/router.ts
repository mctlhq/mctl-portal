import { Request, Response, Router } from 'express';
import express from 'express';
import Router_ from 'express-promise-router';
import { Logger } from 'winston';
import crypto from 'crypto';
import type { Knex } from 'knex';
import type {
  HttpAuthService,
  UserInfoService,
} from '@backstage/backend-plugin-api';
import type { NotificationService } from '@backstage/plugin-notifications-node';
import { getTenantMember, isAdminUser } from '../../tenant-backend/src/membershipLookup';
import { RepoConnectionStore } from './store';
import { isRepoBoundToTeam } from './bindingLookup';

// Format guards for user-supplied identifiers that flow into GitHub API URLs
// or GitOps repo file paths. Rejecting anything outside these shapes up
// front prevents SSRF-by-crafted-path and path traversal via `../`.
//
// Each repo segment must contain at least one non-dot character: `.` is in
// the legitimate charset (owner/repo names may contain dots), but a
// dot-only segment like `..` survives a plain charset check and WHATWG URL
// normalization then collapses it against the fixed `/repos/` prefix,
// shifting the request path — the residual traversal flagged in review
// round 2. GitHub itself forbids `.`/`..` as owner or repo names.
const REPO_FULL_NAME_RE = /^(?!\.+\/)[\w.-]+\/(?![\w.-]*\/)(?!\.+$)[\w.-]+$/;
const TEAM_OR_SERVICE_RE = /^[a-zA-Z0-9_-]+$/;
const GITHUB_LOGIN_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;

export interface RouterOptions {
  logger: Logger;
  store: RepoConnectionStore;
  appSlug: string;
  appId: string;
  privateKey: string;
  baseUrl: string;
  webhookSecret?: string;
  /**
   * Subject of the external-access token (backend.auth.externalAccess) that
   * may ask /repo-binding whether a repository is connected to a team. Unset:
   * the route refuses everyone.
   */
  bindingCheckSubject?: string;
  catalogClient?: { getEntities: (request: any) => Promise<any> };
  // Unused while auto-deploy is disabled (see POST /webhook); kept so the
  // plugin wiring does not change with it.
  scaffolderClient?: { createTask: (request: any) => Promise<any> };
  notifications?: NotificationService;
  httpAuth: HttpAuthService;
  userInfo: UserInfoService;
  db: Knex;
  isPostgres: boolean;
}

// Result of a caller-vs-team access check. Mirrors the shape of
// vault-secrets-backend's TenantAuthResult, but is implemented locally in
// this plugin (composing getTenantMember/isAdminUser directly) rather than
// importing vault-secrets-backend's requireTenantRole/checkTenantRole.
type CallerAuthResult =
  | { ok: true; userId: string; role: string; viaAdminBypass: boolean }
  | { ok: false; status: number; error: string };

// Resolves the calling Backstage user's GitHub login from the request's
// credentials, or undefined if there is no valid user identity attached.
async function resolveCallerUserId(
  req: Request,
  httpAuth: HttpAuthService,
  userInfo: UserInfoService,
): Promise<string | undefined> {
  try {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { ownershipEntityRefs } = await userInfo.getUserInfo(credentials);
    return extractUserId(ownershipEntityRefs);
  } catch {
    return undefined;
  }
}

function extractUserId(ownershipEntityRefs: string[]): string | undefined {
  const ref = ownershipEntityRefs.find(r => r.startsWith('user:default/'));
  return ref?.split('/').pop();
}

// Admin-bypass-then-membership check, given an already-resolved userId.
// Platform admins (owner role in the 'admins' tenant) bypass per-team
// membership, mirroring tenant-backend's isAdmin pattern in resolveAuth()
// and vault-secrets-backend's checkTenantRole.
export async function checkTeamAccess(
  db: Knex,
  isPostgres: boolean,
  team: string,
  userId: string,
): Promise<CallerAuthResult> {
  if (await isAdminUser(db, isPostgres, userId)) {
    return { ok: true, userId, role: 'owner', viaAdminBypass: true };
  }
  const member = await getTenantMember(db, isPostgres, team, userId.toLowerCase());
  if (!member) {
    return { ok: false, status: 403, error: `Access denied: not a member of team '${team}'` };
  }
  return { ok: true, userId, role: member.role, viaAdminBypass: false };
}

// Full request-level check for team-scoped routes: resolves the caller from
// the request, then applies checkTeamAccess with minimumRole 'viewer' (any
// team member, or a platform admin).
async function requireTeamAccess(
  req: Request,
  httpAuth: HttpAuthService,
  userInfo: UserInfoService,
  db: Knex,
  isPostgres: boolean,
  team: string,
): Promise<CallerAuthResult> {
  const userId = await resolveCallerUserId(req, httpAuth, userInfo);
  if (!userId) {
    return { ok: false, status: 401, error: 'Authentication required' };
  }
  return checkTeamAccess(db, isPostgres, team, userId);
}

/**
 * Audit trail for the admin-bypass path only: a platform admin reading
 * another team's repo connections, install status, or service config leaves
 * a trace, mirroring vault-secrets-backend's auditSecretRead. This plugin
 * never returns secret values (only repo names, connection status, env-var
 * names, and secret *key* names), so no redaction beyond what the routes
 * already return is needed.
 */
export function auditAdminBypass(
  logger: Logger,
  route: string,
  team: string,
  auth: { userId: string; viaAdminBypass: boolean },
  service?: string,
): void {
  if (!auth.viaAdminBypass) {
    return;
  }
  logger.info('github-app-connect admin bypass', {
    audit: 'admin_bypass',
    route,
    team,
    ...(service ? { service } : {}),
    user: auth.userId,
    via_admin_bypass: true,
  });
}

// State tokens: encrypted JSON with nonce + expiry
// Exported for unit testing (see router.test.ts).
export function encryptState(data: object, secret: string): string {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(secret, 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const payload = JSON.stringify({ ...data, exp: Date.now() + 10 * 60 * 1000 });
  let encrypted = cipher.update(payload, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

export function decryptState(token: string, secret: string): Record<string, unknown> | null {
  try {
    const [ivHex, encrypted] = token.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const key = crypto.scryptSync(secret, 'salt', 32);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    const data = JSON.parse(decrypted);
    if (data.exp && data.exp < Date.now()) {
      return null; // Expired
    }
    return data;
  } catch {
    return null;
  }
}

// Generate GitHub App installation token via JWT
async function getInstallationToken(
  installationId: number,
  appId: string,
  privateKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );

  if (!resp.ok) {
    throw new Error(`Failed to get installation token: ${resp.status}`);
  }
  const body = (await resp.json()) as { token: string };
  return body.token;
}

// List repos accessible to an installation. Every page is read; a failed
// page, a malformed answer or a list that grows past the cap throws, because
// a shorter list would read as a complete one (a sync replaces the team's
// bindings with it).
const INSTALLATION_REPOS_PAGE = 100;
const INSTALLATION_REPOS_MAX_PAGES = 30;

async function getInstallationRepos(
  installationId: number,
  appId: string,
  privateKey: string,
): Promise<string[]> {
  const token = await getInstallationToken(installationId, appId, privateKey);
  const names: string[] = [];
  for (let page = 1; page <= INSTALLATION_REPOS_MAX_PAGES; page++) {
    const resp = await fetch(
      `https://api.github.com/installation/repositories?per_page=${INSTALLATION_REPOS_PAGE}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (!resp.ok) {
      throw new Error(`GitHub answered ${resp.status} listing repositories of installation ${installationId}`);
    }
    const data = (await resp.json()) as { repositories?: Array<{ full_name?: unknown }> };
    if (!data || !Array.isArray(data.repositories)) {
      throw new Error(`Malformed repository list for installation ${installationId}`);
    }
    for (const r of data.repositories) {
      if (typeof r?.full_name !== 'string') {
        throw new Error(`Malformed repository entry for installation ${installationId}`);
      }
      names.push(r.full_name);
    }
    if (data.repositories.length < INSTALLATION_REPOS_PAGE) return names;
  }
  throw new Error(`Installation ${installationId} lists more than ${INSTALLATION_REPOS_PAGE * INSTALLATION_REPOS_MAX_PAGES} repositories`);
}

// Create a short-lived JWT for GitHub App API calls
function makeAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString('base64url');
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64url');
  return `${header}.${payload}.${signature}`;
}

// Find installation for a specific owner. With `strict`, any answer other than
// 200 or 404 throws instead of reading as "no installation": a caller that
// replaces stored bindings with the result must not mistake a GitHub outage
// for an owner without the App.
async function findInstallation(
  owner: string,
  appId: string,
  privateKey: string,
  strict = false,
): Promise<{ id: number; account_type: string } | null> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  // Try user installation first, then org
  for (const type of ['users', 'orgs']) {
    const resp = await fetch(
      `https://api.github.com/${type}/${owner}/installation`,
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (resp.ok) {
      const data = (await resp.json()) as { id: number; account: { type: string } };
      return {
        id: data.id,
        account_type: data.account.type.toLowerCase(),
      };
    }
    if (strict && resp.status !== 404) {
      throw new Error(`GitHub answered ${resp.status} looking up the ${type} installation of ${owner}`);
    }
  }
  return null;
}

type InstallationAccess = { ok: true; repos: string[] } | { ok: false; reason: string };

// Repository permissions that let a user read the repository.
const READ_PERMISSIONS = new Set(['admin', 'maintain', 'write', 'triage', 'read']);

// /callback asks GitHub once per repository of an organization installation.
// The checks run a few at a time, and an installation exposing more than the
// cap is refused with a reason rather than left to time out.
const PERMISSION_CHECK_CONCURRENCY = 8;
export const MAX_PERMISSION_CHECKS = 300;

/**
 * Decides which of `repos` (all reachable through installation
 * `installationId`) the portal user `user` may bind. /callback is reachable
 * without Backstage credentials and installation ids are small integers, so
 * the id in the query proves nothing on its own.
 *
 * - An installation on the user's own GitHub account: all of its repos.
 * - Any other installation (an organization): only the repos on which
 *   GitHub reports at least read permission for the user. Membership of the
 *   organization alone is not enough.
 *
 * Every failed or unreadable answer refuses the whole binding, including a
 * 403 because the App lacks the permission to answer.
 */
export async function resolveBindableRepos(options: {
  installationId: number;
  user: string;
  repos: string[];
  appId: string;
  privateKey: string;
}): Promise<InstallationAccess> {
  const { installationId, user, repos, appId, privateKey } = options;
  const instResp = await fetch(`https://api.github.com/app/installations/${installationId}`, {
    headers: { Authorization: `Bearer ${makeAppJwt(appId, privateKey)}`, Accept: 'application/vnd.github+json' },
  });
  if (!instResp.ok) {
    return { ok: false, reason: `installation lookup failed (${instResp.status})` };
  }
  const installation = (await instResp.json()) as { account?: { login?: string; type?: string } };
  const account = installation.account;
  if (!account?.login || !account.type) {
    return { ok: false, reason: 'installation has no account' };
  }
  if (account.type === 'User') {
    return account.login.toLowerCase() === user.toLowerCase()
      ? { ok: true, repos }
      : { ok: false, reason: `installation belongs to another user (${account.login})` };
  }

  if (repos.length > MAX_PERMISSION_CHECKS) {
    return {
      ok: false,
      reason: `installation exposes ${repos.length} repositories; select at most ${MAX_PERMISSION_CHECKS} on GitHub`,
    };
  }
  const token = await getInstallationToken(installationId, appId, privateKey);
  const unexpected = repos.find(repo => !REPO_FULL_NAME_RE.test(repo));
  if (unexpected !== undefined) {
    return { ok: false, reason: `unexpected repository name ${unexpected}` };
  }
  // readable[i] answers repos[i]; the first failure stops further checks.
  const readable: boolean[] = new Array(repos.length).fill(false);
  let failure: string | undefined;
  let next = 0;
  const worker = async () => {
    while (failure === undefined && next < repos.length) {
      const i = next++;
      const repo = repos[i];
      let resp: Awaited<ReturnType<typeof fetch>>;
      try {
        resp = await fetch(
          `https://api.github.com/repos/${repo}/collaborators/${encodeURIComponent(user)}/permission`,
          { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } },
        );
      } catch (err) {
        failure ??= `permission check for ${repo} failed (${err})`;
        throw err;
      }
      if (resp.status === 404) {
        continue; // GitHub's answer for a user without access to this repository
      }
      if (!resp.ok) {
        failure ??= `permission check for ${repo} failed (${resp.status})`;
        return;
      }
      const body = (await resp.json()) as { permission?: unknown };
      if (typeof body.permission !== 'string') {
        failure ??= `malformed permission answer for ${repo}`;
        return;
      }
      readable[i] = READ_PERMISSIONS.has(body.permission);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PERMISSION_CHECK_CONCURRENCY, repos.length) }, () => worker()),
  );
  if (failure !== undefined) {
    return { ok: false, reason: failure };
  }
  const bindable = repos.filter((_repo, i) => readable[i]);
  return bindable.length > 0
    ? { ok: true, repos: bindable }
    : { ok: false, reason: 'user has read access to none of the installation\'s repositories' };
}

export function createRouter(options: RouterOptions): Router {
  const { logger, store, appSlug, appId, privateKey, baseUrl, webhookSecret, bindingCheckSubject, catalogClient, notifications, httpAuth, userInfo, db, isPostgres } = options;
  // Derive the state key from the full private key (full entropy) rather than
  // a low-entropy PEM-header prefix. 64 hex chars keeps the existing shape.
  //
  // No legacy-key fallback: state tokens expire after 10 minutes, so a
  // rolling deploy just fails in-flight installs with "Invalid or expired
  // state parameter" and the user retries. A fallback keyed on the old
  // low-entropy derivation would reintroduce the vulnerability this fixes
  // and, since anyone holding that key can forge the token's own `exp`
  // claim, would stay exploitable indefinitely rather than for one deploy
  // cycle.
  const stateSecret = crypto.createHash('sha256').update(privateKey).digest('hex');
  const decodeState = (token: string): Record<string, unknown> | null =>
    decryptState(token, stateSecret);

  const router = Router_();

  async function findInstallationById(
    installationId: number,
  ): Promise<{ id: number; account_type: string } | null> {
    const resp = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: { Authorization: `Bearer ${makeAppJwt(appId, privateKey)}`, Accept: 'application/vnd.github+json' },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { id: number; account?: { type?: string } };
    return { id: data.id, account_type: (data.account?.type ?? 'unknown').toLowerCase() };
  }

  // GET /install-url — returns GitHub App install URL with encrypted state
  router.get('/install-url', async (req: Request, res: Response) => {
    const { team, service, repo } = req.query;
    if (!team || !service || !repo) {
      res.status(400).json({ error: 'Missing required params: team, service, repo' });
      return;
    }
    if (typeof repo !== 'string' || !REPO_FULL_NAME_RE.test(repo)) {
      res.status(400).json({ error: 'Invalid repo parameter, expected format owner/name' });
      return;
    }

    const auth = await requireTeamAccess(req, httpAuth, userInfo, db, isPostgres, team as string);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    auditAdminBypass(logger, '/install-url', team as string, auth, service as string);

    const state = encryptState(
      { team, service, repo, user: auth.userId, nonce: crypto.randomBytes(8).toString('hex') },
      stateSecret,
    );

    const installUrl = `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`;
    res.json({ url: installUrl, state });
  });

  // GET /repo-binding?team=<team>&repo=<owner/name> — for mctl-api's build
  // gate: is the repository connected to the team by a verified binding?
  // Only the configured external-access principal may ask.
  router.get('/repo-binding', async (req: Request, res: Response) => {
    let subject: string | undefined;
    try {
      const credentials = await httpAuth.credentials(req, { allow: ['service'] });
      subject = (credentials.principal as { subject?: string }).subject;
    } catch {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    // A static external-access token carries the configured subject as it is;
    // a jwks one carries `external:<sub>`. Both are the configured principal;
    // a plugin-to-plugin credential (`plugin:<id>`) is neither.
    if (
      !bindingCheckSubject ||
      (subject !== bindingCheckSubject && subject !== `external:${bindingCheckSubject}`)
    ) {
      res.status(403).json({ error: 'Not allowed' });
      return;
    }
    const team = req.query.team;
    const repo = req.query.repo;
    if (typeof team !== 'string' || !TEAM_OR_SERVICE_RE.test(team)) {
      res.status(400).json({ error: 'Missing or invalid param: team' });
      return;
    }
    if (typeof repo !== 'string' || !REPO_FULL_NAME_RE.test(repo)) {
      res.status(400).json({ error: 'Missing or invalid param: repo (owner/name)' });
      return;
    }
    const bound = await isRepoBoundToTeam(db, isPostgres, team, repo);
    res.json({ team, repo, bound });
  });

  // GET /popup-state?team=<team> — state for the repo picker's install popup.
  // Binds the popup's callback to this team and to the calling user.
  router.get('/popup-state', async (req: Request, res: Response) => {
    const team = req.query.team as string | undefined;
    if (!team || !TEAM_OR_SERVICE_RE.test(team)) {
      res.status(400).json({ error: 'Missing or invalid param: team' });
      return;
    }
    const auth = await requireTeamAccess(req, httpAuth, userInfo, db, isPostgres, team);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    auditAdminBypass(logger, '/popup-state', team, auth);
    const state = encryptState(
      { popup: true, team, user: auth.userId, nonce: crypto.randomBytes(8).toString('hex') },
      stateSecret,
    );
    res.json({
      state,
      url: `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(state)}`,
    });
  });

  // GET /popup-done — shown inside popup after GitHub App install
  // Posts repos to parent window and closes itself
  router.get('/popup-done', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html>
<head><title>Access granted</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5">
  <div style="text-align:center;padding:2rem;background:#fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <div style="font-size:2rem;margin-bottom:.5rem">✅</div>
    <div style="font-weight:600;margin-bottom:.25rem">Access granted!</div>
    <div style="color:#666;font-size:.875rem">This window will close automatically…</div>
    <div id="manual" style="display:none;margin-top:1rem">
      <button onclick="window.close()" style="padding:.5rem 1.25rem;border:none;border-radius:4px;background:#1976d2;color:#fff;cursor:pointer;font-size:.875rem">
        Close this window
      </button>
    </div>
  </div>
  <script>
    var msg = { type: 'github-repos-updated' };
    // 1. BroadcastChannel — works even when opener is lost after redirect chain
    try {
      var bc = new BroadcastChannel('mctl-github-repos');
      bc.postMessage(msg);
      setTimeout(function() { bc.close(); }, 2000);
    } catch(e) {}
    // 2. postMessage to opener as fallback
    try {
      if (window.opener) { window.opener.postMessage(msg, '*'); }
    } catch(e) {}
    // 3. Close the popup
    setTimeout(function() {
      window.close();
      // If still open, show manual close button
      setTimeout(function() {
        var el = document.getElementById('manual');
        if (el) el.style.display = 'block';
      }, 600);
    }, 300);
  </script>
</body>
</html>`);
  });

  // GET /callback — GitHub redirects here after App installation.
  //
  // Reachable without Backstage credentials, so it only records a connection
  // when the encrypted state (minted by /install-url or /popup-state for an
  // authenticated team member) names the team and user, and only for the
  // repositories that user may read (resolveBindableRepos). Without a
  // valid state, nothing is recorded: repos are connected from the portal,
  // where /repos/sync runs as the signed-in user.
  router.get('/callback', async (req: Request, res: Response) => {
    const { installation_id, state: stateParam } = req.query;
    if (!installation_id) {
      res.status(400).json({ error: 'Missing installation_id' });
      return;
    }
    const installId = Number(installation_id);
    if (!Number.isSafeInteger(installId) || installId <= 0) {
      res.status(400).json({ error: 'Invalid installation_id' });
      return;
    }

    const rawState = typeof stateParam === 'string' ? stateParam : undefined;
    // Legacy plain "popup[:team]" states carried no proof; treat them, and a
    // direct install from GitHub, as "installed, connect from the portal".
    if (!rawState || rawState === 'popup' || rawState.startsWith('popup:')) {
      logger.info(`Installation ${installId} callback without portal state; nothing recorded`);
      res.redirect(
        rawState
          ? `${baseUrl}/api/github-app-connect/popup-done`
          : `${baseUrl}/create?status=connected&message=${encodeURIComponent('GitHub App installed. Connect repositories from the portal repository picker.')}`,
      );
      return;
    }

    const stateData = decodeState(rawState);
    const team = stateData?.team;
    const user = stateData?.user;
    if (!stateData || typeof team !== 'string' || typeof user !== 'string') {
      res.status(400).json({ error: 'Invalid or expired state parameter' });
      return;
    }
    const isPopup = stateData.popup === true;
    const failRedirect = (message: string) =>
      isPopup
        ? `${baseUrl}/api/github-app-connect/popup-done`
        : `${baseUrl}/create?status=error&message=${encodeURIComponent(message)}`;

    let installationRepos: string[];
    try {
      installationRepos = await getInstallationRepos(installId, appId, privateKey);
    } catch (err) {
      logger.error(`Failed to list repos of installation ${installId}: ${err}`);
      res.redirect(failRedirect('Failed to read the installation. Please try again.'));
      return;
    }

    let wanted = installationRepos;
    if (!isPopup) {
      const repo = stateData.repo;
      if (typeof repo !== 'string' || typeof stateData.service !== 'string') {
        res.status(400).json({ error: 'Invalid or expired state parameter' });
        return;
      }
      wanted = installationRepos.filter(r => r.toLowerCase() === repo.toLowerCase());
      if (wanted.length === 0) {
        logger.warn(`Installation ${installId} does not have access to ${repo}`);
        res.redirect(
          failRedirect(`Installation does not have access to ${repo}. Please add the repository in GitHub App settings.`),
        );
        return;
      }
    }

    let access: InstallationAccess;
    try {
      access = await resolveBindableRepos({ installationId: installId, user, repos: wanted, appId, privateKey });
    } catch (err) {
      access = { ok: false, reason: `verification error: ${err}` };
    }
    if (!access.ok) {
      logger.warn(`Installation ${installId} not recorded for team=${team} user=${user}: ${access.reason}`);
      res.redirect(failRedirect('Could not confirm that you can read these repositories.'));
      return;
    }
    const repos = access.repos;

    const installation = await findInstallationById(installId);
    const accountType = installation?.account_type || 'unknown';

    if (isPopup) {
      for (const repoFullName of repos) {
        await store.upsert({
          team_id: team,
          service_id: '_auto',
          repo_full_name: repoFullName,
          installation_id: installId,
          account_type: accountType,
          created_by: `popup:${user}`,
        });
      }
      logger.info(`Popup installation ${installId} (team=${team}, user=${user}) — ${repos.length} repo(s)`);
      res.redirect(`${baseUrl}/api/github-app-connect/popup-done`);
      return;
    }

    const service = stateData.service as string;
    const repo = repos[0];
    await store.upsert({
      team_id: team,
      service_id: service,
      repo_full_name: repo,
      installation_id: installId,
      account_type: accountType,
      created_by: `callback:${user}`,
    });
    logger.info(`Repo connection saved: ${team}/${service} → ${repo} (installation ${installId}, user ${user})`);
    res.redirect(`${baseUrl}/create?status=connected&repo=${encodeURIComponent(repo)}`);
  });

  // GET /repo-access — check if a repo is accessible via App or PAT
  router.get('/repo-access', async (req: Request, res: Response) => {
    const { team, service, repo } = req.query;
    if (!team || !service || !repo) {
      res.status(400).json({ error: 'Missing required params: team, service, repo' });
      return;
    }
    if (typeof repo !== 'string' || !REPO_FULL_NAME_RE.test(repo)) {
      res.status(400).json({ error: 'Invalid repo parameter, expected format owner/name' });
      return;
    }

    const auth = await requireTeamAccess(req, httpAuth, userInfo, db, isPostgres, team as string);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    auditAdminBypass(logger, '/repo-access', team as string, auth, service as string);

    // Only this team's own connections count. Another team's connection for
    // the same repo, or an installation on the repo owner, says nothing about
    // whether this team may use the repo.
    const connection =
      (await store.find(team as string, service as string, repo as string)) ??
      (await store.findByTeamAndRepo(team as string, repo as string));

    if (connection) {
      // Verify the installation still has access
      try {
        const repos = await getInstallationRepos(
          connection.installation_id,
          appId,
          privateKey,
        );
        const hasAccess = repos.some(
          r => r.toLowerCase() === (repo as string).toLowerCase(),
        );
        if (hasAccess) {
          res.json({
            status: 'connected',
            method: 'github_app',
            installation_id: connection.installation_id,
          });
          return;
        }
        // Installation lost access — clean up
        logger.warn(
          `Installation ${connection.installation_id} lost access to ${repo}`,
        );
      } catch (err) {
        logger.warn(`Failed to verify installation: ${err}`);
      }
    }

    // Check if repo is public
    try {
      const publicCheck = await fetch(
        `https://api.github.com/repos/${repo}`,
        { headers: { Accept: 'application/vnd.github+json' } },
      );
      if (publicCheck.ok) {
        const repoData = (await publicCheck.json()) as { private: boolean };
        if (!repoData.private) {
          res.json({ status: 'accessible', method: 'public' });
          return;
        }
      }
    } catch {
      // ignore
    }

    res.json({
      status: 'needs_install',
      method: 'none',
      install_url: `https://github.com/apps/${appSlug}/installations/new`,
    });
  });

  // GET /install-status — for CLI polling
  router.get('/install-status', async (req: Request, res: Response) => {
    const { team, service, repo, state: stateParam } = req.query;

    // If state is provided, decrypt it for params
    let teamId = team as string;
    let serviceId = service as string;
    let repoName = repo as string;

    if (stateParam) {
      const stateData = decodeState(stateParam as string);
      if (stateData) {
        teamId = teamId || (stateData.team as string);
        serviceId = serviceId || (stateData.service as string);
        repoName = repoName || (stateData.repo as string);
      }
    }

    if (!teamId || !serviceId || !repoName) {
      res.status(400).json({ error: 'Missing params: team, service, repo' });
      return;
    }

    const auth = await requireTeamAccess(req, httpAuth, userInfo, db, isPostgres, teamId);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    auditAdminBypass(logger, '/install-status', teamId, auth, serviceId);

    const connection = await store.find(teamId, serviceId, repoName);
    if (connection) {
      res.json({ status: 'connected', connection });
    } else {
      res.json({ status: 'pending' });
    }
  });

  // GET /repos — list repos from DB only (team-scoped, no global fallback)
  // DB is populated by /repos/sync and /callback flows
  router.get('/repos', async (req: Request, res: Response) => {
    try {
      const team = req.query.team as string | undefined;

      const userId = await resolveCallerUserId(req, httpAuth, userInfo);
      if (!userId) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      let rows: Array<{ repo_full_name: string }>;
      if (team) {
        const auth = await checkTeamAccess(db, isPostgres, team, userId);
        if (!auth.ok) {
          res.status(auth.status).json({ error: auth.error });
          return;
        }
        auditAdminBypass(logger, '/repos', team, auth);
        rows = await store.findVerifiedByTeam(team);
      } else {
        // Omitting team used to fall back to all installations across every
        // team. That is a cross-tenant leak once anonymous access is
        // removed, so it is now restricted to platform admins.
        if (!(await isAdminUser(db, isPostgres, userId))) {
          res.status(400).json({ error: 'Missing required param: team' });
          return;
        }
        auditAdminBypass(logger, '/repos', '_all', { userId, viaAdminBypass: true });
        rows = await store.findAllVerified();
      }

      // The bound repositories themselves, not everything their installations
      // can see.
      const allRepos = [...new Set(rows.map(r => r.repo_full_name))].sort();
      res.json({ repos: allRepos });
    } catch (err) {
      logger.error(`Failed to list repos: ${err}`);
      res.status(500).json({ repos: [] });
    }
  });

  // POST /repos/sync?team=<teamId>&user=<githubLogin> — sync repos for a team
  // admins team: user's personal install + Organization installs
  // other teams: user's personal install only (org repos added explicitly via popup)
  router.post('/repos/sync', async (req: Request, res: Response) => {
    const team = req.query.team as string | undefined;
    const user = req.query.user as string | undefined;
    if (!team) {
      res.status(400).json({ error: 'Missing required param: team' });
      return;
    }
    if (!user) {
      res.status(400).json({ error: 'Missing required param: user' });
      return;
    }
    if (!GITHUB_LOGIN_RE.test(user)) {
      res.status(400).json({ error: 'Invalid user parameter' });
      return;
    }
    const auth = await requireTeamAccess(req, httpAuth, userInfo, db, isPostgres, team);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    if (!auth.viaAdminBypass && auth.userId.toLowerCase() !== user.toLowerCase()) {
      res.status(403).json({ error: 'user parameter must match the authenticated caller' });
      return;
    }
    auditAdminBypass(logger, '/repos/sync', team, auth);
    try {
      const installMap = new Map<number, { account_type: string; login: string }>();

      // For admins: also include all Organization installations
      if (team === 'admins') {
        const jwt = makeAppJwt(appId, privateKey);
        const instResp = await fetch(
          'https://api.github.com/app/installations?per_page=100',
          { headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json' } },
        );
        if (!instResp.ok) {
          // The sync below replaces the team's rows with what it found, so a
          // partial picture must not get that far.
          throw new Error(`GitHub answered ${instResp.status} listing the App installations`);
        }
        const all = (await instResp.json()) as Array<{ id: number; account: { login: string; type: string } }>;
        for (const inst of all) {
          if (inst.account.type.toLowerCase() === 'organization') {
            installMap.set(inst.id, { account_type: 'organization', login: inst.account.login });
          }
        }
      }

      // Always include the user's personal installation
      const userInstallation = await findInstallation(user, appId, privateKey, true);
      if (userInstallation) {
        installMap.set(userInstallation.id, {
          account_type: userInstallation.account_type,
          login: user,
        });
      }

      // Rows written by a verified flow whose installation this sync does not
      // list again (a popup/callback binding of selected organization repos,
      // another member's sync) are carried over exactly as they are. They are
      // never expanded to everything their installation can see: the user
      // who bound them could read only some of it. This read only decides
      // whether there is anything to do; replaceTeam re-reads them inside
      // its transaction.
      if (installMap.size === 0) {
        const verified = await store.findVerifiedByTeam(team);
        if (verified.length === 0) {
          logger.info(`No GitHub App installations found for sync, team=${team}, user=${user}`);
          res.json({ repos: [] });
          return;
        }
      }

      // Fetch repos from the installations this sync lists again. Any failure
      // fails the sync before a row is touched.
      const entries = Array.from(installMap.entries());
      const repoResults = await Promise.all(
        entries.map(async ([instId, meta]) => {
          const repos = await getInstallationRepos(instId, appId, privateKey);
          return repos.map(r => ({ repo: r, instId, ...meta }));
        }),
      );
      const allRepoEntries = repoResults.flat();

      // Replace the team's rows in one transaction (clean slate per sync,
      // carried rows kept). The fresh listing is written last, so where both
      // name a repository the installation the user owns wins.
      const carried = await store.replaceTeam(
        team,
        new Set(installMap.keys()),
        allRepoEntries.map(entry => ({
          team_id: team,
          service_id: '_auto',
          repo_full_name: entry.repo,
          installation_id: entry.instId,
          account_type: entry.account_type,
          created_by: `sync:${auth.userId.toLowerCase()}`,
        })),
      );
      const allRepos = [...new Set([...allRepoEntries.map(e => e.repo), ...carried.map(r => r.repo_full_name)])].sort();
      const instSummary = [...entries.map(([id, m]) => `${m.login}(${id})`), `${carried.length} carried rows`].join(', ');
      logger.info(`Synced ${allRepos.length} repos for team=${team} from installations: ${instSummary}`);
      res.json({ repos: allRepos });
    } catch (err) {
      logger.error(`Failed to sync repos for team=${team}: ${err}`);
      res.status(500).json({ repos: [] });
    }
  });

  // GET /repo-tags?team=<team>&repo=owner/name
  // Returns tags of a repository connected to the team (or of a public
  // repository), newest first. Platform admins may read any repository the
  // App can see.
  router.get('/repo-tags', async (req: Request, res: Response) => {
    const { repo: repoFullName, team } = req.query;
    if (!repoFullName || typeof repoFullName !== 'string') {
      res.status(400).json({ error: 'Missing required param: repo (owner/name)' });
      return;
    }
    if (!REPO_FULL_NAME_RE.test(repoFullName)) {
      res.status(400).json({ error: 'Invalid repo parameter, expected format owner/name' });
      return;
    }
    if (!team || typeof team !== 'string' || !TEAM_OR_SERVICE_RE.test(team)) {
      res.status(400).json({ error: 'Missing or invalid param: team' });
      return;
    }

    const auth = await requireTeamAccess(req, httpAuth, userInfo, db, isPostgres, team);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    auditAdminBypass(logger, '/repo-tags', team, auth);

    try {
      let installationId: number | undefined;
      const connection = await store.findByTeamAndRepo(team, repoFullName);
      if (connection) {
        installationId = Number(connection.installation_id);
      } else if (auth.viaAdminBypass) {
        const [owner] = repoFullName.split('/');
        installationId = (await findInstallation(owner, appId, privateKey))?.id;
      }

      const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
      if (installationId !== undefined) {
        headers.Authorization = `Bearer ${await getInstallationToken(installationId, appId, privateKey)}`;
      } else {
        // Not connected to the team: only a public repository may be read,
        // and without the App's credentials.
        const pub = await fetch(`https://api.github.com/repos/${repoFullName}`, { headers });
        const pubData = pub.ok ? ((await pub.json()) as { private?: boolean }) : undefined;
        if (!pubData || pubData.private !== false) {
          res.status(404).json({ error: 'Repository is not connected to this team' });
          return;
        }
      }

      // Fetch up to 100 tags
      const resp = await fetch(
        `https://api.github.com/repos/${repoFullName}/tags?per_page=100`,
        { headers },
      );
      if (!resp.ok) {
        res.status(502).json({ error: `Failed to fetch repo tags (${resp.status})` });
        return;
      }

      const data = (await resp.json()) as Array<{ name: string }>;
      res.json({ tags: data.map(t => t.name) });
    } catch (err) {
      logger.error(`Failed to fetch repo tags: ${err}`);
      res.status(500).json({ error: 'Failed to fetch repo tags' });
    }
  });

  // GET /service-config?team=<team>&service=<service>
  // Returns current env vars and secret keys from the service's values.yaml
  router.get('/service-config', async (req: Request, res: Response) => {
    const { team, service } = req.query;
    if (!team || !service) {
      res.status(400).json({ error: 'Missing required params: team, service' });
      return;
    }
    if (!TEAM_OR_SERVICE_RE.test(team as string) || !TEAM_OR_SERVICE_RE.test(service as string)) {
      res.status(400).json({ error: 'Invalid team or service parameter' });
      return;
    }

    const auth = await requireTeamAccess(req, httpAuth, userInfo, db, isPostgres, team as string);
    if (!auth.ok) {
      res.status(auth.status).json({ error: auth.error });
      return;
    }
    auditAdminBypass(logger, '/service-config', team as string, auth, service as string);

    try {
      const owner = 'mctlhq';
      const repo = 'mctl-gitops';
      const filePath = `platform-gitops/services/${team}/${service}/values.yaml`;

      const installation = await findInstallation(owner, appId, privateKey);
      if (!installation) {
        res.status(404).json({ error: 'No GitHub App installation found' });
        return;
      }
      const token = await getInstallationToken(installation.id, appId, privateKey);

      const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=main`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3.raw',
          },
        },
      );

      if (!resp.ok) {
        res.json({ envVars: '', secretKeys: [] });
        return;
      }

      const yaml = await resp.text();

      // Parse env vars from "env:" block
      const envLines: string[] = [];
      const lines = yaml.split('\n');
      let inEnv = false;
      for (const line of lines) {
        if (/^env:/.test(line)) {
          inEnv = true;
          continue;
        }
        if (inEnv) {
          if (/^\S/.test(line)) break; // next top-level key
          const m = line.match(/^\s+(\w+):\s*"?(.+?)"?\s*$/);
          if (m) envLines.push(`${m[1]}=${m[2]}`);
        }
      }

      // Parse secret keys from "externalSecret.data[].secretKey"
      const secretKeys: string[] = [];
      let inExtSecret = false;
      for (const line of lines) {
        if (/^externalSecret:/.test(line)) {
          inExtSecret = true;
          continue;
        }
        if (inExtSecret && /^\S/.test(line)) {
          inExtSecret = false;
          continue;
        }
        if (inExtSecret) {
          const m = line.match(/secretKey:\s*(\S+)/);
          if (m) secretKeys.push(m[1]);
        }
      }

      res.json({
        envVars: envLines.join('\n'),
        secretKeys,
      });
    } catch (err) {
      logger.error(`Failed to fetch service config: ${err}`);
      res.status(500).json({ error: 'Failed to fetch service config' });
    }
  });

  // POST /webhook — GitHub App webhook handler for auto-deploy on tag push
  router.post('/webhook', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
    // Verify HMAC signature
    if (!webhookSecret) {
      logger.warn('Webhook received but GITHUB_WEBHOOK_SECRET not configured');
      res.status(500).json({ error: 'Webhook secret not configured' });
      return;
    }

    const signature = req.headers['x-hub-signature-256'] as string;
    if (!signature) {
      res.status(401).json({ error: 'Missing signature' });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
    const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    const provided = Buffer.from(signature);
    const wanted = Buffer.from(expected);
    // timingSafeEqual throws on a length mismatch, which used to surface as a 500.
    if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const payload = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString()) : req.body;
    const event = req.headers['x-github-event'] as string;

    // Only handle tag creation events
    if (event !== 'create' || payload.ref_type !== 'tag') {
      res.status(200).json({ ignored: true, reason: `event=${event} ref_type=${payload.ref_type}` });
      return;
    }

    const repoFullName = payload.repository?.full_name;
    const tagName = payload.ref;
    logger.info(`Webhook: tag "${tagName}" created in ${repoFullName}`);

    if (!catalogClient) {
      logger.warn('Webhook: catalog client not available, skipping');
      res.status(200).json({ accepted: true, repo: repoFullName, tag: tagName });
      return;
    }

    // The catalog lookup is in-cluster and fast, so it runs before the reply
    // (GitHub allows 10s): a refused auto-deploy is then visible in the
    // App's delivery log, not only in ours.
    let items: any[];
    try {
      const entities = await catalogClient.getEntities({
        filter: {
          kind: 'Component',
          'metadata.annotations.github.com/source-repo': repoFullName,
        },
      });
      items = entities.items ?? [];
    } catch (err) {
      logger.error(`Webhook: catalog lookup failed for ${repoFullName}: ${err}`);
      res.status(502).json({ error: 'Catalog lookup failed' });
      return;
    }

    // "true"/"auto" asked for an immediate deploy; "confirm" = notify only;
    // "false"/missing = skip.
    const modeOf = (entity: any) => {
      const autoDeploy = entity.metadata?.annotations?.['mctl.me/auto-deploy'];
      return autoDeploy === 'true' || autoDeploy === 'auto' ? 'auto' : autoDeploy === 'confirm' ? 'confirm' : null;
    };
    const refOf = (entity: any) => `component:${entity.metadata.namespace || 'default'}/${entity.metadata.name}`;

    // Auto-deploy is disabled pending a scoped design: a deploy needs an
    // initiating user that mctl:workflow:submit can authorize, and a webhook
    // has none. Refuse it here, where it is triggered, instead of creating a
    // task that can only fail.
    const autoRefused = items.filter(e => modeOf(e) === 'auto').map(refOf);
    if (autoRefused.length > 0) {
      logger.warn(
        `Webhook: auto-deploy is disabled pending a scoped design; not deploying ${autoRefused.join(', ')} @ ${tagName}. Deploy it with the deploy-version template.`,
      );
      res.status(422).json({
        error: 'Auto-deploy is disabled; deploy from the catalog',
        components: autoRefused,
        repo: repoFullName,
        tag: tagName,
      });
    } else {
      res.status(200).json({ accepted: true, repo: repoFullName, tag: tagName });
    }

    // Async: notify owners
    try {
      if (items.length === 0) {
        logger.info(`Webhook: no component found for repo ${repoFullName}, skipping`);
        return;
      }

      for (const entity of items) {
        const autoDeploy = entity.metadata?.annotations?.['mctl.me/auto-deploy'];
        const mode = modeOf(entity);
        const entityRef = `component:${entity.metadata.namespace || 'default'}/${entity.metadata.name}`;
        const ownerRef = entity.spec?.owner as string | undefined;

        // Send notification for any matched component (regardless of mode)
        if (notifications) {
          const ns = entity.metadata.namespace || 'default';
          const name = entity.metadata.name;
          // Resolve ownerRef to full entity ref (e.g. "group:admin" → "group:default/admin")
          let resolvedRecipient: string | undefined;
          if (ownerRef) {
            if (ownerRef.includes('/')) {
              resolvedRecipient = ownerRef; // already fully qualified
            } else if (ownerRef.includes(':')) {
              const [kind, n] = ownerRef.split(':');
              resolvedRecipient = `${kind}:${ns}/${n}`;
            } else {
              resolvedRecipient = `group:${ns}/${ownerRef}`;
            }
          }

          const title = mode === 'auto'
            ? `Auto-deploy disabled: ${name} ${tagName} not deployed`
            : mode === 'confirm'
              ? `New version available: ${name} ${tagName}`
              : `New tag ${tagName} for ${name}`;
          const description = mode === 'auto'
            ? `Tag ${tagName} pushed to ${repoFullName}. Auto-deploy (mctl.me/auto-deploy) is disabled; deploy it from the catalog.`
            : mode === 'confirm'
              ? `Tag ${tagName} pushed to ${repoFullName}. Approve deployment from the catalog.`
              : `Tag ${tagName} was created in ${repoFullName}.`;

          try {
            await notifications.send({
              recipients: resolvedRecipient
                ? { type: 'entity', entityRef: resolvedRecipient }
                : { type: 'broadcast' },
              payload: {
                title,
                description,
                link: mode === 'confirm' || mode === 'auto'
                  ? `/create/templates/default/deploy-version?${new URLSearchParams({ serviceName: entityRef, gitTag: tagName }).toString()}`
                  : `/catalog/${ns}/component/${name}`,
                topic: `deploy:${ns}/${name}`,
                severity: mode === 'auto' ? 'high' : 'low',
              },
            });
            logger.info(`Webhook: notification sent for ${entityRef}@${tagName} to ${resolvedRecipient || 'broadcast'}`);
          } catch (notifyErr) {
            logger.warn(`Webhook: failed to send notification: ${notifyErr}`);
          }
        }

        if (!mode) {
          logger.info(`Webhook: ${entityRef} has auto-deploy=${autoDeploy}, skipping deploy`);
          continue;
        }

        if (mode === 'confirm') {
          logger.info(`Webhook: [CONFIRM] ${entityRef}@${tagName} ready to deploy — approve via Backstage UI`);
        }
      }
    } catch (err) {
      logger.error(`Webhook notification failed: ${err}`);
    }
  });

  return router;
}
