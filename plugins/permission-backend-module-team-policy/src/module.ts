import {
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import {
  PolicyDecision,
  AuthorizeResult,
  isResourcePermission,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
} from '@backstage/plugin-permission-node';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import { BackstageIdentityResponse } from '@backstage/plugin-auth-node';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';

const ADMIN_TEAM = 'mctlhq/admins';

/**
 * Roles and enforcement strategy:
 *
 *   owner     — Full access to tenant resources + can invite/manage members (enforced in tenant-backend API)
 *   developer — Can deploy services, view secrets (enforced in tenant-backend API + vault-secrets)
 *   viewer    — Read-only: can see catalog entities but NOT run scaffolder tasks
 *
 * Viewer restriction is encoded via a marker group: group:default/viewer-{tenantName}.
 * The catalog.yaml endpoint emits this additional group for viewer-role users.
 * Owner and developer users do NOT have this marker.
 *
 * Catalog visibility (all roles): entities owned by group:default/{tenantName}.
 */
function isViewerRole(ownershipEntityRefs: string[]): boolean {
  return ownershipEntityRefs.some(ref => ref.startsWith('group:default/viewer-'));
}

// Claims with viewer-marked tenant groups removed. Used to restrict template
// visibility for mixed-role users (viewer in tenantA, owner in tenantB):
// they can see tenantA catalog entities but NOT tenantA templates, which
// prevents them from creating scaffolder tasks scoped to tenantA while
// retaining full access to tenantB. For pure viewers the result is an empty
// set of group claims, so no templates are visible either.
function nonViewerClaims(ownershipEntityRefs: string[]): string[] {
  const viewerTenants = new Set(
    ownershipEntityRefs
      .filter(ref => ref.startsWith('group:default/viewer-'))
      .map(ref => ref.slice('group:default/viewer-'.length)),
  );
  return ownershipEntityRefs.filter(ref => {
    if (!ref.startsWith('group:default/')) return true;
    if (ref.startsWith('group:default/viewer-')) return false;
    return !viewerTenants.has(ref.slice('group:default/'.length));
  });
}

class TeamBasedPermissionPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: BackstageIdentityResponse,
  ): Promise<PolicyDecision> {
    // Allow unauthenticated service-to-service calls
    if (!user) {
      return { result: AuthorizeResult.ALLOW };
    }

    const ownership = user.identity.ownershipEntityRefs ?? [];

    // Admin team gets full access
    if (ownership.some(ref => ref === `group:default/${ADMIN_TEAM.split('/')[1]}`)) {
      return { result: AuthorizeResult.ALLOW };
    }

    // Claims with viewer-tenant groups stripped: used for template visibility so that
    // a viewer in tenantA cannot see or run tenantA templates even if they are an
    // owner/developer in another tenant. Pure viewers end up with no group claims here
    // → no templates visible → scaffolder tasks naturally unavailable without a blunt
    // global deny that would break mixed-role users.
    const templateClaims = nonViewerClaims(ownership);

    // For catalog entity permissions, return a conditional decision that
    // filters entities based on team membership:
    //   - Domain, Location: hidden from non-admins
    //   - Group, User: only those belonging to the user's team (spec.owner = user's group)
    //   - System: only those owned by user's groups
    //   - Component/API/Resource: only those owned by user's groups (unchanged)
    //   - Template: global admin templates (owned by admins, not admin-only) OR owned by
    //               non-viewer memberships only (prevents viewers from running templates
    //               in tenants where they have read-only access)
    if (isResourcePermission(request.permission, 'catalog-entity')) {
      return createCatalogConditionalDecision(
        request.permission,
        {
          anyOf: [
            // Groups: only the user's own team group(s)
            {
              allOf: [
                catalogConditions.isEntityKind({ kinds: ['Group'] }),
                catalogConditions.isEntityOwner({ claims: ownership }),
              ],
            },
            // Users: only teammates (same group owner)
            {
              allOf: [
                catalogConditions.isEntityKind({ kinds: ['User'] }),
                catalogConditions.isEntityOwner({ claims: ownership }),
              ],
            },
            // Systems: only those owned by user's groups
            {
              allOf: [
                catalogConditions.isEntityKind({ kinds: ['System'] }),
                catalogConditions.isEntityOwner({ claims: ownership }),
              ],
            },
            // Components, APIs, Resources: owned by user's groups
            {
              allOf: [
                catalogConditions.isEntityKind({ kinds: ['Component', 'API', 'Resource'] }),
                catalogConditions.isEntityOwner({ claims: ownership }),
              ],
            },
            // Global admin templates: owned by admins and NOT admin-only restricted
            {
              allOf: [
                catalogConditions.isEntityKind({ kinds: ['Template'] }),
                catalogConditions.isEntityOwner({ claims: ['group:default/admins'] }),
                { not: catalogConditions.hasAnnotation({ annotation: 'mctl.me/admin-only' }) },
              ],
            },
            // Group-specific templates: only via non-viewer memberships
            {
              allOf: [
                catalogConditions.isEntityKind({ kinds: ['Template'] }),
                catalogConditions.isEntityOwner({ claims: templateClaims }),
              ],
            },
            // Domain and Location are intentionally omitted → DENY for non-admins
          ],
        },
      );
    }

    // Allow all other permissions (search, notifications, etc.)
    return { result: AuthorizeResult.ALLOW };
  }
}

export const teamPolicyModule = createBackendModule({
  pluginId: 'permission',
  moduleId: 'team-policy',
  register(reg) {
    reg.registerInit({
      deps: {
        policy: policyExtensionPoint,
        logger: coreServices.logger,
      },
      async init({ policy, logger }) {
        logger.info('Registering team-based permission policy');
        policy.setPolicy(new TeamBasedPermissionPolicy());
      },
    });
  },
});
