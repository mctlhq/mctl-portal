import { SignInPage } from '@backstage/core-components';
import {
  configApiRef,
  SignInPageProps,
  useApi,
} from '@backstage/core-plugin-api';
import {
  customerEntryEnabled,
  googleEntryEnabled,
  signInProviders,
} from './signIn';

/**
 * The sign-in page offers the providers `auth.signIn` selects (signIn.ts):
 * GitHub until the switch is set, then ZITADEL, with GitHub as legacy
 * during the canary, and the customer entry ("Sign in with GitHub")
 * before the staff ZITADEL sign-in once both zitadelCustomers ids are set,
 * followed by "Sign in with Google" once googleIdpId is set too.
 *
 * `auto` exists only on the single-provider page; the multi-provider page
 * restores a session on its own through each provider's silent loader.
 */
export function PortalSignInPage(props: SignInPageProps) {
  const config = useApi(configApiRef);
  const organizationId = config.getOptional('zitadelCustomers.organizationId');
  const githubIdpId = config.getOptional('zitadelCustomers.githubIdpId');
  const providers = signInProviders(
    config.getOptionalString('auth.signIn'),
    customerEntryEnabled(organizationId, githubIdpId),
    googleEntryEnabled(
      organizationId,
      githubIdpId,
      config.getOptional('zitadelCustomers.googleIdpId'),
    ),
  );
  if (providers.length === 1) {
    return <SignInPage {...props} auto provider={providers[0]} />;
  }
  return <SignInPage {...props} providers={providers} />;
}
