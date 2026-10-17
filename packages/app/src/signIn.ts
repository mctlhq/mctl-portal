import {
  ApiRef,
  BackstageIdentityApi,
  createApiRef,
  githubAuthApiRef,
  OpenIdConnectApi,
  ProfileInfoApi,
  SessionApi,
} from '@backstage/core-plugin-api';

/**
 * The backend auth provider id of the ZITADEL sign-in, which is also its
 * route (/api/auth/oidc). It must equal ZITADEL_AUTH_PROVIDER_ID in
 * packages/backend/src/zitadelAuthModule.ts; both tests pin it to 'oidc'.
 */
export const ZITADEL_AUTH_PROVIDER_ID = 'oidc';

/**
 * The portal sign-in through ZITADEL: auth provider `oidc` in the backend
 * (packages/backend/src/zitadelAuthModule.ts).
 */
export const zitadelAuthApiRef: ApiRef<
  OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
> = createApiRef({ id: 'auth.zitadel' });

/**
 * The backend auth provider id of the customer entry, "Sign in with GitHub"
 * (mctl-web#158), which is also its route (/api/auth/zitadel-customer). It
 * must equal ZITADEL_CUSTOMER_AUTH_PROVIDER_ID in
 * packages/backend/src/zitadelAuthModule.ts; both tests pin it.
 */
export const ZITADEL_CUSTOMER_AUTH_PROVIDER_ID = 'zitadel-customer';

/**
 * The customer sign-in through ZITADEL: auth provider `zitadel-customer`,
 * which sends ZITADEL to the customers organization and its GitHub IdP.
 */
export const zitadelCustomerAuthApiRef: ApiRef<
  OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
> = createApiRef({ id: 'auth.zitadel-customer' });

// A ZITADEL resource id is digits, as the backend requires.
const ZITADEL_ID = /^\d+$/;

/**
 * Whether the sign-in page offers the customer entry: only with both
 * `zitadelCustomers` ids, the same condition under which the backend
 * registers `zitadel-customer` (customerGitHubScopes in
 * zitadelAuthModule.ts). The ids only decide what is offered; the backend
 * decides who signs in.
 *
 * The route also needs `auth.providers.zitadel-customer`, which the
 * frontend cannot see (it holds the client secret). The ids and that
 * section must land together, in the same mctl-gitops change; with the ids
 * alone the card shows and its popup answers 404. The backend logs an
 * error at startup when the ids are set without the section
 * (checkCustomerEntryRoute in zitadelAuthModule.ts).
 */
export function customerEntryEnabled(
  organizationId: unknown,
  githubIdpId: unknown,
): boolean {
  // Raw config values: an unquoted id in YAML is a number, which hides the
  // entry rather than throwing on the one page nobody can get past.
  return (
    typeof organizationId === 'string' &&
    typeof githubIdpId === 'string' &&
    ZITADEL_ID.test(organizationId) &&
    ZITADEL_ID.test(githubIdpId)
  );
}

/** Which providers the sign-in page offers (`auth.signIn`). */
export type SignInMode = 'github' | 'zitadel' | 'both';

export interface SignInProvider {
  id: string;
  title: string;
  message: string;
  apiRef: ApiRef<ProfileInfoApi & BackstageIdentityApi & SessionApi>;
}

const ZITADEL_PROVIDER: SignInProvider = {
  id: 'zitadel-auth-provider',
  title: 'MCTL account',
  message: 'Sign in with your MCTL account',
  apiRef: zitadelAuthApiRef,
};

// Next to the customer entry, the ZITADEL sign-in is labelled as staff's.
const ZITADEL_STAFF_PROVIDER: SignInProvider = {
  ...ZITADEL_PROVIDER,
  title: 'Sign in with MCTL (staff, ZITADEL)',
  message: 'MCTL staff sign in with their MCTL account',
};

const ZITADEL_CUSTOMER_PROVIDER: SignInProvider = {
  id: 'zitadel-customer-auth-provider',
  title: 'Sign in with GitHub',
  message: 'MCTL customers sign in with their GitHub account',
  apiRef: zitadelCustomerAuthApiRef,
};

const GITHUB_PROVIDER: SignInProvider = {
  id: 'github-auth-provider',
  title: 'GitHub',
  message: 'Sign in using GitHub',
  apiRef: githubAuthApiRef,
};

const LEGACY_GITHUB_PROVIDER: SignInProvider = {
  ...GITHUB_PROVIDER,
  title: 'GitHub (legacy)',
};

// Next to the customer entry, the legacy GitHub sign-in says it is staff's:
// it signs in by GitHub login, which no customer's catalog User is named
// by, so a customer who picked it would only be refused.
const LEGACY_STAFF_GITHUB_PROVIDER: SignInProvider = {
  ...GITHUB_PROVIDER,
  title: 'GitHub (legacy staff)',
  message: 'MCTL staff only: sign in directly with GitHub',
};

/**
 * The providers of a sign-in mode, the preferred one first. Absent means
 * `github`, today's behaviour; the config schema (packages/app/config.d.ts)
 * refuses any other value at startup, so a typo never reaches this point.
 * With `customerEntry` (customerEntryEnabled), the modes that offer ZITADEL
 * put the customer entry before the staff one, as mctl-api's OAuth chooser
 * does; `github` never offers it.
 */
export function signInProviders(
  mode: string | undefined,
  customerEntry = false,
): SignInProvider[] {
  const zitadel = customerEntry
    ? [ZITADEL_CUSTOMER_PROVIDER, ZITADEL_STAFF_PROVIDER]
    : [ZITADEL_PROVIDER];
  switch (mode ?? 'github') {
    case 'zitadel':
      return zitadel;
    case 'both':
      return [
        ...zitadel,
        customerEntry ? LEGACY_STAFF_GITHUB_PROVIDER : LEGACY_GITHUB_PROVIDER,
      ];
    default:
      return [GITHUB_PROVIDER];
  }
}
