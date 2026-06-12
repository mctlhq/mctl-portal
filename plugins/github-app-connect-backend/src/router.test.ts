import { encryptState, decryptState } from './router';

// The OAuth install flow round-trips an encrypted `state` blob through GitHub.
// These tests guard the state-token crypto (security-sensitive): correct
// round-trip, rejection of wrong-key / tampered tokens, and the 10-minute TTL.
describe('github-app-connect state tokens', () => {
  const secret = 'a'.repeat(64);

  it('round-trips state data with the same secret', () => {
    const token = encryptState({ team: 'admins', repo: 'mctlhq/x' }, secret);
    const data = decryptState(token, secret);
    expect(data).toMatchObject({ team: 'admins', repo: 'mctlhq/x' });
    expect(typeof data?.exp).toBe('number');
  });

  it('rejects a token decrypted with a different secret', () => {
    const token = encryptState({ repo: 'mctlhq/x' }, secret);
    expect(decryptState(token, 'b'.repeat(64))).toBeNull();
  });

  it('rejects malformed and tampered tokens', () => {
    expect(decryptState('not-a-valid-token', secret)).toBeNull();
    expect(decryptState('', secret)).toBeNull();
    const token = encryptState({ a: 1 }, secret);
    const tampered = token.slice(0, -2) + (token.endsWith('00') ? 'ff' : '00');
    expect(decryptState(tampered, secret)).toBeNull();
  });

  it('rejects a token past the 10-minute TTL', () => {
    const realNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow);
    const token = encryptState({ repo: 'mctlhq/x' }, secret);
    // valid right after issuance
    expect(decryptState(token, secret)).not.toBeNull();
    // advance past the embedded 10-minute expiry
    nowSpy.mockReturnValue(realNow + 11 * 60 * 1000);
    expect(decryptState(token, secret)).toBeNull();
    nowSpy.mockRestore();
  });
});
