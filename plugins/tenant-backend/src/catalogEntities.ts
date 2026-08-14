import { Entity } from '@backstage/catalog-model';
import { Tenant, TenantMember } from './types';

const LOCATION_REF = 'tenant-management:tenant-catalog';

function withLocation(entity: Entity): Entity {
  entity.metadata.annotations = {
    ...entity.metadata.annotations,
    'backstage.io/managed-by-location': LOCATION_REF,
    'backstage.io/managed-by-origin-location': LOCATION_REF,
  };
  return entity;
}

/**
 * User / Group / System entities derived from the tenant DB.
 * Shared by the in-process catalog provider and the Bearer-only YAML export.
 */
export function buildTenantCatalogEntities(
  tenants: Tenant[],
  allMembers: TenantMember[],
): Entity[] {
  const docs: Entity[] = [];

  for (const tenant of tenants) {
    const tenantMembers = allMembers.filter(m => m.tenantName === tenant.name);
    const viewers = tenantMembers.filter(m => m.role === 'viewer').map(m => m.userId);

    docs.push(
      withLocation({
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Group',
        metadata: {
          name: tenant.name,
          namespace: 'default',
          title: tenant.displayName,
          ...(tenant.description ? { description: tenant.description } : {}),
          annotations: {
            'mctl.me/tenant-name': tenant.name,
          },
        },
        spec: {
          type: 'team',
          owner: `group:default/${tenant.name}`,
          profile: {
            displayName: tenant.displayName,
            ...(tenant.contactEmail ? { email: tenant.contactEmail } : {}),
          },
          children: [],
          members: tenantMembers.map(m => m.userId),
        },
      }),
    );

    if (tenant.name === 'admins') {
      const owners = tenantMembers.filter(m => m.role === 'owner').map(m => m.userId);
      if (owners.length > 0) {
        docs.push(
          withLocation({
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Group',
            metadata: {
              name: 'admins-owners',
              namespace: 'default',
              title: 'Platform Admins (Owners)',
              annotations: {
                'mctl.me/tenant-name': 'admins',
                'mctl.me/role-marker': 'owner',
              },
            },
            spec: {
              type: 'virtual',
              owner: 'group:default/admins',
              profile: { displayName: 'Platform Admins (Owners)' },
              children: [],
              members: owners,
            },
          }),
        );
      }
    }

    if (viewers.length > 0) {
      docs.push(
        withLocation({
          apiVersion: 'backstage.io/v1alpha1',
          kind: 'Group',
          metadata: {
            name: `viewer-${tenant.name}`,
            namespace: 'default',
            title: `${tenant.displayName} (Viewers)`,
            annotations: {
              'mctl.me/tenant-name': tenant.name,
              'mctl.me/role-marker': 'viewer',
            },
          },
          spec: {
            type: 'virtual',
            owner: `group:default/${tenant.name}`,
            profile: { displayName: `${tenant.displayName} Viewers` },
            children: [],
            members: viewers,
          },
        }),
      );
    }
  }

  for (const tenant of tenants) {
    docs.push(
      withLocation({
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'System',
        metadata: {
          name: `team-${tenant.name}`,
          namespace: 'default',
          description: `${tenant.displayName} workloads`,
          annotations: {
            'mctl.me/tenant-name': tenant.name,
          },
        },
        spec: {
          owner: `group:default/${tenant.name}`,
        },
      }),
    );
  }

  const userMap = new Map<string, TenantMember>();
  for (const m of allMembers) {
    if (!userMap.has(m.userId)) userMap.set(m.userId, m);
  }
  for (const [userId, member] of userMap.entries()) {
    const memberOf = [member.tenantName];
    if (member.role === 'viewer') memberOf.push(`viewer-${member.tenantName}`);
    docs.push(
      withLocation({
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'User',
        metadata: {
          name: userId,
          namespace: 'default',
          annotations: {
            'github.com/user-login': userId,
            'mctl.me/tenant-role': member.role,
          },
        },
        spec: {
          profile: { displayName: userId },
          memberOf,
          owner: `group:default/${member.tenantName}`,
        },
      }),
    );
  }

  return docs;
}
