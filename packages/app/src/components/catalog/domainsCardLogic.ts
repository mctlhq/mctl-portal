/**
 * Pure helpers extracted from EntityDomainsCard.tsx. No React or Backstage
 * imports here — these are plain functions over plain data so they can be
 * unit tested in isolation from rendering.
 */

/** Minimal shape these helpers need from a domain row. */
export interface DomainChallengeFields {
  status: string;
  challenge_record_name?: string;
  challenge_record_value?: string;
}

/** True when both TXT challenge fields are present on the row. */
export function hasChallenge(d: Pick<DomainChallengeFields, 'challenge_record_name' | 'challenge_record_value'>): boolean {
  return Boolean(d.challenge_record_name && d.challenge_record_value);
}

/**
 * Whether the Verify action should be offered for a row. mctl-api documents
 * the challenge fields as present for both 'pending' and 'failed' (a failed
 * DNS check does not reset the row — it stays 'failed' and still needs a
 * retry path), so a row in either of those statuses offers Verify whether or
 * not it happens to carry challenge fields yet. A row carrying both
 * challenge fields offers Verify regardless of its status, preserving
 * today's behavior for a status this card has never seen.
 */
export function canVerifyDomain(d: DomainChallengeFields): boolean {
  return hasChallenge(d) || d.status === 'pending' || d.status === 'failed';
}

const DEFAULT_UNVERIFIED_MESSAGE = 'DNS check has not passed yet';

/**
 * Extracts a user-facing message from a verify response body. Returns the
 * body's `reason` (or a generic fallback) when `verified` is explicitly
 * `false`; returns `null` for a `verified: true` body, an unparseable body,
 * or any other shape — a `null` result means "no error to report", not
 * "unknown error".
 */
export function verifyMessageFrom(body: unknown): string | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const b = body as { verified?: unknown; reason?: unknown };
  if (b.verified !== false) {
    return null;
  }
  return typeof b.reason === 'string' && b.reason.length > 0 ? b.reason : DEFAULT_UNVERIFIED_MESSAGE;
}
