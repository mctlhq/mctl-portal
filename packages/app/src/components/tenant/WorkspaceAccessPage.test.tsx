import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { WorkspaceAccessPage } from './WorkspaceAccessPage';

const access = {
  tenant: 'acme',
  account: 'alice@mctl.ai',
  role: 'owner',
  status: 'ready',
  observedAt: '2026-10-17T09:00:00Z',
  capabilities: [
    {
      id: 'portal',
      label: 'Workspace portal',
      url: 'https://portal.example.test/acme',
    },
  ],
  environments: [{ name: 'production', namespace: 'acme', status: 'ready' }],
  mcp: 'blocked',
};
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

async function fixture() {
  const fetch = jest
    .fn()
    .mockResolvedValue(
      response({ workspaces: [access], legacyMembership: false }),
    );
  const app = await renderInTestApp(
    <TestApiProvider
      apis={[
        [
          discoveryApiRef,
          {
            getBaseUrl: async () =>
              'https://portal.example.test/api/tenant-management',
          },
        ],
        [fetchApiRef, { fetch }],
      ]}
    >
      <WorkspaceAccessPage />
    </TestApiProvider>,
  );
  await screen.findByRole('link', { name: 'Workspace portal' });
  return { fetch, app };
}

it('removes previously shown capabilities when the next poll is unknown', async () => {
  const f = await fixture();
  f.fetch.mockResolvedValue(response({}, false));
  await act(async () => {
    jest.advanceTimersByTime(30_000);
  });
  await screen.findByText(/We could not verify your current access/);
  expect(screen.queryByRole('link', { name: 'Workspace portal' })).toBeNull();
  expect(screen.queryByText('alice@mctl.ai')).toBeNull();
  f.app.unmount();
});

it('treats a malformed successful response as unknown and removes stale capabilities', async () => {
  const f = await fixture();
  f.fetch.mockResolvedValue(
    response({ workspaces: [{}], legacyMembership: false }),
  );
  await act(async () => {
    jest.advanceTimersByTime(30_000);
  });
  await screen.findByText(/We could not verify your current access/);
  expect(screen.queryByRole('link', { name: 'Workspace portal' })).toBeNull();
  f.app.unmount();
});

it('stops polling after navigation unmounts the page', async () => {
  const f = await fixture();
  const calls = f.fetch.mock.calls.length;
  f.app.unmount();
  await act(async () => {
    jest.advanceTimersByTime(90_000);
  });
  expect(f.fetch).toHaveBeenCalledTimes(calls);
});

it('allows a fresh manual check without preserving old grants on failure', async () => {
  const f = await fixture();
  f.fetch.mockResolvedValue(response({}, false));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() =>
    expect(screen.queryByRole('link', { name: 'Workspace portal' })).toBeNull(),
  );
  await screen.findByText(/We could not verify your current access/);
  f.app.unmount();
});
