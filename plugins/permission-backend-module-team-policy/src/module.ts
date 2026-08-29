import {
  createBackendModule,
  coreServices,
  LoggerService,
} from '@backstage/backend-plugin-api';
import {
  PolicyDecision,
  AuthorizeResult,
  isResourcePermission,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';

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

/**
 * Non-catalog permission names explicitly allowed for logged-in, non-admin
 * members. Anything not listed here (and not a catalog-entity resource
 * permission handled above) is denied by default — see module.test.ts and
 * the issue-81 proposal (platform-gitops/agents-state/mctl-portal/proposals/
 * issue-81-team-policy-deny-requests-without-a-user/) for the reasoning.
 *
 * Seeded with exactly the permissions the portal's own frontend exercises
 * today: the scaffolder actions needed to browse/run/cancel templates, and
 * the kubernetes permissions needed by the EntityPage Kubernetes tab. Add a
 * new entry here only after confirming (e.g. via the DENY warn logs below)
 * that a real, in-use portal feature needs it.
 */
const ALLOWED_NON_CATALOG_PERMISSIONS: ReadonlySet<string> = new Set([
  'scaffolder.action.execute',
  'scaffolder.task.create',
  'scaffolder.task.read',
  'scaffolder.task.cancel',
  'scaffolder.template.parameter.read',
  'scaffolder.template.step.read',
  'kubernetes.resources.read',
  'kubernetes.clusters.read',
]);

export class TeamBasedPermissionPolicy implements PermissionPolicy {
  constructor(private readonly logger: LoggerService) {}

  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    // No resolvable user identity. ServerPermissionClient resolves service
    // principals locally and never forwards them here, so a request that
    // reaches handle() with no user is always an anonymous/unauthenticated
    // caller, never a legitimate internal service-to-service call. Deny by
    // default rather than the previous fail-open ALLOW.
    if (!user) {
      this.logger.warn(
        `Denying permission "${request.permission.name}": no resolvable user`,
      );
      return { result: AuthorizeResult.DENY };
    }

    const ownership = user.info.ownershipEntityRefs ?? [];

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

    // Non-catalog permissions (scaffolder, kubernetes, search, notifications,
    // etc.) are denied by default; only the explicitly reviewed set in
    // ALLOWED_NON_CATALOG_PERMISSIONS is allowed. This also covers
    // catalog.location.* (a basic permission, not a catalog-entity resource
    // permission, so it never reaches the branch above).
    if (ALLOWED_NON_CATALOG_PERMISSIONS.has(request.permission.name)) {
      return { result: AuthorizeResult.ALLOW };
    }

    this.logger.warn(
      `Denying permission "${request.permission.name}": not in ALLOWED_NON_CATALOG_PERMISSIONS`,
    );
    return { result: AuthorizeResult.DENY };
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
        policy.setPolicy(new TeamBasedPermissionPolicy(logger));
      },
    });
  },
});
