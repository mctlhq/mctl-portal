import { Request, Response, Router } from 'express';
import express from 'express';
import Router_ from 'express-promise-router';
import { v4 as uuid } from 'uuid';
import { LoggerService } from '@backstage/backend-plugin-api';
import { KeyStore } from './keyStore';
import { OidcStore } from './oidcStore';

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
}

export function createRouter(options: RouterOptions): Router {
  const { logger, membership, keyStore, issuer, clients, githubClientId, githubClientSecret, store } = options;
  const router = Router_();

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

  function buildGitHubAuthRedirect(returnTo: string): Promise<string> {
    const githubState = uuid();
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

  function deriveCookieDomain(urlValue: string): string | null {
    try {
      const host = new URL(urlValue).hostname.toLowerCase();
      if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        return null;
      }
      if (host.endsWith('.mctl.ai')) {
        return '.mctl.ai';
      }
      if (host.endsWith('.mctl.me')) {
        return '.mctl.me';
      }
      return null;
    } catch {
      return null;
    }
  }

  function buildSessionCookie(sessionId: string, returnTo: string): string {
    const domain = deriveCookieDomain(returnTo);
    const parts = [
      `oidc_session=${sessionId}`,
      'Path=/',
      'HttpOnly',
      'Secure',
      domain ? 'SameSite=None' : 'SameSite=Lax',
      'Max-Age=28800',
    ];
    if (domain) {
      parts.push(`Domain=${domain}`);
    }
    return parts.join('; ');
  }

  function readSessionCookie(req: Request): Promise<{ userId: string; expiresAt: number } | undefined> {
    const sessionId = parseCookie(req.headers.cookie ?? '', 'oidc_session');
    return sessionId ? store.getSession(sessionId) : Promise.resolve(undefined);
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

  function buildTenantServiceUrl(tenant: string, service: string): string | null {
    if (!tenant || !service) {
      return null;
    }
    const baseDomain = deriveTenantBaseDomain();
    if (!baseDomain) {
      return null;
    }
    return `https://${tenant}-${service}.${baseDomain}/`;
  }

  function buildTenantLoginUrl(tenant: string, service: string): string {
    const url = new URL(issuer);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/tenant-login`;
    url.search = '';
    url.searchParams.set('tenant', tenant);
    url.searchParams.set('service', service);
    return url.toString();
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

    // Check session cookie
    const session = await readSessionCookie(req);

    if (session && session.expiresAt > Date.now()) {
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
    res.redirect(await buildGitHubAuthRedirect(req.originalUrl));
  });

  // ── Browser Login Helper ───────────────────────────────────────────
  // GET /login?returnTo=https://tenant-service.mctl.ai/
  //
  // Used by Traefik ForwardAuth flows where we need an interactive login
  // redirect instead of OIDC authorization-code issuance to a registered client.
  router.get('/login', async (req: Request, res: Response) => {
    const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo.trim() : '';
    if (!returnTo) {
      res.status(400).send('Missing returnTo');
      return;
    }
    const session = await readSessionCookie(req);
    if (session && session.expiresAt > Date.now()) {
      res.redirect(returnTo);
      return;
    }
    res.redirect(await buildGitHubAuthRedirect(returnTo));
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

    res.redirect(await buildGitHubAuthRedirect(tenantUrl));
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
      res.status(400).send('Missing state');
      return;
    }
    const returnTo = decodeOpenAICodexReturnTo(state);
    if (!returnTo) {
      res.status(400).send('Invalid OpenAI Codex callback state');
      return;
    }
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
    // /authorize will now see the session and issue the auth code to Dex
    res.setHeader('Set-Cookie', buildSessionCookie(sessionId, pending.returnTo));
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
  // Validates the shared OIDC session cookie and returns trusted identity
  // headers that upstream services can consume in trusted-proxy mode.
  router.get('/forward-auth', async (req: Request, res: Response) => {
    const tenant = typeof req.query.tenant === 'string' ? req.query.tenant.trim().toLowerCase() : '';
    const service = typeof req.query.service === 'string' ? req.query.service.trim() : '';
    if (!tenant) {
      res.status(400).send('Missing tenant');
      return;
    }

    const session = await readSessionCookie(req);
    if (!session || session.expiresAt <= Date.now()) {
      res.redirect(buildTenantLoginUrl(tenant, service || 'openclaw'));
      return;
    }

    const role = await membership.getUserRole(session.userId, tenant);
    if (!role) {
      logger.warn(`[OIDC] ForwardAuth denied: user=${session.userId} tenant=${tenant} service=${service || 'unknown'}`);
      res.status(403).send('Access denied');
      return;
    }

    res.setHeader('X-Forwarded-User', session.userId);
    res.setHeader('X-Mctl-Team-Role', role);
    res.setHeader('X-Auth-Request-User', session.userId);
    res.status(200).send('ok');
  });

  // ── Health ──────────────────────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  return router;
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Parse a specific cookie value from a cookie header string */
function parseCookie(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${name}=`));
  return match ? match.split('=')[1] : undefined;
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
    if (
      host === 'localhost' ||
      host.endsWith('.mctl.ai') ||
      host.endsWith('.mctl.me')
    ) {
      return url.toString();
    }
    return null;
  } catch {
    return null;
  }
}
