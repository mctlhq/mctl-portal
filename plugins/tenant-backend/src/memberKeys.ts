import { isGitHubLogin } from './creatorPrincipal';

/**
 * What a tenant member's catalog User is named by (mctl-web
 * docs/plans/site-onboarding-review.md, stage C2).
 *
 * - `login`: by the GitHub login in `userId`. Admins and every tenant created
 *   before self-service accounts; the default when values.yaml says nothing.
 * - `principal`: by the canonical principal id (mctl-api#377), lowercased,
 *   because Backstage lowercases entity refs. A self-service customer is
 *   known only by the GitHub id ZITADEL proved, so a login (which GitHub
 *   hands to the next person who registers it) must never name them.
 *
 * GitHub logins never contain `_`, so a principal-keyed name (`prn_...`)
 * cannot collide with a login-keyed one.
 */
export type CatalogKey = 'login' | 'principal';

/** mctl-api's principal id shape (ValidPrincipalID in internal/auth). */
export const PRINCIPAL_ID = /^prn_[0-9A-HJKMNP-TV-Z]{26}$/;

/** One member entry of values.yaml, resolved to the row the portal stores. */
export interface SeedMember {
  /** The catalog User name and tenant_members.user_id. */
  userId: string;
  role: string;
  catalogKey: CatalogKey;
  principalId?: string;
  /** The GitHub login, for display only; set for principal-keyed members. */
  login?: string;
}

export type SeedMemberResult = { member: SeedMember } | { error: string };

/**
 * Resolves a values.yaml member entry. An entry that cannot be keyed the way
 * it asks is an error, never a fallback: a `catalogKey: principal` entry
 * without a usable principalId would otherwise be named by its login, which
 * is exactly the identity it must not get.
 */
export function seedMemberOf(raw: unknown): SeedMemberResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'not a mapping' };
  }
  const m = raw as Record<string, unknown>;
  const role = typeof m.role === 'string' && m.role ? m.role : 'owner';
  const principalId =
    typeof m.principalId === 'string' && PRINCIPAL_ID.test(m.principalId)
      ? m.principalId
      : undefined;
  const userId = typeof m.userId === 'string' ? m.userId.trim() : '';

  // Only an absent key means login; `catalogKey: null` or "" is a mistake.
  const key = 'catalogKey' in m ? m.catalogKey : 'login';
  if (key === 'principal') {
    if (!principalId) {
      return { error: 'catalogKey principal without a valid principalId' };
    }
    return {
      member: {
        userId: principalId.toLowerCase(),
        role,
        catalogKey: 'principal',
        principalId,
        ...(isGitHubLogin(userId) ? { login: userId } : {}),
      },
    };
  }
  if (key !== 'login') {
    return { error: `unknown catalogKey ${JSON.stringify(key)}` };
  }
  if (!userId) {
    return { error: 'no userId' };
  }
  return {
    member: {
      userId: userId.toLowerCase(),
      role,
      catalogKey: 'login',
      ...(principalId ? { principalId } : {}),
    },
  };
}
