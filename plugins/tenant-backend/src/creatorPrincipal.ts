import { LoggerService } from '@backstage/backend-plugin-api';

/**
 * Resolves a tenant creator's GitHub login to the canonical mctl principal
 * (mctl-api#377), so create-tenant can key the owner entry by principalId.
 *
 * Calls mctl-api `POST /api/v1/surface-principals/github` as the
 * `surface:portal` principal, naming the login in `X-MCTL-Surface-Actor`.
 * mctl-api resolves it the way a first sign-in would, provisioning a
 * principal if there is none. Any answer other than a well-formed id is an
 * error: a creator whose principal could not be read is never sent as "no
 * principal".
 */

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-[A-Za-z0-9])*$/;
const MAX_GITHUB_LOGIN = 39;

/**
 * GitHub's login grammar: alphanumerics and single inner hyphens, at most 39
 * characters. The length is checked on its own: a repetition bound in the
 * pattern counts groups, and `-x` is two characters.
 */
export function isGitHubLogin(login: string): boolean {
  return login.length <= MAX_GITHUB_LOGIN && GITHUB_LOGIN.test(login);
}

/** mctl-api's principal id shape (ValidPrincipalID in internal/auth). */
export const PRINCIPAL_ID = /^prn_[0-9A-HJKMNP-TV-Z]{26}$/;

const TIMEOUT_MS = 10_000;

/** status is what POST /tenants answers: 403 for a refused identity, else 503. */
export class CreatorPrincipalError extends Error {
  constructor(
    readonly status: 403 | 503,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CreatorPrincipalError';
  }
}

export type CreatorPrincipalResolver = (login: string) => Promise<string>;

export function createCreatorPrincipalResolver(options: {
  baseUrl: string;
  surfaceToken: string;
  logger: LoggerService;
}): CreatorPrincipalResolver {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const { surfaceToken, logger } = options;

  return async (login: string): Promise<string> => {
    if (!isGitHubLogin(login)) {
      throw new CreatorPrincipalError(503, 'creator login is not a GitHub login');
    }
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/api/v1/surface-principals/github`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${surfaceToken}`,
          'X-MCTL-Surface-Actor': `github:${login}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.error(
        `[tenant-backend] creator principal request failed: ${err instanceof Error ? err.message : 'network error'}`,
      );
      throw new CreatorPrincipalError(503, 'could not resolve the creator principal');
    }

    const text = await resp.text().catch(() => '');
    let body: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = text ? JSON.parse(text) : undefined;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = undefined;
    }

    if (resp.status === 403) {
      const code = typeof body?.code === 'string' ? body.code : undefined;
      if (code === 'principal_disabled' || code === 'identity_refused') {
        throw new CreatorPrincipalError(403, 'the creator identity is not allowed on the platform', code);
      }
      // portal_surface_required or anything else: the portal's own
      // credentials are wrong, not the creator.
      logger.error(`[tenant-backend] creator principal refused for the portal itself: ${code ?? 'no code'}`);
      throw new CreatorPrincipalError(503, 'could not resolve the creator principal');
    }
    if (!resp.ok) {
      logger.error(`[tenant-backend] creator principal lookup answered ${resp.status}`);
      throw new CreatorPrincipalError(503, 'could not resolve the creator principal');
    }
    const pid = body?.principalId;
    if (typeof pid !== 'string' || !PRINCIPAL_ID.test(pid)) {
      logger.error('[tenant-backend] creator principal lookup answered without a valid principalId');
      throw new CreatorPrincipalError(503, 'could not resolve the creator principal');
    }
    return pid;
  };
}
