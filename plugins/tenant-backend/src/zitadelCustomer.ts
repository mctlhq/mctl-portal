import { LoggerService } from '@backstage/backend-plugin-api';
import { PRINCIPAL_ID } from './memberKeys';

/**
 * Resolves a self-service customer (ZITADEL organization `customers`) to the
 * canonical principal through mctl-api `POST
 * /api/v1/surface-principals/zitadel` (mctl-web
 * docs/plans/site-onboarding-review.md, stage C0/C2).
 *
 * The portal hands mctl-api the customer's ID token as it got it; mctl-api
 * verifies it (signature, issuer, expiry, that it was issued to the client
 * the purpose names) and keys the principal on the GitHub id the identity
 * hook proved. The portal reads nothing from the token to decide who the
 * customer is: the `sub` it sends as the actor is only checked by mctl-api
 * against the verified token.
 *
 * - purpose `signin`: the portal's own ID token, at sign-in.
 * - purpose `create`: the mctl-web site's ID token, when it creates a
 *   workspace for the customer.
 */

export type ZitadelPurpose = 'signin' | 'create';

export interface ZitadelCustomer {
  principalId: string;
  githubId: string;
  githubLogin: string;
}

/**
 * `refused`: mctl-api will not resolve this customer (an invalid or foreign
 * token, an unproven, disabled, refused or conflicting identity). `code` is
 * mctl-api's error code. `unavailable`: the portal could not get an answer
 * (network, configuration, a malformed reply); never a verdict on the
 * customer.
 */
export class ZitadelCustomerError extends Error {
  constructor(
    readonly kind: 'refused' | 'unavailable',
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ZitadelCustomerError';
  }
}

export type ZitadelCustomerResolver = (
  idToken: string,
  purpose: ZitadelPurpose,
) => Promise<ZitadelCustomer>;

const TIMEOUT_MS = 10_000;
const GITHUB_ID = /^[1-9][0-9]{0,19}$/;

/**
 * The token's `sub`, read without verification: it only names the actor,
 * and mctl-api refuses the call unless it equals the verified subject.
 */
const ZITADEL_ID = /^[0-9]{1,64}$/;

export function unverifiedSubjectOf(idToken: string): string | undefined {
  const parts = idToken.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const sub = (payload as Record<string, unknown> | null)?.sub;
    // ZITADEL ids are numeric. Anything else is not one of its tokens, and
    // the subject goes into a request header.
    return typeof sub === 'string' && ZITADEL_ID.test(sub) ? sub : undefined;
  } catch {
    return undefined;
  }
}

export function createZitadelCustomerResolver(options: {
  baseUrl: string;
  surfaceToken: string;
  logger: Pick<LoggerService, 'error' | 'warn'>;
}): ZitadelCustomerResolver {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const { surfaceToken, logger } = options;

  return async (idToken, purpose) => {
    const subject = unverifiedSubjectOf(idToken);
    if (!subject) {
      throw new ZitadelCustomerError('refused', 'the ID token is malformed', 'id_token_invalid');
    }
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/api/v1/surface-principals/zitadel`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${surfaceToken}`,
          'X-MCTL-Surface-Actor': `zitadel:${subject}`,
        },
        body: JSON.stringify({ idToken, purpose }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.error(
        `[tenant-backend] ZITADEL customer request failed: ${err instanceof Error ? err.message : 'network error'}`,
      );
      throw new ZitadelCustomerError('unavailable', 'could not resolve the customer');
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
    const code = typeof body?.code === 'string' ? body.code : undefined;

    if (resp.ok) {
      const { principalId, githubId, githubLogin } = body ?? {};
      if (
        typeof principalId === 'string' && PRINCIPAL_ID.test(principalId) &&
        typeof githubId === 'string' && GITHUB_ID.test(githubId) &&
        typeof githubLogin === 'string' && githubLogin
      ) {
        return { principalId, githubId, githubLogin };
      }
      logger.error('[tenant-backend] ZITADEL customer lookup answered without a valid principal');
      throw new ZitadelCustomerError('unavailable', 'could not resolve the customer');
    }
    // 400 not_a_customer, 401 id_token_invalid, 403 customer_unproven /
    // principal_disabled / identity_refused, 409 customer_conflict: about
    // the customer. 403 portal_surface_required and 400 invalid_request
    // (a malformed call) are about the portal, and so is anything else.
    const aboutCustomer: Record<string, true> = {
      not_a_customer: true,
      id_token_invalid: true,
      customer_unproven: true,
      principal_disabled: true,
      identity_refused: true,
      customer_conflict: true,
    };
    if (code && aboutCustomer[code]) {
      logger.warn(`[tenant-backend] ZITADEL customer refused (${purpose}): ${resp.status} ${code}`);
      throw new ZitadelCustomerError('refused', 'the customer is not allowed on the platform', code);
    }
    logger.error(`[tenant-backend] ZITADEL customer lookup answered ${resp.status} ${code ?? 'without a code'}`);
    throw new ZitadelCustomerError('unavailable', 'could not resolve the customer');
  };
}
