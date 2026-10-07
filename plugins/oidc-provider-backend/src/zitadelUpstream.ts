import { createHash, randomBytes } from 'crypto';
import * as jose from 'jose';

/**
 * Where the provider sends a person without a portal session to sign in:
 * GitHub (the default, and the only behaviour before this switch existed),
 * ZITADEL, or a page offering both.
 */
export type UpstreamMode = 'github' | 'zitadel' | 'both';

const UPSTREAM_MODES: readonly string[] = ['github', 'zitadel', 'both'];

/** ZITADEL claim carrying the GitHub login the portal knows the person by. */
export const GITHUB_LOGIN_CLAIM = 'mctl:github_login';

// A GitHub login: alphanumerics and single inner hyphens, at most 39
// characters. The same shape the ZITADEL action and its IaC enforce.
const GITHUB_LOGIN_RE = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;
const GITHUB_LOGIN_MAX_LENGTH = 39;

const UPSTREAM_TIMEOUT_MS = 10_000;

// The least time between two key refetches forced by an unknown key id.
const KEY_REFRESH_COOLDOWN_MS = 30_000;

export interface ZitadelUpstreamConfig {
  /** Exactly the `iss` of the tokens, e.g. https://auth.mctl.ai */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

// Absent means the default. Anything else that is not a known mode fails
// startup: a typo must not silently select an upstream. Exported for unit
// testing.
export function parseUpstreamMode(raw: string | undefined): UpstreamMode {
  if (raw === undefined) {
    return 'github';
  }
  if (!UPSTREAM_MODES.includes(raw)) {
    throw new Error(`oidcProvider.upstream must be one of github, zitadel, both; got ${JSON.stringify(raw)}`);
  }
  return raw as UpstreamMode;
}

// The GitHub login in an ID token's claims, lowercased, or null when the
// claim is absent, empty, not a string or not shaped like a login. Null is
// "this person is not mapped": callers refuse it and never fall back to
// another claim. Exported for unit testing.
export function readGithubLogin(claims: Record<string, unknown>): string | null {
  const value = claims[GITHUB_LOGIN_CLAIM];
  if (typeof value !== 'string' || value.length > GITHUB_LOGIN_MAX_LENGTH || !GITHUB_LOGIN_RE.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

/** A fresh, unguessable value for a nonce or a PKCE code verifier. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The S256 PKCE challenge of a code verifier. */
export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

interface Endpoints {
  authorization: string;
  token: string;
  jwks: string;
}

/**
 * The ZITADEL side of a sign-in: authorization code flow with PKCE as a
 * confidential client. Only the ID token is read; it is verified against
 * the issuer's keys, this client's audience and the nonce of the flow.
 */
export class ZitadelUpstream {
  private readonly issuerOrigin: string;
  private endpoints?: Endpoints;
  private discovering?: Promise<Endpoints>;
  private keys?: jose.JSONWebKeySet;
  private loadingKeys?: Promise<jose.JSONWebKeySet>;
  private keysRefreshedAt?: number;

  constructor(private readonly config: ZitadelUpstreamConfig, private readonly redirectUri: string) {
    let url: URL;
    try {
      url = new URL(config.issuer);
    } catch {
      throw new Error('oidcProvider.zitadel.issuer must be an https URL');
    }
    if (url.protocol !== 'https:' || url.search || url.hash || url.username || config.issuer.endsWith('/')) {
      throw new Error('oidcProvider.zitadel.issuer must be an https URL without query, fragment or trailing slash');
    }
    if (!config.clientId || !config.clientSecret) {
      throw new Error('oidcProvider.zitadel.clientId and clientSecret must be set');
    }
    this.issuerOrigin = url.origin;
  }

  async authorizationUrl(params: { state: string; nonce: string; codeChallenge: string }): Promise<string> {
    const { authorization } = await this.discover();
    const url = new URL(authorization);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', 'openid');
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /** Exchanges an authorization code for the ID token. */
  async exchangeCode(code: string, codeVerifier: string): Promise<string> {
    const { token } = await this.discover();
    const basic = Buffer.from(
      `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
    ).toString('base64');
    const res = await fetch(token, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        code_verifier: codeVerifier,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`token endpoint answered HTTP ${res.status}`);
    }
    const data = (await res.json()) as { id_token?: unknown };
    if (typeof data.id_token !== 'string' || !data.id_token) {
      throw new Error('token response carries no id_token');
    }
    return data.id_token;
  }

  /**
   * Verifies an ID token of this flow and returns its claims. Throws unless
   * the signature, issuer, audience, expiry and nonce all hold.
   */
  async verifyIdToken(idToken: string, nonce: string): Promise<jose.JWTPayload> {
    const options: jose.JWTVerifyOptions = {
      issuer: this.config.issuer,
      audience: this.config.clientId,
      algorithms: ['RS256'],
      clockTolerance: 30,
      requiredClaims: ['sub', 'iat', 'exp'],
    };
    let payload: jose.JWTPayload;
    try {
      ({ payload } = await jose.jwtVerify(idToken, jose.createLocalJWKSet(await this.loadKeys(false)), options));
    } catch (err) {
      // An unknown key id may be a key rotated in since the last fetch.
      if (!(err instanceof jose.errors.JWKSNoMatchingKey)) {
        throw err;
      }
      ({ payload } = await jose.jwtVerify(idToken, jose.createLocalJWKSet(await this.loadKeys(true)), options));
    }
    if (typeof payload.nonce !== 'string' || payload.nonce !== nonce) {
      throw new Error('ID token nonce does not match this sign-in');
    }
    // ZITADEL lists every application of the project in `aud`, so the
    // audience check above also passes for a token of a sibling client;
    // `azp` names the one the token was issued to. It may only be absent
    // when this client is the sole audience (OIDC Core 3.1.3.7).
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const soleAudience = audiences.length === 1 && audiences[0] === this.config.clientId;
    if (payload.azp === undefined ? !soleAudience : payload.azp !== this.config.clientId) {
      throw new Error('ID token was issued to another client');
    }
    return payload;
  }

  // Discovery is read on first use and kept once it succeeds; a failed read
  // is an error for that sign-in and is tried again on the next one.
  // Sign-ins that arrive while a read is in flight share it.
  private discover(): Promise<Endpoints> {
    if (this.endpoints) {
      return Promise.resolve(this.endpoints);
    }
    this.discovering ??= this.readDiscovery().finally(() => {
      this.discovering = undefined;
    });
    return this.discovering;
  }

  private async readDiscovery(): Promise<Endpoints> {
    const doc = (await this.getJson(`${this.config.issuer}/.well-known/openid-configuration`)) as Record<
      string,
      unknown
    >;
    if (doc.issuer !== this.config.issuer) {
      throw new Error('discovery document names another issuer');
    }
    this.endpoints = {
      authorization: this.issuerEndpoint(doc.authorization_endpoint, 'authorization_endpoint'),
      token: this.issuerEndpoint(doc.token_endpoint, 'token_endpoint'),
      jwks: this.issuerEndpoint(doc.jwks_uri, 'jwks_uri'),
    };
    return this.endpoints;
  }

  // Every endpoint must live on the issuer's own origin, so a tampered or
  // misconfigured discovery document cannot send codes, the client secret
  // or key lookups anywhere else.
  private issuerEndpoint(value: unknown, name: string): string {
    if (typeof value !== 'string') {
      throw new Error(`discovery document has no ${name}`);
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`discovery ${name} is not a URL`);
    }
    if (url.origin !== this.issuerOrigin) {
      throw new Error(`discovery ${name} is not on the issuer's origin`);
    }
    return url.toString();
  }

  // The keys are read on first use and kept. A refresh, asked for by a
  // token with an unknown key id, reads them again at most once per
  // cooldown; in between, such a token is checked against the keys held.
  // Callers that arrive while a read is in flight share it.
  private loadKeys(refresh: boolean): Promise<jose.JSONWebKeySet> {
    if (this.loadingKeys) {
      return this.loadingKeys;
    }
    if (this.keys) {
      const cooling = this.keysRefreshedAt !== undefined && Date.now() - this.keysRefreshedAt < KEY_REFRESH_COOLDOWN_MS;
      if (!refresh || cooling) {
        return Promise.resolve(this.keys);
      }
      this.keysRefreshedAt = Date.now();
    }
    this.loadingKeys = this.readKeys().finally(() => {
      this.loadingKeys = undefined;
    });
    return this.loadingKeys;
  }

  private async readKeys(): Promise<jose.JSONWebKeySet> {
    const { jwks } = await this.discover();
    const set = (await this.getJson(jwks)) as { keys?: unknown };
    if (!Array.isArray(set.keys)) {
      throw new Error('JWKS response carries no keys');
    }
    this.keys = set as jose.JSONWebKeySet;
    return this.keys;
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`${new URL(url).pathname} answered HTTP ${res.status}`);
    }
    return res.json();
  }
}
