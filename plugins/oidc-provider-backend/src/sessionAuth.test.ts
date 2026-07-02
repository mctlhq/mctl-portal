import knexLib, { Knex } from 'knex';
import {
  OIDC_SESSION_COOKIE,
  parseCookie,
  readOidcSessionUserId,
} from './sessionAuth';

describe('parseCookie', () => {
  it('extracts the named cookie value', () => {
    expect(parseCookie('a=1; oidc_session=abc; b=2', 'oidc_session')).toBe('abc');
  });

  it('trims surrounding whitespace between cookie pairs', () => {
    expect(parseCookie('  oidc_session=xyz  ', 'oidc_session')).toBe('xyz');
  });

  it('returns undefined when the cookie is absent', () => {
    expect(parseCookie('a=1; b=2', 'oidc_session')).toBeUndefined();
  });

  it('does not match a cookie whose name is only a suffix', () => {
    expect(parseCookie('not_oidc_session=abc', 'oidc_session')).toBeUndefined();
  });

  it('returns an empty string for a value-less cookie', () => {
    expect(parseCookie('oidc_session=', 'oidc_session')).toBe('');
  });
});

let currentKnex: Knex | undefined;
afterEach(async () => {
  await currentKnex?.destroy();
  currentKnex = undefined;
});

async function freshDb(): Promise<Knex> {
  const knex = knexLib({
    client: 'better-sqlite3',
    connection: ':memory:',
    useNullAsDefault: true,
  });
  await knex.schema.createTable('oidc_sessions', t => {
    t.string('session_id').primary();
    t.string('user_id').notNullable();
    t.bigInteger('expires_at').notNullable();
  });
  return knex;
}

function cookie(sessionId: string): string {
  return `${OIDC_SESSION_COOKIE}=${sessionId}`;
}

describe('readOidcSessionUserId', () => {
  const now = 1_000_000;

  it('returns the user id for a valid, unexpired session', async () => {
    const knex = await freshDb();
    currentKnex = knex;
    await knex('oidc_sessions').insert({
      session_id: 's1',
      user_id: 'mashkovd',
      expires_at: now + 10_000,
    });
    expect(await readOidcSessionUserId(cookie('s1'), knex, false, now)).toBe('mashkovd');
  });

  it('returns undefined when the cookie header is missing', async () => {
    const knex = await freshDb();
    currentKnex = knex;
    expect(await readOidcSessionUserId(undefined, knex, false, now)).toBeUndefined();
  });

  it('returns undefined when the session id is unknown', async () => {
    const knex = await freshDb();
    currentKnex = knex;
    expect(await readOidcSessionUserId(cookie('ghost'), knex, false, now)).toBeUndefined();
  });

  it('returns undefined for an expired session', async () => {
    const knex = await freshDb();
    currentKnex = knex;
    await knex('oidc_sessions').insert({
      session_id: 's2',
      user_id: 'expired',
      expires_at: now - 1,
    });
    expect(await readOidcSessionUserId(cookie('s2'), knex, false, now)).toBeUndefined();
  });

  it('treats a session expiring exactly now as expired', async () => {
    const knex = await freshDb();
    currentKnex = knex;
    await knex('oidc_sessions').insert({
      session_id: 's3',
      user_id: 'edge',
      expires_at: now,
    });
    expect(await readOidcSessionUserId(cookie('s3'), knex, false, now)).toBeUndefined();
  });
});
