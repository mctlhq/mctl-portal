import { buildTenantCatalogEntities } from './catalogEntities';
import { Tenant, TenantMember } from './types';

describe('buildTenantCatalogEntities', () => {
  const tenants: Tenant[] = [
    {
      name: 'labs',
      displayName: 'Labs',
      contactEmail: 'owner@example.com',
      quotas: {
        'requests.cpu': '1',
        'requests.memory': '1Gi',
        'limits.cpu': '2',
        'limits.memory': '2Gi',
        pods: '10',
      },
      networking: {
        allowIntraNamespace: true,
        allowClusterEgress: true,
        allowInternetEgress: false,
      },
      syncedAt: '2026-08-14T00:00:00Z',
    },
  ];
  const members: TenantMember[] = [
    {
      tenantName: 'labs',
      userId: 'alice',
      role: 'owner',
      invitedAt: '2026-08-14T00:00:00Z',
      invitedBy: 'system',
    },
  ];

  it('emits Group, System, and User entities without a query-token location', () => {
    const entities = buildTenantCatalogEntities(tenants, members);
    expect(entities.map(e => e.kind).sort()).toEqual(['Group', 'System', 'User']);
    const group = entities.find(e => e.kind === 'Group')!;
    expect(group.metadata.name).toBe('labs');
    expect(group.spec?.profile).toEqual(
      expect.objectContaining({ email: 'owner@example.com' }),
    );
    expect(group.metadata.annotations?.['backstage.io/managed-by-location']).toBe(
      'tenant-management:tenant-catalog',
    );
    expect(JSON.stringify(entities)).not.toContain('token=');
  });
});

describe('principal-keyed members (stage C2)', () => {
  const tenant = (name: string): Tenant => ({
    name,
    displayName: name,
    quotas: { 'requests.cpu': '1', 'requests.memory': '1Gi', 'limits.cpu': '2', 'limits.memory': '2Gi', pods: '10' },
    networking: { allowIntraNamespace: true, allowClusterEgress: true, allowInternetEgress: false },
    syncedAt: '2026-10-16T00:00:00Z',
  });
  const BOB = 'prn_01M45DR1GWC87109EH88VBJX25';
  // Alice was `alice` on GitHub and is login-keyed; Bob registered the login
  // after Alice gave it up and signed up as a self-service customer.
  const alice: TenantMember = {
    tenantName: 'labs', userId: 'alice', role: 'owner', invitedAt: 't', invitedBy: 'system',
  };
  const bob: TenantMember = {
    tenantName: 'bobs', userId: BOB.toLowerCase(), role: 'owner', invitedAt: 't', invitedBy: 'system',
    catalogKey: 'principal', principalId: BOB, login: 'alice',
  };
  const entities = buildTenantCatalogEntities([tenant('labs'), tenant('bobs')], [alice, bob]);
  const user = (name: string) => entities.find(e => e.kind === 'User' && e.metadata.name === name);
  const group = (name: string) => entities.find(e => e.kind === 'Group' && e.metadata.name === name);

  it('names the customer by principal and shows the login only as display', () => {
    const u = user(BOB.toLowerCase())!;
    expect(u.spec?.profile).toEqual({ displayName: 'alice' });
    expect(u.spec?.memberOf).toEqual(['bobs']);
    expect(u.metadata.annotations).toEqual(
      expect.objectContaining({ 'mctl.me/principal-id': BOB, 'mctl.me/github-login': 'alice' }),
    );
    // The login can pass to another person; it is never an identity annotation.
    expect(u.metadata.annotations).not.toHaveProperty('github.com/user-login');
  });

  it('keeps the login-keyed user and the two groups apart', () => {
    expect(user('alice')!.metadata.annotations).toEqual(
      expect.objectContaining({ 'github.com/user-login': 'alice' }),
    );
    expect(group('labs')!.spec?.members).toEqual(['alice']);
    expect(group('bobs')!.spec?.members).toEqual([BOB.toLowerCase()]);
  });
});
