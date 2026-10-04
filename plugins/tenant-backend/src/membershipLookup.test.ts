import type { Knex } from 'knex';
import { isPostgresClient } from './membershipLookup';

// Every plugin that reads tenant-management's tables decides withSchema()
// with this helper, so all Knex names for the Postgres client must count.
describe('isPostgresClient', () => {
  const db = (client: unknown) => ({ client: { config: { client } } }) as unknown as Knex;

  it.each(['pg', 'postgres', 'postgresql'])('recognises %s', client => {
    expect(isPostgresClient(db(client))).toBe(true);
  });

  it.each(['better-sqlite3', 'sqlite3', undefined])('rejects %s', client => {
    expect(isPostgresClient(db(client))).toBe(false);
  });
});
