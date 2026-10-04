import type { Knex } from 'knex';
import { parseEntityRef } from '@backstage/catalog-model';
import { getTenantMember, isAdminUser } from '../../tenant-backend/src/membershipLookup';

/**
 * Workflow parameters that name the tenant a workflow acts on. Every
 * ClusterWorkflowTemplate that touches a tenant takes one of these.
 */
const TENANT_PARAMETERS = ['team_name', 'tenant_name'] as const;

/**
 * ClusterWorkflowTemplates a team member may run in their own team's
 * namespace: the ones the portal's service templates submit (deploy,
 * update config, deploy version, retire, provision database). Every other
 * template, tenant-scoped or platform-wide, is admin-only through this
 * action, whatever its parameters say.
 */
export const TEAM_WORKFLOW_TEMPLATES = new Set([
  'deploy-service',
  'retire-service',
  'provision-database',
]);

// Roles allowed to change a tenant through a workflow. Viewers are read-only.
const WRITE_ROLES = new Set(['developer', 'owner']);

function initiatingUserId(userRef: string | undefined): string | undefined {
  if (!userRef) {
    return undefined;
  }
  try {
    const ref = parseEntityRef(userRef);
    return ref.kind.toLowerCase() === 'user' && ref.namespace === 'default'
      ? ref.name.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decides whether the task's initiator may submit a workflow with these
 * inputs. `mctl:workflow:submit` authenticates to Argo with the portal's own
 * token, so this is the only place where the initiating user is checked.
 *
 * Platform admins (owner role in the admins tenant) may submit anything.
 * Everyone else may only run one of TEAM_WORKFLOW_TEMPLATES, as a
 * ClusterWorkflowTemplate, in the namespace of a team they are a developer
 * or owner of, and every team_name / tenant_name parameter must name that
 * same team. The default (control-plane) namespace is admin-only.
 *
 * Throws with a user-facing message when the submission is not allowed.
 */
export async function authorizeWorkflowSubmission(options: {
  db: Knex;
  isPostgres: boolean;
  userRef: string | undefined;
  templateName: string;
  clusterScope: boolean;
  namespace: string;
  defaultNamespace: string;
  parameters: Record<string, string | null | undefined> | undefined;
}): Promise<void> {
  const { db, isPostgres, userRef, templateName, clusterScope, namespace, defaultNamespace, parameters } =
    options;

  const userId = initiatingUserId(userRef);
  if (!userId) {
    throw new Error(
      'mctl:workflow:submit: no initiating user on this task — refusing to submit',
    );
  }

  if (await isAdminUser(db, isPostgres, userId)) {
    return;
  }

  const denied = (why: string) =>
    new Error(`Access denied: "${userId}" is not a platform admin, and ${why}.`);

  if (!clusterScope || !TEAM_WORKFLOW_TEMPLATES.has(templateName)) {
    throw denied(`workflow "${templateName}" is not one a team may run`);
  }
  if (!namespace || namespace === defaultNamespace) {
    throw denied(`namespace "${namespace}" is not a team namespace`);
  }
  // A blank team_name/tenant_name is absent, not a mismatch: the namespace
  // membership check below applies either way.
  for (const key of TENANT_PARAMETERS) {
    const value = String(parameters?.[key] ?? '').trim();
    if (value !== '' && value !== namespace) {
      throw denied(`${key} "${value}" does not match the team namespace "${namespace}"`);
    }
  }

  const member = await getTenantMember(db, isPostgres, namespace, userId);
  if (!member || !WRITE_ROLES.has(member.role)) {
    throw new Error(
      `Access denied: "${userId}" is not a developer or owner of team "${namespace}" and is not a platform admin.`,
    );
  }
}
