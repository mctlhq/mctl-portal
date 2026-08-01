import fetch from 'node-fetch';
import { readFile } from 'fs/promises';
import type { LoggerService } from '@backstage/backend-plugin-api';

/**
 * Supplies the token used for Vault API calls.
 *
 * The plugin used to hold a single static token for the process lifetime. That
 * token was created `-period=87600h -orphan`, so it could not expire — but it
 * was revoked out from under us anyway, and because nothing re-authenticates,
 * every Vault-backed feature returned 500 until a human noticed and minted a
 * new one by hand (see the 2026-08-01 incident). A provider lets the caller
 * recover on its own instead.
 */
export interface VaultTokenProvider {
  /** Current token, logging in or refreshing if needed. */
  getToken(): Promise<string>;
  /**
   * Discard the cached token, but only if it is still `rejected` — the exact
   * token Vault turned down.
   *
   * The scoping matters under concurrency. Several in-flight requests can each
   * get a 403 for the same dead token; the first one to notice logs in and
   * caches a fresh one. An unconditional invalidate would let the stragglers
   * throw that fresh token away and log in again, one after another, turning a
   * single revocation into a login storm. Comparing first makes every
   * straggler a no-op.
   */
  invalidate(rejected: string): void;
}

/** Wraps a pre-issued token. Nothing to refresh — invalidate is a no-op. */
export function staticTokenProvider(token: string): VaultTokenProvider {
  return {
    getToken: async () => token,
    invalidate: () => {},
  };
}

export interface KubernetesAuthOptions {
  vaultAddr: string;
  /** Vault role name bound to this pod's ServiceAccount. */
  role: string;
  /** Auth mount path, without leading/trailing slashes. Usually 'kubernetes'. */
  authPath?: string;
  /** Projected ServiceAccount token file. */
  jwtPath?: string;
  logger: LoggerService;
  /** Injectable for tests. */
  readJwt?: (path: string) => Promise<string>;
  now?: () => number;
}

const DEFAULT_JWT_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

// Renew once 80% of the lease has elapsed. Vault hands out leases in the
// minutes-to-hours range here, so this leaves a wide margin for clock skew and
// a slow login without re-authenticating on every request.
const RENEW_AT = 0.8;

/**
 * Authenticates to Vault with the pod's projected ServiceAccount JWT.
 *
 * The JWT is re-read from disk on every login: kubelet rotates projected
 * tokens in place, so a copy cached at startup goes stale and Vault starts
 * rejecting it.
 */
export function kubernetesTokenProvider(
  options: KubernetesAuthOptions,
): VaultTokenProvider {
  const {
    vaultAddr,
    role,
    authPath = 'kubernetes',
    jwtPath = DEFAULT_JWT_PATH,
    logger,
    readJwt = (p: string) => readFile(p, 'utf8'),
    now = () => Date.now(),
  } = options;

  let cached: { token: string; renewAfter: number; hardExpiry: number } | undefined;
  // Concurrent requests must not each start their own login; they await the
  // same one.
  let inFlight: Promise<string> | undefined;

  const login = async (): Promise<string> => {
    const jwt = (await readJwt(jwtPath)).trim();
    if (!jwt) {
      throw new Error(`Vault k8s auth: empty ServiceAccount token at ${jwtPath}`);
    }

    const resp = await fetch(`${vaultAddr}/v1/auth/${authPath}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, jwt }),
    });
    if (!resp.ok) {
      // Vault puts the actionable part in the body — "role not found",
      // "service account name not authorized", "JWT validation failed" all
      // arrive as the same HTTP status. Losing it would leave a production
      // auth failure diagnosable only by guessing.
      let detail = '';
      try {
        const errBody = (await resp.json()) as { errors?: string[] };
        detail = errBody?.errors?.join('; ') ?? '';
      } catch {
        // Non-JSON body (a proxy error page, say) — the status still stands.
      }
      throw new Error(
        `Vault k8s auth failed for role '${role}': HTTP ${resp.status}${
          detail ? ` — ${detail}` : ''
        }`,
      );
    }

    const body = (await resp.json()) as {
      auth?: { client_token?: string; lease_duration?: number };
    };
    const token = body?.auth?.client_token;
    if (!token) {
      throw new Error(
        `Vault k8s auth for role '${role}' returned no client_token`,
      );
    }

    // lease_duration is seconds. A zero/absent lease means a root-ish token
    // with no expiry; re-login hourly anyway so a revoked one self-heals.
    const leaseSeconds = Number(body.auth?.lease_duration) || 3600;
    const issuedAt = now();
    cached = {
      token,
      renewAfter: issuedAt + leaseSeconds * RENEW_AT * 1000,
      hardExpiry: issuedAt + leaseSeconds * 1000,
    };
    logger.info('Vault kubernetes auth succeeded', {
      role,
      lease_duration: leaseSeconds,
    });
    return token;
  };

  return {
    async getToken() {
      if (cached && now() < cached.renewAfter) {
        return cached.token;
      }
      if (!inFlight) {
        // A proactive renewal (past renewAfter, i.e. 80% of the lease) can
        // fail for reasons that have nothing to do with the old token's
        // validity — a blip on the Kubernetes TokenReview API, say — while
        // Vault's KV endpoint stays healthy. The old token is still good for
        // the remaining 20% of its lease, so keep serving it instead of
        // turning a transient renewal hiccup into a hard outage.
        const fallback = cached;
        inFlight = login()
          .catch(err => {
            if (fallback && now() < fallback.hardExpiry) {
              logger.warn(
                'Vault kubernetes auth renewal failed; reusing the still-valid cached token until its lease expires',
                { role, error: (err as Error).message },
              );
              return fallback.token;
            }
            // No usable fallback — either this is the first login ever, or
            // the old token's lease has actually run out. Drop it so the
            // closure never holds a token we already know Vault will refuse.
            cached = undefined;
            throw err;
          })
          .finally(() => {
            inFlight = undefined;
          });
      }
      return inFlight;
    },
    invalidate(rejected: string) {
      if (cached?.token === rejected) {
        cached = undefined;
      }
    },
  };
}
