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

/**
 * The providers of a sign-in mode, the preferred one first. Absent means
 * `github`, today's behaviour; the config schema (packages/app/config.d.ts)
 * refuses any other value at startup, so a typo never reaches this point.
 */
export function signInProviders(mode: string | undefined): SignInProvider[] {
  switch (mode ?? 'github') {
    case 'zitadel':
      return [ZITADEL_PROVIDER];
    case 'both':
      return [ZITADEL_PROVIDER, LEGACY_GITHUB_PROVIDER];
    default:
      return [GITHUB_PROVIDER];
  }
}
