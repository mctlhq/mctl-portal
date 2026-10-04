import { Request, Response, Router } from 'express';
import express from 'express';
import Router_ from 'express-promise-router';
import { v4 as uuid } from 'uuid';
import { LoggerService } from '@backstage/backend-plugin-api';
import { KeyStore } from './keyStore';
import { OidcStore } from './oidcStore';
import { OIDC_SESSION_COOKIE, parseCookie } from './sessionAuth';

/** Session cookie of a forward-auth protected host (host-only on that host). */
export const FORWARD_AUTH_SESSION_COOKIE = '__Host-mctl_forward_auth';

/** Short-lived cookie binding a forward-auth sign-in to the browser that started it. */
export const FORWARD_AUTH_STATE_COOKIE = '__Host-mctl_forward_auth_state';

/** Path on a protected host that receives the one-time code. */
export const FORWARD_AUTH_CALLBACK_PATH = '/.mctl-auth/callback';

/**
 * Prefix of the cookie binding a GitHub sign-in to the browser that started
 * it. The full name carries the OAuth state, so sign-ins started in parallel
 * tabs do not overwrite each other.
 */
export const LOGIN_STATE_COOKIE_PREFIX = '__Host-oidc_login_';

const FORWARD_AUTH_CODE_TTL_MS = 60 * 1000;
const FORWARD_AUTH_STATE_MAX_AGE_SECONDS = 10 * 60;
const LOGIN_STATE_MAX_AGE_SECONDS = 10 * 60;
const STATE_RE = /^[A-Za-z0-9-]{16,128}$/;

// Tenant and service names as they appear in hostnames: one lowercase DNS
// label each (the vault-secrets SLUG_RE shape, minus a trailing hyphen), so
// <tenant>-<service>.<base domain> is always a plain hostname. Exported for
// unit testing.
export const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,29}[a-z0-9])?$/;

/** Registered OIDC client (ArgoCD Dex, Argo Workflows, etc.) */
export interface OidcClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
}

/** Abstraction over tenant_members queries (cross-schema) */
export interface MembershipLookup {
  getUserGroups(userId: string): Promise<string[]>;
  userExists(userId: string): Promise<boolean>;
  getUserRole(userId: string, tenantName: string): Promise<string | null>;
  tenantExists(tenantName: string): Promise<boolean>;
}

/**
 * A host protected by /forward-auth in addition to the canonical
 * <tenant>-<service>.<base domain> host, e.g. a friendly alias.
 */
export interface ForwardAuthHost {
  tenant: string;
  service: string;
  host: string;
}

export interface RouterOptions {
  logger: LoggerService;
  membership: MembershipLookup;
  keyStore: KeyStore;
  issuer: string;
  clients: OidcClient[];
  githubClientId: string;
  githubClientSecret: string;
  store: OidcStore;
  forwardAuthHosts?: ForwardAuthHost[];
}

export function createRouter(options: RouterOptions): Router {
  const { logger, membership, keyStore, issuer, clients, githubClientId, githubClientSecret, store } = options;
  const router = Router_();
  const forwardAuthHosts = validateForwardAuthHosts(options.forwardAuthHosts ?? [], issuer);

  // Body parsers for token (urlencoded) endpoint
  router.use(express.json());
  router.use(express.urlencoded({ extended: true }));

  // Derive the GitHub OAuth callback URL from the issuer
  const githubCallbackUrl = `${issuer}/github/callback`;

  // Cleanup expired entries every 60 seconds
  setInterval(() => {
    store.cleanupExpired().catch(err => {
      logger.warn(`[OIDC] Cleanup error: ${err?.message}`);
    });
  }, 60_000);

  // ── Helper: find registered client ──────────────────────────────────
  function findClient(clientId: string): OidcClient | undefined {
    return clients.find(c => c.clientId === clientId);
  }

  // Also binds the GitHub state to this browser with a host-only cookie, so
  // a callback URL started by someone else cannot sign this browser in to
  // their account (login CSRF).
  function buildGitHubAuthRedirect(res: Response, returnTo: string): Promise<string> {
    const githubState = uuid();
    appendSetCookie(
      res,
      buildHostOnlyCookie(`${LOGIN_STATE_COOKIE_PREFIX}${githubState}`, '1', LOGIN_STATE_MAX_AGE_SECONDS),
    );
    return store
      .savePendingAuth(githubState, returnTo, Date.now() + 10 * 60 * 1000)
      .then(() => {
        const githubAuthUrl = new URL('https://github.com/login/oauth/authorize');
        githubAuthUrl.searchParams.set('client_id', githubClientId);
        githubAuthUrl.searchParams.set('redirect_uri', githubCallbackUrl);
        githubAuthUrl.searchParams.set('scope', 'read:user');
        githubAuthUrl.searchParams.set('state', githubState);
        return githubAuthUrl.toString();
      });
  }

  function readSessionCookie(
    req: Request,
  ): Promise<{ sessionId: string; userId: string; expiresAt: number } | undefined> {
    const sessionId = parseCookie(req.headers.cookie ?? '', OIDC_SESSION_COOKIE);
    if (!sessionId) {
      return Promise.resolve(undefined);
    }
    return store.getSession(sessionId).then(session =>
      session ? { sessionId, ...session } : undefined,
    );
  }

  function deriveTenantBaseDomain(): string | null {
    const issuerHost = new URL(issuer).hostname.toLowerCase();
    if (issuerHost === 'app.mctl.ai') {
      return 'mctl.ai';
    }
    if (issuerHost === 'app.mctl.me') {
      return 'mctl.me';
    }
    if (issuerHost.startsWith('app.')) {
      return issuerHost.slice(4);
    }
    return null;
  }

  function buildTenantServiceHost(tenant: string, service: string): string | null {
    if (!NAME_RE.test(tenant) || !NAME_RE.test(service)) {
      return null;
    }
    const baseDomain = deriveTenantBaseDomain();
    if (!baseDomain) {
      return null;
    }
    return `${tenant}-${service}.${baseDomain}`.toLowerCase();
  }

  function buildTenantServiceUrl(tenant: string, service: string): string | null {
    const host = buildTenantServiceHost(tenant, service);
    return host ? `https://${host}/` : null;
  }

  // A forward-auth host is registered for exactly one tenant and service:
  // an alias configured under oidcProvider.forwardAuth.hosts belongs only to
  // its configured pair, and any other host only to the pair whose
  // canonical <tenant>-<service> join it is. Returns the parsed hostname, or
  // null when rawHost is not a plain hostname registered to the pair. Codes
  // and sessions are only ever issued for and bound to that parsed host, so
  // a browser can never be sent to, or a credential bound to, a host the
  // tenant/service pair does not own.
  function resolveForwardAuthHost(tenant: string, service: string, rawHost: string): string | null {
    const host = parseHostname(rawHost);
    if (!host) {
      return null;
    }
    const alias = forwardAuthHosts.find(h => h.host === host);
    if (alias) {
      return alias.tenant === tenant && alias.service === service ? host : null;
    }
    return host === buildTenantServiceHost(tenant, service) ? host : null;
  }

  // <tenant>-<service> joins are ambiguous: tenant "a" + service "b-c" and
  // tenant "a-b" + service "c" share a-b-c.<base domain>. Before a code is
  // sent to a canonical host, make sure no other existing tenant could be
  // the owner of that hostname.
  async function isAmbiguousCanonicalHost(tenant: string, service: string, host: string): Promise<boolean> {
    if (forwardAuthHosts.some(h => h.host === host)) {
      return false;
    }
    const label = `${tenant}-${service}`;
    for (let i = label.indexOf('-'); i !== -1; i = label.indexOf('-', i + 1)) {
      const otherTenant = label.slice(0, i);
      const otherService = label.slice(i + 1);
      if (otherTenant === tenant || !NAME_RE.test(otherTenant) || !NAME_RE.test(otherService)) {
        continue;
      }
      if (await membership.tenantExists(otherTenant)) {
        return true;
      }
    }
    return false;
  }

  function readForwardAuthSession(
    req: Request,
    binding: { tenant: string; service: string; host: string },
  ): Promise<{ userId: string } | undefined> {
    const sessionId = parseCookie(req.headers.cookie ?? '', FORWARD_AUTH_SESSION_COOKIE);
    if (!sessionId) {
      return Promise.resolve(undefined);
    }
    return store.getForwardAuthSession(sessionId).then(async session => {
      if (
        !session ||
        session.expiresAt <= Date.now() ||
        session.tenant !== binding.tenant ||
        session.service !== binding.service ||
        session.host !== binding.host
      ) {
        return undefined;
      }
      // A host session lives only as long as the portal session it was
      // derived from: deleting that row revokes every host session too.
      const portal = await store.getSession(session.portalSessionId);
      if (!portal || portal.expiresAt <= Date.now() || portal.userId !== session.userId) {
        return undefined;
      }
      return { userId: session.userId };
    });
  }

  function summarizeUrlHost(urlValue: string): string {
    try {
      return new URL(urlValue).host;
    } catch {
      return 'invalid';
    }
  }

  // ── OIDC Discovery ──────────────────────────────────────────────────
  router.get('/.well-known/openid-configuration', (_req: Request, res: Response) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      userinfo_endpoint: `${issuer}/userinfo`,
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      scopes_supported: ['openid', 'profile', 'email', 'groups'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      claims_supported: [
        'sub',
        'name',
        'email',
        'email_verified',
        'preferred_username',
        'groups',
        'iss',
        'aud',
        'exp',
        'iat',
      ],
    });
  });

  // ── JWKS ────────────────────────────────────────────────────────────
  router.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
    res.json(keyStore.getJWKS());
  });

  // ── Authorize ───────────────────────────────────────────────────────
  // GET /authorize?response_type=code&client_id=X&redirect_uri=Y&scope=Z&state=S&nonce=N
  //
  // Called by Dex. If a valid session cookie exists, immediately issues an
  // authorization code. Otherwise initiates GitHub OAuth to authenticate the user.
  router.get('/authorize', async (req: Request, res: Response) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      scope: _scope,
      state,
      nonce,
    } = req.query as Record<string, string>;

    if (response_type !== 'code') {
      res.status(400).json({ error: 'unsupported_response_type' });
      return;
    }

    const client = findClient(client_id);
    if (!client) {
      res.status(400).json({ error: 'invalid_client', error_description: `Unknown client_id: ${client_id}` });
      return;
    }

    if (!client.redirectUris.includes(redirect_uri)) {
      res.status(400).json({
        error: 'invalid_redirect_uri',
        error_description: `Redirect URI not registered: ${redirect_uri}`,
      });
      return;
    }

    // Check session cookie. Lax is no CSRF boundary between *.mctl.ai
    // hosts, so the cookie only mints a code for a top-level navigation.
    const session = await readSessionCookie(req);

    if (session && session.expiresAt > Date.now()) {
      if (!isNavigationRequest(req)) {
        res.status(403).json({ error: 'access_denied', error_description: 'Navigation required' });
        return;
      }
      // User already authenticated — issue authorization code immediately
      const code = uuid();
      await store.saveCode(code, {
        userId: session.userId,
        clientId: client_id,
        redirectUri: redirect_uri,
        expiresAt: Date.now() + 5 * 60 * 1000,
        nonce,
      });
      const url = new URL(redirect_uri);
      url.searchParams.set('code', code);
      if (state) url.searchParams.set('state', state);
      res.redirect(url.toString());
      return;
    }

    // No session — start GitHub OAuth flow.
    // Store the original /authorize URL so we can return to it after GitHub callback.
    res.redirect(await buildGitHubAuthRedirect(res, req.originalUrl));
  });

  // ── Browser Login Helper ───────────────────────────────────────────
  // GET /login?returnTo=https://tenant-service.mctl.ai/
  //
  // Used by Traefik ForwardAuth flows where we need an interactive login
  // redirect instead of OIDC authorization-code issuance to a registered client.
  //
  // returnTo is allowlisted: only relative paths and https://mctl.ai /
  // https://*.mctl.ai absolute URLs are honored. Anything else (wrong
  // scheme, unrelated host, lookalike host such as mctl.ai.evil.example)
  // falls back to DEFAULT_POST_LOGIN_PATH before it is redirected to or
  // persisted via store.savePendingAuth, so this endpoint cannot be used
  // as an open redirect. Do not reintroduce raw returnTo usage here.
  router.get('/login', async (req: Request, res: Response) => {
    const rawReturnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo.trim() : '';
    if (!rawReturnTo) {
      res.status(400).send('Missing returnTo');
      return;
    }
    const returnTo = sanitizeReturnTo(rawReturnTo);
    if (returnTo !== rawReturnTo) {
      logger.warn(`[OIDC] /login rejected disallowed returnTo host=${summarizeUrlHost(rawReturnTo)}`);
    }
    // The portal session cookie is host-only: it is never re-issued here for
    // a returnTo on another host. A forward-auth protected returnTo gets its
    // own host-bound session through /forward-auth/authorize instead.
    const session = await readSessionCookie(req);
    if (session && session.expiresAt > Date.now()) {
      res.redirect(returnTo);
      return;
    }
    res.redirect(await buildGitHubAuthRedirect(res, returnTo));
  });

  // ── Browser Tenant Login Helper ───────────────────────────────────
  // GET /tenant-login?tenant=<tenant>&service=<service>
  //
  // Browser-only convenience endpoint for tenant dashboards. It resolves
  // the final tenant URL and only uses GitHub OAuth for the human-facing
  // navigation flow. Traefik forward-auth should continue to use /forward-auth.
  router.get('/tenant-login', async (req: Request, res: Response) => {
    const tenant = typeof req.query.tenant === 'string' ? req.query.tenant.trim().toLowerCase() : '';
    const service = typeof req.query.service === 'string' ? req.query.service.trim() : '';

    if (!tenant || !service) {
      res.status(400).send('Missing tenant or service');
      return;
    }
    if (!NAME_RE.test(tenant) || !NAME_RE.test(service)) {
      res.status(400).send('Invalid tenant or service');
      return;
    }

    const tenantUrl = buildTenantServiceUrl(tenant, service);
    if (!tenantUrl) {
      res.status(400).send('Cannot determine tenant URL');
      return;
    }

    const session = await readSessionCookie(req);
    if (session && session.expiresAt > Date.now()) {
      const role = await membership.getUserRole(session.userId, tenant);
      if (!role) {
        res.status(403).send('Access denied');
        return;
      }
      res.redirect(tenantUrl);
      return;
    }

    res.redirect(await buildGitHubAuthRedirect(res, tenantUrl));
  });

  // ── OpenAI Codex OAuth Callback ───────────────────────────────────
  // GET /openai-codex/callback?code=<code>&state=<state>
  //
  // OpenAI redirects here after the tenant dashboard starts the OAuth flow.
  // We keep this callback on the control-plane host so the OAuth client only
  // needs one registered redirect URI, then bounce the browser back to the
  // originating tenant dashboard with the same state/code payload.
  router.get('/openai-codex/callback', async (req: Request, res: Response) => {
    const state = typeof req.query.state === 'string' ? req.query.state.trim() : '';
    const code = typeof req.query.code === 'string' ? req.query.code.trim() : '';
    const error = typeof req.query.error === 'string' ? req.query.error.trim() : '';
    const errorDescription =
      typeof req.query.error_description === 'string' ? req.query.error_description.trim() : '';
    if (!state) {
      logger.warn('[OIDC] OpenAI Codex callback missing state');
      res.status(400).send('Missing state');
      return;
    }
    const returnTo = decodeOpenAICodexReturnTo(state);
    if (!returnTo) {
      logger.warn('[OIDC] OpenAI Codex callback invalid state envelope');
      res.status(400).send('Invalid OpenAI Codex callback state');
      return;
    }
    logger.info(
      `[OIDC] OpenAI Codex callback received returnToHost=${summarizeUrlHost(returnTo)} code=${
        code ? 'present' : 'missing'
      } error=${error || 'none'}`,
    );
    const url = new URL(returnTo);
    if (code) {
      url.searchParams.set('code', code);
    }
    url.searchParams.set('state', state);
    if (error) {
      url.searchParams.set('error', error);
    }
    if (errorDescription) {
      url.searchParams.set('error_description', errorDescription);
    }
    logger.info(
      `[OIDC] OpenAI Codex callback redirecting to returnToHost=${url.host} code=${
        code ? 'present' : 'missing'
      } error=${error || 'none'}`,
    );
    res.redirect(url.toString());
  });

  // ── GitHub OAuth Callback ────────────────────────────────────────────
  // GET /github/callback?code=X&state=Y
  //
  // GitHub redirects here after the user authorizes. We exchange the code
  // for a token, fetch the GitHub username, verify DB membership, create
  // a session cookie, then redirect back to the original /authorize URL.
  router.get('/github/callback', async (req: Request, res: Response) => {
    const { code, state, error } = req.query as Record<string, string>;

    if (error) {
      logger.warn(`[OIDC] GitHub OAuth error: ${error}`);
      res.status(400).send(`GitHub OAuth error: ${error}`);
      return;
    }

    if (!code || !state) {
      res.status(400).send('Missing code or state');
      return;
    }

    const loginStateCookie = `${LOGIN_STATE_COOKIE_PREFIX}${state}`;
    if (!STATE_RE.test(state) || parseCookie(req.headers.cookie ?? '', loginStateCookie) !== '1') {
      res.status(400).send('This sign-in was not started in this browser. Please try again.');
      return;
    }

    const pending = await store.consumePendingAuth(state);
    if (!pending || pending.expiresAt < Date.now()) {
      res.status(400).send('Invalid or expired OAuth state. Please try again.');
      return;
    }

    // Exchange code for GitHub access token
    let githubToken: string;
    try {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: githubClientId,
          client_secret: githubClientSecret,
          code,
          redirect_uri: githubCallbackUrl,
        }),
      });
      const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
      if (!tokenData.access_token) {
        throw new Error(tokenData.error ?? 'No access_token in response');
      }
      githubToken = tokenData.access_token;
    } catch (err: any) {
      logger.error(`[OIDC] GitHub token exchange failed: ${err?.message}`);
      res.status(500).send('GitHub token exchange failed');
      return;
    }

    // Fetch GitHub user info
    let githubLogin: string;
    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: 'application/vnd.github+json',
        },
      });
      if (!userRes.ok) throw new Error(`GitHub API error: HTTP ${userRes.status}`);
      const userData = await userRes.json() as { login: string };
      githubLogin = userData.login.toLowerCase();
    } catch (err: any) {
      logger.error(`[OIDC] GitHub user fetch failed: ${err?.message}`);
      res.status(500).send('Failed to fetch GitHub user info');
      return;
    }

    // Verify user is a member of a tenant
    const exists = await membership.userExists(githubLogin);
    if (!exists) {
      res.status(403).send(
        `Access denied: GitHub user "${githubLogin}" is not a member of any team. ` +
        `Register at mctl.me first.`,
      );
      return;
    }

    // Create OIDC session
    const sessionId = uuid();
    await store.saveSession(sessionId, githubLogin, Date.now() + 8 * 60 * 60 * 1000);

    logger.info(`[OIDC] GitHub OAuth login: ${githubLogin}`);

    // Set session cookie and redirect back to original /authorize URL
    // /authorize will now see the session and issue the auth code to Dex.
    // The cookie is host-only on the portal whatever returnTo points at.
    res.setHeader('Set-Cookie', [
      buildHostOnlyCookie(OIDC_SESSION_COOKIE, sessionId, 28800),
      buildHostOnlyCookie(loginStateCookie, '', 0),
    ]);
    res.redirect(pending.returnTo);
  });

  // ── Token ───────────────────────────────────────────────────────────
  // POST /token  (application/x-www-form-urlencoded)
  // grant_type=authorization_code&code=X&redirect_uri=Y&client_id=Z&client_secret=S
  router.post('/token', async (req: Request, res: Response) => {
    const { grant_type, code, redirect_uri, client_id, client_secret } =
      req.body;

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    // Authenticate client
    const client = findClient(client_id);
    if (!client || client.clientSecret !== client_secret) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }

    // Validate code (consumeCode is single-use: returns and deletes)
    const codeData = await store.consumeCode(code);
    if (!codeData) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Code not found or expired' });
      return;
    }

    if (codeData.clientId !== client_id || codeData.redirectUri !== redirect_uri) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'client_id or redirect_uri mismatch' });
      return;
    }

    if (codeData.expiresAt < Date.now()) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
      return;
    }

    // Look up user groups
    const groups = await membership.getUserGroups(codeData.userId);

    // Build claims
    const claims: Record<string, unknown> = {
      sub: codeData.userId,
      name: codeData.userId,
      preferred_username: codeData.userId,
      email: `${codeData.userId}@mctl.me`,
      email_verified: true,
      groups,
    };
    if (codeData.nonce) {
      claims.nonce = codeData.nonce;
    }

    // Sign ID token
    const idToken = await keyStore.sign(
      { ...claims, iss: issuer, aud: client_id },
      '8h',
    );

    // Access token (opaque, maps to user for /userinfo)
    const accessToken = uuid();
    await store.saveAccessToken(accessToken, codeData.userId, Date.now() + 8 * 60 * 60 * 1000);

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 28800,
      id_token: idToken,
      scope: 'openid profile email groups',
    });

    logger.info(
      `[OIDC] Issued token for ${codeData.userId} → client ${client_id}, groups: [${groups.join(', ')}]`,
    );
  });

  // ── UserInfo ────────────────────────────────────────────────────────
  router.get('/userinfo', async (req: Request, res: Response) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    const token = auth.slice(7);
    const data = await store.getAccessToken(token);
    if (!data || data.expiresAt < Date.now()) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }

    const groups = await membership.getUserGroups(data.userId);

    res.json({
      sub: data.userId,
      name: data.userId,
      preferred_username: data.userId,
      email: `${data.userId}@mctl.me`,
      email_verified: true,
      groups,
    });
  });

  // ── Traefik ForwardAuth ────────────────────────────────────────────
  // GET /forward-auth?tenant=<tenant>&service=<service>
  //
  // Called by Traefik for every request to a protected host, with the
  // browser's Cookie header and X-Forwarded-Host / X-Forwarded-Uri describing
  // that request. The portal session cookie is host-only and never reaches a
  // protected host; each protected host has its own session cookie instead,
  // bound to that exact tenant, service and host, and established by a
  // one-time code:
  //
  //   1. no valid host session -> 302 to /forward-auth/authorize on the
  //      portal, with a state cookie set on the protected host;
  //   2. the portal (with its own session) redirects back to
  //      https://<host>/.mctl-auth/callback?code=...&state=...;
  //   3. that request is answered here as well: the code is redeemed and the
  //      host session cookie set. It never reaches the upstream service.
  //
  // The tenant and service come from the Middleware address, not from the
  // browser, and are what every code and session is bound to. Traefik must
  // call this endpoint directly (in-cluster service address) so that
  // X-Forwarded-Host and X-Forwarded-Uri are the ones it set.
  router.get('/forward-auth', async (req: Request, res: Response) => {
    const tenant = typeof req.query.tenant === 'string' ? req.query.tenant.trim().toLowerCase() : '';
    const service =
      (typeof req.query.service === 'string' ? req.query.service.trim().toLowerCase() : '') || 'openclaw';
    if (!tenant) {
      res.status(400).send('Missing tenant');
      return;
    }
    if (!NAME_RE.test(tenant) || !NAME_RE.test(service)) {
      res.status(400).send('Invalid tenant or service');
      return;
    }

    const forwardedHost = readForwardedHost(req);
    const host = resolveForwardAuthHost(tenant, service, forwardedHost);
    if (!host) {
      logger.warn(
        `[OIDC] ForwardAuth refused unregistered host=${forwardedHost || 'missing'} tenant=${tenant} service=${service}`,
      );
      res.status(403).send('Access denied');
      return;
    }
    const binding = { tenant, service, host };
    const forwardedUri = readForwardedUri(req);

    if (forwardedUri.pathname === FORWARD_AUTH_CALLBACK_PATH) {
      await completeForwardAuthSignIn(req, res, binding, forwardedUri);
      return;
    }

    const session = await readForwardAuthSession(req, binding);
    if (!session) {
      // Only a top-level navigation starts sign-in. XHR, WebSocket and
      // asset requests from another open tab get a plain 401 and leave the
      // state cookie of an in-flight sign-in alone.
      if (!isNavigationRequest(req)) {
        res.status(401).send('Authentication required');
        return;
      }
      // Reuse a state cookie this browser still holds, so two sign-ins
      // started from parallel tabs can both complete.
      const existingState = parseCookie(req.headers.cookie ?? '', FORWARD_AUTH_STATE_COOKIE) ?? '';
      const state = STATE_RE.test(existingState) ? existingState : uuid();
      const authorizeUrl = new URL(`${issuer}/forward-auth/authorize`);
      authorizeUrl.searchParams.set('tenant', tenant);
      authorizeUrl.searchParams.set('service', service);
      authorizeUrl.searchParams.set('host', host);
      authorizeUrl.searchParams.set('state', state);
      authorizeUrl.searchParams.set('returnPath', sanitizeReturnPath(forwardedUri.pathname + forwardedUri.search));
      if (state !== existingState) {
        res.setHeader(
          'Set-Cookie',
          buildHostOnlyCookie(FORWARD_AUTH_STATE_COOKIE, state, FORWARD_AUTH_STATE_MAX_AGE_SECONDS),
        );
      }
      res.redirect(authorizeUrl.toString());
      return;
    }

    const role = await membership.getUserRole(session.userId, tenant);
    if (!role) {
      logger.warn(`[OIDC] ForwardAuth denied: user=${session.userId} tenant=${tenant} service=${service}`);
      res.status(403).send('Access denied');
      return;
    }

    res.setHeader('X-Forwarded-User', session.userId);
    res.setHeader('X-Mctl-Team-Role', role);
    res.setHeader('X-Auth-Request-User', session.userId);
    res.status(200).send('ok');
  });

  async function completeForwardAuthSignIn(
    req: Request,
    res: Response,
    binding: { tenant: string; service: string; host: string },
    forwardedUri: URL,
  ): Promise<void> {
    const code = forwardedUri.searchParams.get('code') ?? '';
    const state = forwardedUri.searchParams.get('state') ?? '';
    const stateCookie = parseCookie(req.headers.cookie ?? '', FORWARD_AUTH_STATE_COOKIE) ?? '';
    // The state cookie was set on this host when the flow started, so a code
    // obtained by someone else cannot be planted in this browser.
    if (!code || !state || state !== stateCookie) {
      res.status(400).send('Invalid sign-in callback');
      return;
    }
    const issued = await store.consumeForwardAuthCode(code);
    const now = Date.now();
    if (
      !issued ||
      issued.expiresAt <= now ||
      issued.sessionExpiresAt <= now ||
      issued.state !== state ||
      issued.tenant !== binding.tenant ||
      issued.service !== binding.service ||
      issued.host !== binding.host
    ) {
      logger.warn(
        `[OIDC] ForwardAuth callback rejected host=${binding.host} tenant=${binding.tenant} service=${binding.service}`,
      );
      res.status(400).send('Invalid or expired sign-in code. Please try again.');
      return;
    }

    // The host session never outlives the portal session it came from.
    const sessionId = uuid();
    await store.saveForwardAuthSession(sessionId, {
      userId: issued.userId,
      portalSessionId: issued.portalSessionId,
      tenant: binding.tenant,
      service: binding.service,
      host: binding.host,
      expiresAt: issued.sessionExpiresAt,
    });
    logger.info(
      `[OIDC] ForwardAuth session for ${issued.userId} host=${binding.host} tenant=${binding.tenant} service=${binding.service}`,
    );

    res.setHeader('Set-Cookie', [
      buildHostOnlyCookie(
        FORWARD_AUTH_SESSION_COOKIE,
        sessionId,
        Math.floor((issued.sessionExpiresAt - now) / 1000),
      ),
      buildHostOnlyCookie(FORWARD_AUTH_STATE_COOKIE, '', 0),
    ]);
    // Absolute: Traefik resolves a relative Location against this
    // endpoint's own address, not against the protected host.
    res.redirect(`https://${binding.host}${sanitizeReturnPath(issued.returnPath)}`);
  }

  // ── Forward-auth Authorize ─────────────────────────────────────────
  // GET /forward-auth/authorize?tenant=&service=&host=&state=&returnPath=
  //
  // Runs on the portal host with the portal session. Issues a short-lived,
  // single-use code bound to tenant, service, host and state, and sends it
  // to the protected host's callback path. Only registered hosts are
  // accepted, so this cannot be used to send a code anywhere else.
  router.get('/forward-auth/authorize', async (req: Request, res: Response) => {
    const param = (name: string) => (typeof req.query[name] === 'string' ? (req.query[name] as string).trim() : '');
    const tenant = param('tenant').toLowerCase();
    const service = param('service').toLowerCase();
    const state = param('state');
    const returnPath = sanitizeReturnPath(param('returnPath'));

    const host = resolveForwardAuthHost(tenant, service, param('host'));
    if (!host || (await isAmbiguousCanonicalHost(tenant, service, host))) {
      logger.warn(
        `[OIDC] ForwardAuth authorize refused host=${summarizeUrlHost(`https://${param('host')}`)} tenant=${tenant.slice(0, 64)} service=${service.slice(0, 64)}`,
      );
      res.status(400).send('Unknown protected host');
      return;
    }
    if (!STATE_RE.test(state)) {
      res.status(400).send('Missing or invalid state');
      return;
    }

    const session = await readSessionCookie(req);
    if (!session || session.expiresAt <= Date.now()) {
      res.redirect(await buildGitHubAuthRedirect(res, req.originalUrl));
      return;
    }

    // Lax is no CSRF boundary between *.mctl.ai hosts: only a top-level
    // navigation may mint a code with the portal cookie.
    if (!isNavigationRequest(req)) {
      res.status(403).send('Navigation required');
      return;
    }

    const role = await membership.getUserRole(session.userId, tenant);
    if (!role) {
      logger.warn(`[OIDC] ForwardAuth authorize denied: user=${session.userId} tenant=${tenant} service=${service}`);
      res.status(403).send('Access denied');
      return;
    }

    const code = uuid();
    await store.saveForwardAuthCode(code, {
      userId: session.userId,
      portalSessionId: session.sessionId,
      tenant,
      service,
      host,
      state,
      returnPath,
      sessionExpiresAt: session.expiresAt,
      expiresAt: Date.now() + FORWARD_AUTH_CODE_TTL_MS,
    });
    const callbackUrl = new URL(`https://${host}${FORWARD_AUTH_CALLBACK_PATH}`);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);
    res.redirect(callbackUrl.toString());
  });

  // ── Health ──────────────────────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  return router;
}

// ── Helpers ─────────────────────────────────────────────────────────────

// Default post-login target used whenever a /login returnTo is rejected by
// isAllowedReturnTo. Always same-origin (resolved relative to the issuer by
// the browser), so it can never itself become an open redirect.
const DEFAULT_POST_LOGIN_PATH = '/';

// Allowlist for /login's returnTo: relative paths, or absolute https URLs
// whose hostname is exactly mctl.ai or ends with .mctl.ai (dot-boundary
// suffix match). Exported for unit testing.
//
// mctl.me is deliberately NOT allowlisted (operator decision at the
// audit-wave-3 approve gate): the domain itself was retired on 2026-08-28
// — mctl-gitops#934 removed its mirror and DNS, so nothing resolvable
// serves *.mctl.me anymore. This repository still carries stale mctl.me
// references (app-config domainAlt/argocd/argoWorkflows URLs, the
// tenant-backend workflow links, and the .mctl.me branches in this file);
// their removal is tracked as a separate portal cleanup issue and none of
// them makes the domain reachable. Allowlisting an unregistered-able
// domain here would hand an open redirect to whoever re-registers it.
// If a *.mctl.me environment is ever resurrected, allowlisting it must
// be a deliberate edit.
export function isAllowedReturnTo(returnTo: string): boolean {
  // ASCII control characters (tab, CR, LF, ...) are stripped by browsers
  // when following a Location header, so "/\t/evil.example" would collapse
  // into scheme-relative "//evil.example" AFTER passing the prefix checks
  // below. No legitimate returnTo contains control characters — reject
  // outright before any shape check.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(returnTo)) {
    return false;
  }
  // Relative path: allowed, but must not be scheme-relative ("//host/...")
  // or a backslash variant ("/\host/...") that some browsers normalize to
  // scheme-relative.
  if (returnTo.startsWith('/') && !returnTo.startsWith('//') && !returnTo.startsWith('/\\')) {
    return true;
  }
  try {
    const url = new URL(returnTo);
    if (url.protocol !== 'https:') {
      return false;
    }
    const host = url.hostname.toLowerCase();
    return host === 'mctl.ai' || host.endsWith('.mctl.ai');
  } catch {
    return false;
  }
}

// Returns returnTo unchanged if allowed, otherwise DEFAULT_POST_LOGIN_PATH.
// Exported for unit testing.
export function sanitizeReturnTo(returnTo: string): string {
  return isAllowedReturnTo(returnTo) ? returnTo : DEFAULT_POST_LOGIN_PATH;
}

// Every cookie this provider sets is host-only: __Host- prefixed, Secure,
// Path=/ and without a Domain attribute, so the browser returns it only to
// the exact host that set it and no sibling *.mctl.ai host can set or
// shadow it. Never add a Domain attribute here. Exported for unit testing.
export function buildHostOnlyCookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, maxAgeSeconds)}`,
  ].join('; ');
}

function appendSetCookie(res: Response, cookie: string): void {
  const existing = res.getHeader('Set-Cookie') ?? [];
  const list = Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader('Set-Cookie', [...list, cookie]);
}

// A top-level browser navigation. Sec-Fetch-Mode is authoritative where the
// browser sends it; without it, fall back to whether the request accepts an
// HTML document. Exported for unit testing.
export function isNavigationRequest(req: Request): boolean {
  const mode = firstHeaderValue(req.headers['sec-fetch-mode']).toLowerCase();
  if (mode) {
    return mode === 'navigate';
  }
  return firstHeaderValue(req.headers.accept).toLowerCase().includes('text/html');
}

// The hostname of rawHost if, and only if, rawHost is a plain hostname:
// no port, path, query, fragment, userinfo, backslash or encoding that URL
// parsing would rewrite. Exported for unit testing.
export function parseHostname(rawHost: string): string | null {
  const raw = rawHost.trim().toLowerCase();
  if (!raw || raw.endsWith('.')) {
    return null;
  }
  try {
    const url = new URL(`https://${raw}`);
    // Userinfo, ports, paths and anything URL would rewrite all make
    // url.host differ from the raw value.
    if (url.host !== raw || url.hostname !== raw) {
      return null;
    }
    return url.hostname;
  } catch {
    return null;
  }
}

// Fails startup on a forward-auth alias list that is malformed or
// ambiguous: every entry needs DNS-label tenant/service names and a plain
// hostname under the portal's base domain (never the portal host itself),
// and no host may be listed twice. Exported for unit testing.
export function validateForwardAuthHosts(hosts: ForwardAuthHost[], issuer: string): ForwardAuthHost[] {
  const issuerHost = new URL(issuer).hostname.toLowerCase();
  const baseDomain = issuerHost.startsWith('app.') ? issuerHost.slice(4) : issuerHost;
  const seen = new Set<string>();
  for (const h of hosts) {
    const label = `oidcProvider.forwardAuth.hosts entry ${JSON.stringify(h)}`;
    if (!NAME_RE.test(h.tenant) || !NAME_RE.test(h.service)) {
      throw new Error(`${label}: tenant and service must be lowercase DNS labels`);
    }
    if (parseHostname(h.host) !== h.host || !h.host.endsWith(`.${baseDomain}`) || h.host === issuerHost) {
      throw new Error(`${label}: host must be a plain hostname under ${baseDomain}, other than ${issuerHost}`);
    }
    if (seen.has(h.host)) {
      throw new Error(`${label}: host is listed more than once`);
    }
    seen.add(h.host);
  }
  return hosts;
}

function firstHeaderValue(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return (first ?? '').split(',')[0].trim();
}

// Host of the request Traefik is authorizing, as sent. Anything that is not
// a plain registered hostname fails resolveForwardAuthHost.
function readForwardedHost(req: Request): string {
  return firstHeaderValue(req.headers['x-forwarded-host']);
}

function readForwardedUri(req: Request): URL {
  const raw = firstHeaderValue(req.headers['x-forwarded-uri']) || '/';
  try {
    return new URL(raw.startsWith('/') ? raw : '/', 'https://forwarded.invalid');
  } catch {
    return new URL('/', 'https://forwarded.invalid');
  }
}

// Post-sign-in path on a protected host: only a same-host absolute path is
// kept (same rules as relative returnTo values), and never the callback
// path itself. Exported for unit testing.
export function sanitizeReturnPath(path: string): string {
  if (
    !path ||
    path.length > 2048 ||
    !path.startsWith('/') ||
    !isAllowedReturnTo(path) ||
    path.startsWith(FORWARD_AUTH_CALLBACK_PATH)
  ) {
    return DEFAULT_POST_LOGIN_PATH;
  }
  return path;
}

function decodeOpenAICodexReturnTo(state: string): string | null {
  try {
    const json = Buffer.from(state, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { returnTo?: unknown };
    const returnTo = typeof parsed.returnTo === 'string' ? parsed.returnTo.trim() : '';
    if (!returnTo) {
      return null;
    }
    const url = new URL(returnTo);
    const host = url.hostname.toLowerCase();
    // .mctl.me removed from this trust list together with the /login
    // allowlist above: the domain is retired (mctl-gitops#934), and a
    // retired domain kept as a trusted redirect target is exactly the
    // open-redirect-by-reregistration hazard this PR closes.
    if (host === 'localhost' || host.endsWith('.mctl.ai')) {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}
