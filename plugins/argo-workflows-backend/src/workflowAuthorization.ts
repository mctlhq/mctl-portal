import type { Knex } from 'knex';
import { getTenantMember, isAdminUser } from '../../tenant-backend/src/membershipLookup';

/**
 * Workflow parameters that name the tenant a workflow acts on. Every
 * ClusterWorkflowTemplate that touches a tenant takes one of these.
 */
const TENANT_PARAMETERS = ['team_name', 'tenant_name'] as const;

// Roles allowed to change a tenant through a workflow. Viewers are read-only.
const WRITE_ROLES = new Set(['developer', 'owner']);

/**
 * Decides whether the task's initiator may submit a workflow with these
 * inputs. `mctl:workflow:submit` authenticates to Argo with the portal's own
 * token, so this is the only place where the initiating user is checked.
 *
 * Platform admins (owner role in the admins tenant) may submit anything.
 * Everyone else must be a developer or owner of every tenant the submission
 * names: the Argo namespace when it is not the default one, and the
 * team_name / tenant_name parameters. A submission that names no tenant at
 * all is platform-wide and therefore admin-only.
 *
 * Throws with a user-facing message when the submission is not allowed.
 */
export async function authorizeWorkflowSubmission(options: {
  db: Knex;
  isPostgres: boolean;
  userRef: string | undefined;
  namespace: string;
  defaultNamespace: string;
  parameters: Record<string, string | null | undefined> | undefined;
}): Promise<void> {
  const { db, isPostgres, userRef, namespace, defaultNamespace, parameters } = options;

  // Backstage user entity refs are "user:default/<username>"
  const userId = userRef?.startsWith('user:default/')
    ? userRef.slice('user:default/'.length).toLowerCase()
    : undefined;
  if (!userId) {
    throw new Error(
      'mctl:workflow:submit: no initiating user on this task — refusing to submit',
    );
  }

  if (await isAdminUser(db, isPostgres, userId)) {
    return;
  }

  const tenants = new Set<string>();
  if (namespace !== defaultNamespace) {
    tenants.add(namespace);
  }
  for (const key of TENANT_PARAMETERS) {
    const value = parameters?.[key];
    if (value !== undefined && value !== null) {
      tenants.add(String(value).trim());
    }
  }
  if (tenants.size === 0) {
    throw new Error(
      `Access denied: "${userId}" is not a platform admin, and this workflow does not target a team.`,
    );
  }

  for (const tenant of tenants) {
    const member = tenant ? await getTenantMember(db, isPostgres, tenant, userId) : undefined;
    if (!member || !WRITE_ROLES.has(member.role)) {
      throw new Error(
        `Access denied: "${userId}" is not a developer or owner of team "${tenant}" and is not a platform admin.`,
      );
    }
  }
}
