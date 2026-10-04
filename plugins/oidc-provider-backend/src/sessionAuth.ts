import type { Knex } from 'knex';

/**
 * Name of the portal browser session cookie set by oidc-provider.
 *
 * The __Host- prefix makes browsers refuse the cookie unless it is Secure,
 * has Path=/ and no Domain attribute, so it is only ever sent back to the
 * portal host itself and no other *.mctl.ai host can set or shadow it.
 * Forward-auth protected hosts get their own cookie instead (see router.ts).
 */
export const OIDC_SESSION_COOKIE = '__Host-oidc_session';

/** Schema used for oidc-provider tables on Postgres. */
export const OIDC_SCHEMA = 'oidc-provider';

/** Extract a named cookie value from a raw Cookie header. */
export function parseCookie(cookieHeader: string, name: string): string | undefined {
  const match = cookieHeader
    .split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

/**
 * Look up an active oidc_sessions row by session id, respecting the
 * oidc-provider Postgres schema and the expires_at timestamp. Rows without
 * host_only predate the host-only cookie and are never accepted.
 *
 * Returns the user id (GitHub login) for a valid, unexpired session,
 * or undefined if the cookie is missing, unknown, or expired.
 */
export async function readOidcSessionUserId(
  cookieHeader: string | undefined,
  db: Knex,
  isPostgres: boolean,
  now: number = Date.now(),
): Promise<string | undefined> {
  const sessionId = parseCookie(cookieHeader ?? '', OIDC_SESSION_COOKIE);
  if (!sessionId) {
    return undefined;
  }
  const query = isPostgres
    ? db('oidc_sessions').withSchema(OIDC_SCHEMA).where({ session_id: sessionId, host_only: true }).first()
    : db('oidc_sessions').where({ session_id: sessionId, host_only: true }).first();
  const row = await query;
  if (!row) {
    return undefined;
  }
  const expiresAt = Number(row.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return undefined;
  }
  return String(row.user_id);
}
