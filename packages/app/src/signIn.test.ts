import { githubAuthApiRef } from '@backstage/core-plugin-api';
import { signInProviders, zitadelAuthApiRef } from './signIn';

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
