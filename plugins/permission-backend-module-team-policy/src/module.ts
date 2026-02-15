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
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';
import { BackstageIdentityResponse } from '@backstage/plugin-auth-node';

const ADMIN_TEAM = 'dmitriimashkov/admin';

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

    // For catalog entity permissions, filter by kind + ownership
    if (isResourcePermission(request.permission, 'catalog-entity')) {
      return createCatalogConditionalDecision(
        request.permission,
        {
          anyOf: [
            // Templates, Groups, Users visible to everyone
            catalogConditions.isEntityKind({ kinds: ['template', 'group', 'user'] }),
            // Owned entities of workload kinds only
            {
              allOf: [
                catalogConditions.isEntityKind({
                  kinds: ['component', 'api', 'resource', 'system'],
                }),
                catalogConditions.isEntityOwner({ claims: ownership }),
              ],
            },
          ],
        },
      );
    }

    // Allow all other permissions (scaffolder, search, etc.)
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
