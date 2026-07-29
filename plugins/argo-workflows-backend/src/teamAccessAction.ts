import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { DatabaseService } from '@backstage/backend-plugin-api';
import { getTenantMember, isAdminUser } from '../../tenant-backend/src/membershipLookup';

/**
 * Creates the `mctl:auth:requireTeamAccess` scaffolder action.
 *
 * Server-side authorization gate for templates whose steps derive
 * `team_name` from a user-supplied entity (e.g. `ServicePicker`, which
 * lists every team's services with no client-side ownership filter).
 * `mctl:workflow:submit` authenticates to Argo with a static service
 * token and has no notion of which Backstage user initiated the task,
 * so nothing downstream stops a non-admin from targeting another
 * team's service once the picker no longer filters client-side.
 *
 * Fails the task unless the initiating user is a verified platform
 * admin (owner role in the `admins` tenant) or a member of `team`.
 */
export function createRequireTeamAccessAction(options: {
  database: DatabaseService;
}) {
  const { database } = options;

  return createTemplateAction({
    id: 'mctl:auth:requireTeamAccess',
    description:
      'Fail the task unless the initiating user is a platform admin or a member of the given team.',
    schema: {
      input: {
        team: z => z.string().describe('Tenant/team name to check membership against'),
      },
    },
    async handler(ctx) {
      const team = ctx.input.team as string;

      const ref = ctx.user?.ref;
      if (!ref) {
        throw new Error(
          'mctl:auth:requireTeamAccess: no initiating user on this task — refusing to authorize',
        );
      }
      // Backstage user entity refs are "user:default/<username>"
      const userId = ref.split('/').pop();
      if (!userId) {
        throw new Error(`mctl:auth:requireTeamAccess: could not parse user ref "${ref}"`);
      }

      const db = await database.getClient();
      const isPostgres = db.client.config.client === 'pg';

      if (await isAdminUser(db, isPostgres, userId)) {
        return;
      }
      const member = await getTenantMember(db, isPostgres, team, userId.toLowerCase());
      if (!member) {
        throw new Error(
          `Access denied: "${userId}" is not a member of team "${team}" and is not a platform admin.`,
        );
      }
    },
  });
}
