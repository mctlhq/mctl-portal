import { configApiRef, githubAuthApiRef } from '@backstage/core-plugin-api';
import {
  MockConfigApi,
  renderInTestApp,
  TestApiProvider,
} from '@backstage/test-utils';
import { screen } from '@testing-library/react';
import { PortalSignInPage } from './PortalSignInPage';
import { zitadelAuthApiRef } from './signIn';

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

async function renderPage(signIn?: string) {
  const config = new MockConfigApi({
    app: { title: 'Test' },
    ...(signIn ? { auth: { signIn } } : {}),
  });
  await renderInTestApp(
    <TestApiProvider
      apis={[
        [configApiRef, config],
        [githubAuthApiRef, signedOut()],
        [zitadelAuthApiRef, signedOut()],
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
});
