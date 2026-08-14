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
