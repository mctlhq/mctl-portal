import type { Knex } from 'knex';
import { parseEntityRef } from '@backstage/catalog-model';
import { getTenantMember, isAdminUser } from '../../tenant-backend/src/membershipLookup';
import { isRepoBoundToTeam } from '../../github-app-connect-backend/src/bindingLookup';

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

/**
 * Workflow parameters naming a GitHub repository the platform builds. The
 * build mints a GitHub App token for whatever repository it is given, so the
 * repository must belong to the team: connected to it through
 * github-app-connect, or public.
 */
const BUILD_REPO_PARAMETERS = ['dockerfile_repo'] as const;

const REPO_FULL_NAME_RE = /^(?!\.+\/)[\w.-]+\/(?![\w.-]*\/)(?!\.+$)[\w.-]+$/;

/**
 * Team templates whose component_name is an image name: deploy-service
 * builds into and runs ghcr.io/mctlhq/<component_name>.
 */
const IMAGE_TEMPLATES = new Set(['deploy-service']);

// Image names the platform keeps for itself; a team may use one only for a
// component the catalog already shows as its own.
const RESERVED_IMAGE_PREFIX = 'mctl-';

/** Teams that own catalog Components with this name (labels.team, else spec.owner). */
export type ComponentOwnersLookup = (name: string) => Promise<string[]>;

/**
 * GitHub's own answer, unauthenticated: public only on 200 with
 * `private: false`. Anything else (404, rate limit, error, malformed body)
 * is not public.
 */
export async function isPublicGithubRepo(repoFullName: string): Promise<boolean> {
  try {
    const resp = await fetch(`https://api.github.com/repos/${repoFullName}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (resp.status !== 200) return false;
    const body = (await resp.json()) as { private?: unknown };
    return body.private === false;
  } catch {
    return false;
  }
}

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
 * same team. The default (control-plane) namespace is admin-only. For an
 * image-producing template, component_name may not name another team's
 * component, nor a new `mctl-` image. A
 * repository to build (dockerfile_repo) must be connected to that team, or
 * be public.
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
  componentOwners?: ComponentOwnersLookup;
}): Promise<void> {
  const { db, isPostgres, userRef, templateName, clusterScope, namespace, defaultNamespace, parameters, componentOwners } =
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

  const component = String(parameters?.component_name ?? '').trim();
  if (IMAGE_TEMPLATES.has(templateName) && component) {
    if (!componentOwners) {
      throw denied('the catalog is not available to check the image name');
    }
    // A lookup error propagates: an unreadable catalog is not "no owner".
    const owners = await componentOwners(component);
    const other = owners.find(o => o !== namespace);
    if (other) {
      throw denied(`image name "${component}" belongs to team "${other}"`);
    }
    if (component.startsWith(RESERVED_IMAGE_PREFIX) && !owners.includes(namespace)) {
      throw denied(`image names starting with "${RESERVED_IMAGE_PREFIX}" are reserved for the platform`);
    }
  }

  for (const key of BUILD_REPO_PARAMETERS) {
    const repo = String(parameters?.[key] ?? '').trim();
    if (!repo) continue;
    if (!REPO_FULL_NAME_RE.test(repo)) {
      throw new Error(`Access denied: "${repo}" is not a GitHub repository name (owner/name).`);
    }
    if (!(await isRepoBoundToTeam(db, isPostgres, namespace, repo)) && !(await isPublicGithubRepo(repo))) {
      throw new Error(
        `Access denied: repository "${repo}" is not connected to team "${namespace}" and is not public. Connect it from the repository picker first.`,
      );
    }
  }
}
