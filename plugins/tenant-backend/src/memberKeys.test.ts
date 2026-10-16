import { seedMemberOf } from './memberKeys';

const PID = 'prn_01M39HRB7JRXZ2PHW5VVB695YZ';

describe('seedMemberOf', () => {
  it('keys an entry without catalogKey by its login, as before', () => {
    expect(seedMemberOf({ userId: 'Alice', principalId: PID, role: 'owner' })).toEqual({
      member: { userId: 'alice', role: 'owner', catalogKey: 'login', principalId: PID },
    });
  });

  it('keys catalogKey login by the login', () => {
    expect(seedMemberOf({ userId: 'alice', role: 'developer', catalogKey: 'login' })).toEqual({
      member: { userId: 'alice', role: 'developer', catalogKey: 'login' },
    });
  });

  it('keys catalogKey principal by the lowercased principal and keeps the login for display', () => {
    expect(
      seedMemberOf({ userId: 'Alice', principalId: PID, role: 'owner', catalogKey: 'principal' }),
    ).toEqual({
      member: {
        userId: PID.toLowerCase(),
        role: 'owner',
        catalogKey: 'principal',
        principalId: PID,
        login: 'Alice',
      },
    });
  });

  it('keeps no display login that is not a GitHub login', () => {
    const r = seedMemberOf({ userId: 'not a login', principalId: PID, role: 'owner', catalogKey: 'principal' });
    expect(r).toEqual({ member: expect.not.objectContaining({ login: expect.anything() }) });
    expect('member' in r && r.member.userId).toBe(PID.toLowerCase());
  });

  it.each([
    ['no principalId', { userId: 'alice', role: 'owner', catalogKey: 'principal' }],
    ['a malformed principalId', { userId: 'alice', principalId: PID.toLowerCase(), role: 'owner', catalogKey: 'principal' }],
  ])('refuses catalogKey principal with %s rather than fall back to the login', (_, raw) => {
    expect(seedMemberOf(raw)).toEqual({ error: expect.stringContaining('principalId') });
  });

  it.each([['Principal'], [''], [null], [1]])('refuses the unknown catalogKey %p', key => {
    expect(seedMemberOf({ userId: 'alice', principalId: PID, role: 'owner', catalogKey: key })).toEqual({
      error: expect.stringContaining('catalogKey'),
    });
  });

  it('refuses a login-keyed entry without a userId', () => {
    expect(seedMemberOf({ principalId: PID, role: 'owner' })).toEqual({ error: 'no userId' });
  });

  it('refuses an entry that is not a mapping', () => {
    expect(seedMemberOf('alice')).toEqual({ error: 'not a mapping' });
  });
});
