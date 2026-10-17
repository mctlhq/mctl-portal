import { githubAuthApiRef } from '@backstage/core-plugin-api';
import {
  customerEntryEnabled,
  signInProviders,
  ZITADEL_AUTH_PROVIDER_ID,
  ZITADEL_CUSTOMER_AUTH_PROVIDER_ID,
  zitadelAuthApiRef,
  zitadelCustomerAuthApiRef,
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

describe('customer entry (mctl-web#158)', () => {
  const ORG = '395272528420931285';
  const IDP = '395272528420931999';

  it('is provider zitadel-customer, the backend provider id', () => {
    // Pinned on both sides with packages/backend/src/zitadelAuthModule.test.ts.
    expect(ZITADEL_CUSTOMER_AUTH_PROVIDER_ID).toBe('zitadel-customer');
  });

  it('is enabled only with both ZITADEL ids', () => {
    expect(customerEntryEnabled(ORG, IDP)).toBe(true);
    expect(customerEntryEnabled(ORG, undefined)).toBe(false);
    expect(customerEntryEnabled(undefined, IDP)).toBe(false);
    expect(customerEntryEnabled('', '')).toBe(false);
    expect(customerEntryEnabled(ORG, `${IDP} urn:zitadel:iam:org:project:roles`)).toBe(false);
    expect(customerEntryEnabled('customers', IDP)).toBe(false);
    expect(customerEntryEnabled(Number(ORG), IDP)).toBe(false);
  });

  it('comes before the staff sign-in for zitadel', () => {
    const providers = signInProviders('zitadel', true);
    expect(providers.map(p => p.apiRef)).toEqual([
      zitadelCustomerAuthApiRef,
      zitadelAuthApiRef,
    ]);
    expect(providers.map(p => p.title)).toEqual([
      'Sign in with GitHub',
      'Sign in with MCTL (staff, ZITADEL)',
    ]);
  });

  it('keeps GitHub as legacy last for both, labelled as staff only', () => {
    const providers = signInProviders('both', true);
    expect(providers.map(p => p.apiRef)).toEqual([
      zitadelCustomerAuthApiRef,
      zitadelAuthApiRef,
      githubAuthApiRef,
    ]);
    expect(providers[2].title).toBe('GitHub (legacy staff)');
  });

  it('is never offered without ZITADEL', () => {
    expect(signInProviders('github', true).map(p => p.apiRef)).toEqual([
      githubAuthApiRef,
    ]);
    expect(signInProviders(undefined, true).map(p => p.apiRef)).toEqual([
      githubAuthApiRef,
    ]);
  });
});
