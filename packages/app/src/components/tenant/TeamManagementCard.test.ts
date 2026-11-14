import { inviteAllowed } from './TeamManagementCard';

describe('inviteAllowed', () => {
  const base = { inviting: false, username: 'octocat', lookingUp: false };

  it('stays disabled until the lookup for the typed login has answered (old code enabled it during the debounce)', () => {
    expect(inviteAllowed({ ...base, userPreview: null })).toBe(false);
  });

  it('enables for a login that exists, or when GitHub could not be reached', () => {
    expect(inviteAllowed({ ...base, userPreview: { exists: true, login: 'octocat' } })).toBe(true);
    expect(inviteAllowed({ ...base, userPreview: { exists: null, error: 'down' } })).toBe(true);
  });

  it('stays disabled for a missing login, while looking up, while inviting, or with no login', () => {
    expect(inviteAllowed({ ...base, userPreview: { exists: false } })).toBe(false);
    expect(inviteAllowed({ ...base, lookingUp: true, userPreview: { exists: true } })).toBe(false);
    expect(inviteAllowed({ ...base, inviting: true, userPreview: { exists: true } })).toBe(false);
    expect(inviteAllowed({ ...base, username: '  ', userPreview: { exists: true } })).toBe(false);
  });
});
