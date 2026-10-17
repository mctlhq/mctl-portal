import { configApiRef, githubAuthApiRef } from '@backstage/core-plugin-api';
import {
  MockConfigApi,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/test-utils';
import { screen } from '@testing-library/react';
import { PortalSignInPage } from './PortalSignInPage';
import { zitadelAuthApiRef, zitadelCustomerAuthApiRef } from './signIn';

// An auth API with no session: the sign-in page renders its provider
// cards instead of signing anyone in.
function signedOut() {
  return {
    getBackstageIdentity: jest.fn(async () => undefined),
    getProfile: jest.fn(async () => undefined),
    getAccessToken: jest.fn(async () => ''),
    getIdToken: jest.fn(async () => ''),
    signIn: jest.fn(async () => {}),
    signOut: jest.fn(async () => {}),
    sessionState$: jest.fn(),
  };
}

async function renderPage(
  signIn?: string,
  zitadelCustomers?: Record<string, string>,
) {
  const config = new MockConfigApi({
    app: { title: 'Test' },
    ...(signIn ? { auth: { signIn } } : {}),
    ...(zitadelCustomers ? { zitadelCustomers } : {}),
  });
  await renderInTestApp(
    <TestApiProvider
      apis={[
        [configApiRef, config],
        [githubAuthApiRef, signedOut()],
        [zitadelAuthApiRef, signedOut()],
        [zitadelCustomerAuthApiRef, signedOut()],
      ]}
    >
      <PortalSignInPage onSignInSuccess={jest.fn()} />
    </TestApiProvider>,
  );
}

describe('PortalSignInPage', () => {
  it.each([
    [undefined, ['GitHub']],
    ['github', ['GitHub']],
    ['zitadel', ['MCTL account']],
    ['both', ['MCTL account', 'GitHub (legacy)']],
  ])('auth.signIn=%s offers %j', async (signIn, titles) => {
    await renderPage(signIn);
    for (const title of titles) {
      expect(await screen.findByText(title)).toBeInTheDocument();
    }
    const absent = ['GitHub', 'MCTL account', 'GitHub (legacy)'].filter(
      t => !titles.includes(t),
    );
    for (const title of absent) {
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
  });

  const ORG = '395272528420931285';
  const IDP = '395272528420931999';
  const ALL = [
    'Sign in with GitHub',
    'Sign in with MCTL (staff, ZITADEL)',
    'MCTL account',
    'GitHub',
    'GitHub (legacy)',
    'GitHub (legacy staff)',
  ];

  it.each([
    ['zitadel', { organizationId: ORG, githubIdpId: IDP }, ['Sign in with GitHub', 'Sign in with MCTL (staff, ZITADEL)']],
    ['both', { organizationId: ORG, githubIdpId: IDP }, ['Sign in with GitHub', 'Sign in with MCTL (staff, ZITADEL)', 'GitHub (legacy staff)']],
    ['zitadel', { organizationId: ORG }, ['MCTL account']],
    ['zitadel', { githubIdpId: IDP }, ['MCTL account']],
    ['github', { organizationId: ORG, githubIdpId: IDP }, ['GitHub']],
  ])('auth.signIn=%s with zitadelCustomers %j offers %j', async (signIn, customers, titles) => {
    await renderPage(signIn, customers);
    for (const title of titles) {
      expect(await screen.findByText(title)).toBeInTheDocument();
    }
    for (const title of ALL.filter(t => !titles.includes(t))) {
      expect(screen.queryByText(title)).not.toBeInTheDocument();
    }
  });
});
