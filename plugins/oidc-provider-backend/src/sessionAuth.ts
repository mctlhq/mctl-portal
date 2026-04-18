import type { Knex } from 'knex';

/** Name of the shared browser session cookie set by oidc-provider. */
export const OIDC_SESSION_COOKIE = 'oidc_session';

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
 * oidc-provider Postgres schema and the expires_at timestamp.
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
    ? db('oidc_sessions').withSchema(OIDC_SCHEMA).where({ session_id: sessionId }).first()
    : db('oidc_sessions').where({ session_id: sessionId }).first();
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
