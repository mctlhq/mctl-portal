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

    // Admin team owners get full access. Check admins-owners (virtual marker group) rather than
    // the main admins group — the main group includes all roles (developer/viewer too).
    if (ownership.some(ref => ref === 'group:default/admins-owners')) {
      return { result: AuthorizeResult.ALLOW };
    }

    // Viewer role: deny scaffolder task creation (read-only users)
    if (isViewerRole(ownership) && request.permission.name.startsWith('scaffolder.')) {
      return { result: AuthorizeResult.DENY };
    }

    // For catalog entity permissions, return a conditional decision that
    // filters entities based on team membership:
    //   - Domain, Location: hidden from non-admins
    //   - Group, User: only those belonging to the user's team (spec.owner = user's group)
    //   - System: only those owned by user's groups
    //   - Component/API/Resource: only those owned by user's groups (unchanged)
    //   - Template: global admin templates (owned by admins, not admin-only) OR owned by user's group
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
            // Group-specific templates: owned by user's group
            {
              allOf: [
                catalogConditions.isEntityKind({ kinds: ['Template'] }),
                catalogConditions.isEntityOwner({ claims: ownership }),
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
