import { canVerifyDomain, hasChallenge, verifyMessageFrom } from './domainsCardLogic';

describe('hasChallenge', () => {
  it('is true when both challenge fields are present', () => {
    expect(
      hasChallenge({ challenge_record_name: '_mctl-challenge.example.com', challenge_record_value: 'abc123' }),
    ).toBe(true);
  });

  it('is false when either challenge field is missing', () => {
    expect(hasChallenge({ challenge_record_name: '_mctl-challenge.example.com' })).toBe(false);
    expect(hasChallenge({ challenge_record_value: 'abc123' })).toBe(false);
    expect(hasChallenge({})).toBe(false);
  });
});

describe('canVerifyDomain', () => {
  it('is true for a pending row with no challenge fields', () => {
    expect(canVerifyDomain({ status: 'pending' })).toBe(true);
  });

  it('is true for a failed row with both challenge fields', () => {
    expect(
      canVerifyDomain({
        status: 'failed',
        challenge_record_name: '_mctl-challenge.example.com',
        challenge_record_value: 'abc123',
      }),
    ).toBe(true);
  });

  it('is true for a status this card has never seen when both challenge fields are present', () => {
    expect(
      canVerifyDomain({
        status: 'some-future-status',
        challenge_record_name: '_mctl-challenge.example.com',
        challenge_record_value: 'abc123',
      }),
    ).toBe(true);
  });

  it('is false for an active row with neither challenge field', () => {
    expect(canVerifyDomain({ status: 'active' })).toBe(false);
  });
});

describe('verifyMessageFrom', () => {
  it('returns the reason when verified is false and a reason is present', () => {
    expect(verifyMessageFrom({ verified: false, reason: 'DNS record not found' })).toBe('DNS record not found');
  });

  it('returns a generic message when verified is false and no reason is present', () => {
    expect(verifyMessageFrom({ verified: false })).toBe('DNS check has not passed yet');
  });

  it('returns null when verified is true', () => {
    expect(verifyMessageFrom({ verified: true })).toBeNull();
  });

  it('returns null for a null body', () => {
    expect(verifyMessageFrom(null)).toBeNull();
  });

  it('returns null for an undefined body', () => {
    expect(verifyMessageFrom(undefined)).toBeNull();
  });

  it('returns null for a non-object (string) body', () => {
    expect(verifyMessageFrom('not an object')).toBeNull();
  });
});
