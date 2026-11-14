import { render, screen, waitFor } from '@testing-library/react';
import { TestApiProvider } from '@backstage/test-utils';
import { discoveryApiRef, fetchApiRef } from '@backstage/core-plugin-api';
import { TenantNameFieldComponent, availabilityFromStatus } from './TenantNameField';

describe('availabilityFromStatus', () => {
  it('reads only 200 and 404 as an answer', () => {
    expect(availabilityFromStatus(200)).toBe('taken');
    expect(availabilityFromStatus(404)).toBe('free');
    for (const s of [401, 403, 429, 500, 502]) expect(availabilityFromStatus(s)).toBe('unknown');
  });
});

describe('TenantNameField', () => {
  const realFetch = (global as any).fetch;
  afterEach(() => {
    (global as any).fetch = realFetch;
  });

  function renderField(status: number, formData = 'labs') {
    const authFetch = jest.fn().mockResolvedValue({ status, ok: status >= 200 && status < 300 });
    // A bare fetch carries no Backstage token; the backend answers 401.
    const bareFetch = jest.fn().mockResolvedValue({ status: 401, ok: false });
    (global as any).fetch = bareFetch;
    const props = {
      onChange: jest.fn(),
      rawErrors: [],
      required: true,
      schema: { title: 'Tenant Name', description: 'desc' },
      formData,
    } as any;
    render(
      <TestApiProvider
        apis={[
          [discoveryApiRef, { getBaseUrl: async () => 'http://backend/api/tenant-management' }],
          [fetchApiRef, { fetch: authFetch }],
        ]}
      >
        <TenantNameFieldComponent {...props} />
      </TestApiProvider>,
    );
    return { authFetch, bareFetch };
  }

  it('checks with the authenticated fetch and reports a taken name (old code used a bare fetch, got 401, showed "free")', async () => {
    const { authFetch, bareFetch } = renderField(200);
    await waitFor(() => expect(screen.getByText('Tenant "labs" already exists')).toBeTruthy());
    expect(authFetch).toHaveBeenCalledWith('http://backend/api/tenant-management/tenants/labs');
    expect(bareFetch).not.toHaveBeenCalled();
  });

  it('says it could not check on anything but 200 or 404', async () => {
    renderField(401);
    await waitFor(() => expect(screen.getByText('Could not check whether "labs" is available')).toBeTruthy());
    expect(screen.queryByText('Tenant "labs" already exists')).toBeNull();
  });

  it('checks a 31-character name with no format error', async () => {
    const name31 = `a${'b'.repeat(30)}`;
    const { authFetch } = renderField(404, name31);
    await waitFor(() => expect(authFetch).toHaveBeenCalledWith(`http://backend/api/tenant-management/tenants/${name31}`));
    expect(screen.queryByText(/2-31 chars/)).toBeNull();
  });

  it('shows the format error for a 32-character name and never checks it', async () => {
    const { authFetch } = renderField(404, `a${'b'.repeat(31)}`);
    expect(screen.getByText(/2-31 chars/)).toBeTruthy();
    await new Promise(r => setTimeout(r, 500));
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('shows the name as free on 404', async () => {
    const { authFetch } = renderField(404);
    await waitFor(() => expect(authFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('desc')).toBeTruthy());
    expect(screen.queryByText(/Could not check/)).toBeNull();
  });
});
