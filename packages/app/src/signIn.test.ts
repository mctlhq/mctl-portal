import { githubAuthApiRef } from '@backstage/core-plugin-api';
import {
  signInProviders,
  ZITADEL_AUTH_PROVIDER_ID,
  zitadelAuthApiRef,
} from './signIn';

describe('ZITADEL_AUTH_PROVIDER_ID', () => {
  it('is oidc, the backend provider id', () => {
    // Pinned on both sides: packages/backend/src/zitadelAuthModule.test.ts
    // asserts the backend registers 'oidc'. A mismatch is a 404 at sign-in.
    expect(ZITADEL_AUTH_PROVIDER_ID).toBe('oidc');
  });
});

describe('signInProviders', () => {
  it('offers GitHub alone when unset, as before the switch existed', () => {
    expect(signInProviders(undefined).map(p => p.apiRef)).toEqual([
      githubAuthApiRef,
    ]);
  });

  it('offers GitHub alone for github', () => {
    expect(signInProviders('github').map(p => p.apiRef)).toEqual([
      githubAuthApiRef,
    ]);
  });

  it('falls back to GitHub alone for an unknown mode', () => {
    expect(signInProviders('zitdel').map(p => p.apiRef)).toEqual([
      githubAuthApiRef,
    ]);
  });

  it('offers ZITADEL alone for zitadel', () => {
    expect(signInProviders('zitadel').map(p => p.apiRef)).toEqual([
      zitadelAuthApiRef,
    ]);
  });

  it('offers ZITADEL first and GitHub as legacy for both', () => {
    const providers = signInProviders('both');
    expect(providers.map(p => p.apiRef)).toEqual([
      zitadelAuthApiRef,
      githubAuthApiRef,
    ]);
    expect(providers[1].title).toMatch(/legacy/);
  });
});
