import type { Knex } from 'knex';
import { VERIFIED_CREATED_BY_PREFIXES } from './store';

/** Postgres schema where github-app-connect owns the repo_connections table. */
export const GITHUB_APP_CONNECT_SCHEMA = 'github-app-connect';

/**
 * Whether `repoFullName` is connected to `team` by a verified binding.
 * For plugins other than github-app-connect that must authorize a build
 * against a team's repositories; their own Knex client points at a different
 * schema, so the query goes through withSchema() on Postgres.
 *
 * Any query error propagates. Only on SQLite (local dev, one database per
 * plugin) does a missing table read as "not connected", which callers treat
 * as a refusal, never as an allow.
 */
export async function isRepoBoundToTeam(
  db: Knex,
  isPostgres: boolean,
  team: string,
  repoFullName: string,
): Promise<boolean> {
  const builder = isPostgres
    ? db('repo_connections').withSchema(GITHUB_APP_CONNECT_SCHEMA)
    : db('repo_connections');
  try {
    const row = await builder
      .where({ team_id: team })
      .andWhereRaw('lower(repo_full_name) = ?', [repoFullName.toLowerCase()])
      .andWhere(w => {
        for (const prefix of VERIFIED_CREATED_BY_PREFIXES) {
          w.orWhere('created_by', 'like', `${prefix}%`);
        }
      })
      .first();
    return !!row;
  } catch (err: any) {
    if (!isPostgres && /no such table: repo_connections/i.test(String(err?.message))) {
      return false;
    }
    throw err;
  }
}
