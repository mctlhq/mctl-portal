import {
  createBackendModule,
  coreServices,
  LoggerService,
} from '@backstage/backend-plugin-api';
import {
  PolicyDecision,
  AuthorizeResult,
  isResourcePermission,
  PermissionCriteria,
  PermissionCondition,
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
/**
 * One arm of the catalog-entity `anyOf`. Named so the arm array can be given
 * an explicit non-empty-tuple type — see the `anyOf` declaration in `handle()`.
 */
type CatalogCriteria = PermissionCriteria<PermissionCondition<'catalog-entity'>>;

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
 *
 * Why this set is complete, verified against the versions in yarn.lock:
 *
 * - Nothing in this repository defines a permission of its own. There is no
 *   createPermission/definePermission call and no permissions.authorize()
 *   caller anywhere under plugins/ or packages/, so the entire surface this
 *   policy can ever see comes from installed upstream plugins.
 * - Upstream Backstage declares permissions in exactly five packages:
 *   catalog-common, scaffolder-common, kubernetes-common, devtools-common
 *   and example-todo-list-common. Only the first three are registered in
 *   packages/backend/src/index.ts.
 * - Search and notifications are NOT missing from this list — they have no
 *   permissions at all. plugin-search-common and plugin-notifications-common
 *   contain zero createPermission calls. plugin-search-backend authorizes
 *   per document type using each collator's declared visibilityPermission
 *   (see AuthorizedSearchEngine, `this.types[type]?.visibilityPermission`),
 *   which for the catalog and techdocs collators is catalog.entity.read — a
 *   catalog-entity RESOURCE permission, so it takes the conditional branch
 *   above and never reaches this set. Notifications are scoped by recipient
 *   and never enter the permission framework.
 * - plugin-scaffolder-backend enforces seven permissions: the six listed
 *   below plus scaffolder.template.management, which is an admin operation
 *   and is intentionally denied for members. (scaffolder.template.dry-run
 *   exists upstream but is not enforced by the installed version, so the
 *   template editor in the /create context menu produces no DENY.)
 * - catalog.entity.create, catalog.entity.validate and all four
 *   catalog.location.* are BASIC permissions upstream (no resourceType), so
 *   they land here and are denied. That is intended and breaks no template:
 *   the templates under platform-gitops/backstage/templates/ use only
 *   catalog:fetch, http:backstage:request and the mctl:* actions — none uses
 *   catalog:register or catalog:write, so no run can stop half-completed.
 *
 * Re-run those checks before concluding that a newly denied permission is a
 * regression rather than the intended tightening.
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

    // The permission's action, used both by the viewer gate below and by the
    // catalog-entity anyOf assembly further down, so the two enforcement
    // points cannot drift apart. A catalog-entity permission whose action is
    // missing or unrecognized is deliberately treated as non-read (fail
    // closed): the admin-template arm is dropped and viewers are denied,
    // rather than defaulting to permissive. This should never happen against
    // a working Backstage install; if it starts happening (e.g. after an
    // upstream upgrade renames/drops the attribute), the warn below is the
    // only signal that shared templates silently stopped being visible.
    const action = request.permission.attributes?.action;
    const isReadAction = action === 'read';
    if (isResourcePermission(request.permission, 'catalog-entity') && action === undefined) {
      this.logger.warn(
        `catalog-entity permission "${request.permission.name}" arrived with no attributes.action; treating as non-read (fail closed)`,
      );
    }

    // Viewer role: read-only users. Deny scaffolder task creation outright,
    // and deny any catalog-entity resource permission whose action is not
    // read (delete/refresh) — even on entities their own team owns. Viewer
    // read access (action === 'read') is unaffected and falls through to the
    // catalog-entity conditional branch below.
    if (isViewerRole(ownership)) {
      if (request.permission.name.startsWith('scaffolder.')) {
        return { result: AuthorizeResult.DENY };
      }
      if (isResourcePermission(request.permission, 'catalog-entity') && !isReadAction) {
        return { result: AuthorizeResult.DENY };
      }
    }

    // For catalog entity permissions, return a conditional decision that
    // filters entities based on team membership:
    //   - Domain, Location: hidden from non-admins
    //   - Group, User: only those belonging to the user's team (spec.owner = user's group)
    //   - System: only those owned by user's groups
    //   - Component/API/Resource: only those owned by user's groups (unchanged)
    //   - Template: global admin templates (owned by admins, not admin-only), read-only —
    //     included in the anyOf only when the action is `read`, so members can see and run
    //     shared templates but cannot delete/refresh (mutate) them — OR owned by user's group
    //     (delete/refresh of a team's own templates is unchanged, per team-scoped arms below)
    if (isResourcePermission(request.permission, 'catalog-entity')) {
      // Annotated rather than inferred, as a non-empty tuple. Left to
      // inference, the element type comes from the five literals below — none
      // of which use `not` — so the conditional admin-template arm fails to
      // type-check; and a plain `T[]` would not satisfy the `NonEmptyArray`
      // that `createCatalogConditionalDecision` requires. The tuple form keeps
      // both facts in the type instead of asserting them away.
      const anyOf: [CatalogCriteria, ...CatalogCriteria[]] = [
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
        // Group-specific templates: owned by user's group
        {
          allOf: [
            catalogConditions.isEntityKind({ kinds: ['Template'] }),
            catalogConditions.isEntityOwner({ claims: ownership }),
          ],
        },
      ];

      // Global admin templates: owned by admins and NOT admin-only restricted.
      // Read-only — only included for the read action, so delete/refresh can
      // never be granted via this arm (see issue-102).
      if (isReadAction) {
        anyOf.push({
          allOf: [
            catalogConditions.isEntityKind({ kinds: ['Template'] }),
            catalogConditions.isEntityOwner({ claims: ['group:default/admins'] }),
            { not: catalogConditions.hasAnnotation({ annotation: 'mctl.me/admin-only' }) },
          ],
        });
      }

      // Domain and Location are intentionally omitted → DENY for non-admins
      return createCatalogConditionalDecision(request.permission, { anyOf });
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
