import { SignInPage } from '@backstage/core-components';
import {
  configApiRef,
  SignInPageProps,
  useApi,
} from '@backstage/core-plugin-api';
import { signInProviders } from './signIn';

/**
 * The sign-in page offers the providers `auth.signIn` selects (signIn.ts):
 * GitHub until the switch is set, then ZITADEL, with GitHub as legacy
 * during the canary. `auto` exists only on the single-provider page; the
 * multi-provider page restores a session on its own through each
 * provider's silent loader.
 */
export function PortalSignInPage(props: SignInPageProps) {
  const config = useApi(configApiRef);
  const providers = signInProviders(config.getOptionalString('auth.signIn'));
  if (providers.length === 1) {
    return <SignInPage {...props} auto provider={providers[0]} />;
  }
  return <SignInPage {...props} providers={providers} />;
}
