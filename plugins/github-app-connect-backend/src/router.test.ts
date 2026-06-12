import crypto from 'crypto';
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

  // Rollout safety: tokens minted by the previous version (key = privateKey
  // slice) cannot be read with the new sha256-derived key, so createRouter
  // chains a legacy-secret fallback (decodeState) during the deploy window.
  it('legacy-key tokens decode only with the legacy secret', () => {
    const priv = 'PRIVATEKEYMATERIAL'.repeat(8);
    const newSecret = crypto.createHash('sha256').update(priv).digest('hex');
    const legacySecret = priv.slice(0, 64);
    const legacyToken = encryptState({ repo: 'mctlhq/x' }, legacySecret);
    // A pod running only the new key cannot read an in-flight legacy token...
    expect(decryptState(legacyToken, newSecret)).toBeNull();
    // ...but the legacy-secret fallback can, which is what decodeState chains.
    expect(decryptState(legacyToken, legacySecret)).toMatchObject({ repo: 'mctlhq/x' });
  });
});
