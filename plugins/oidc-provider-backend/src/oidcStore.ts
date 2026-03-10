import { Knex } from 'knex';
import { LoggerService } from '@backstage/backend-plugin-api';

/**
 * Persistent store for OIDC authorization codes, sessions, pending auths,
 * and access tokens. Replaces the former in-memory Maps so that state
 * survives pod restarts.
 *
 * Uses the same Knex client shared by all Backstage plugins.
 * Tables live in the oidc-provider schema (Postgres) or are
 * prefixed with `oidc_` (SQLite).
 */
export class OidcStore {
  constructor(
    private readonly db: Knex,
    private readonly logger: LoggerService,
    private readonly isPostgres: boolean,
  ) {}

  // ── Init (create tables if needed) ────────────────────────────────

  async init(): Promise<void> {
    const knex = this.db;
    const schema = this.isPostgres ? 'oidc-provider' : undefined;

    const hasTable = async (name: string) =>
      schema
        ? knex.schema.withSchema(schema).hasTable(name)
        : knex.schema.hasTable(name);

    const createTable = (name: string, builder: (t: Knex.CreateTableBuilder) => void) =>
      schema
        ? knex.schema.withSchema(schema).createTable(name, builder)
        : knex.schema.createTable(name, builder);

    if (!(await hasTable('oidc_codes'))) {
      await createTable('oidc_codes', t => {
        t.string('code', 128).primary().notNullable();
        t.string('user_id', 128).notNullable();
        t.string('client_id', 256).notNullable();
        t.string('redirect_uri', 2048).notNullable();
        t.bigInteger('expires_at').notNullable();
        t.string('nonce', 256).nullable();
      });
    }

    if (!(await hasTable('oidc_sessions'))) {
      await createTable('oidc_sessions', t => {
        t.string('session_id', 128).primary().notNullable();
        t.string('user_id', 128).notNullable();
        t.bigInteger('expires_at').notNullable();
      });
    }

    if (!(await hasTable('oidc_pending_auths'))) {
      await createTable('oidc_pending_auths', t => {
        t.string('state', 128).primary().notNullable();
        t.text('return_to').notNullable();
        t.bigInteger('expires_at').notNullable();
      });
    }

    if (!(await hasTable('oidc_access_tokens'))) {
      await createTable('oidc_access_tokens', t => {
        t.string('token', 128).primary().notNullable();
        t.string('user_id', 128).notNullable();
        t.bigInteger('expires_at').notNullable();
      });
    }

    this.logger.info('[OIDC Store] Tables initialized');
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private table(name: string) {
    return this.isPostgres
      ? this.db(name).withSchema('oidc-provider')
      : this.db(name);
  }

  // ── Authorization Codes ────────────────────────────────────────────

  async saveCode(
    code: string,
    data: { userId: string; clientId: string; redirectUri: string; expiresAt: number; nonce?: string },
  ): Promise<void> {
    await this.table('oidc_codes').insert({
      code,
      user_id: data.userId,
      client_id: data.clientId,
      redirect_uri: data.redirectUri,
      expires_at: data.expiresAt,
      nonce: data.nonce ?? null,
    });
  }

  async consumeCode(code: string): Promise<{
    userId: string;
    clientId: string;
    redirectUri: string;
    expiresAt: number;
    nonce?: string;
  } | undefined> {
    const row = await this.table('oidc_codes').where({ code }).first();
    if (!row) return undefined;
    // Single-use: delete immediately
    await this.table('oidc_codes').where({ code }).delete();
    return {
      userId: row.user_id,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      expiresAt: Number(row.expires_at),
      nonce: row.nonce ?? undefined,
    };
  }

  // ── Sessions ───────────────────────────────────────────────────────

  async saveSession(sessionId: string, userId: string, expiresAt: number): Promise<void> {
    await this.table('oidc_sessions').insert({
      session_id: sessionId,
      user_id: userId,
      expires_at: expiresAt,
    });
  }

  async getSession(sessionId: string): Promise<{ userId: string; expiresAt: number } | undefined> {
    const row = await this.table('oidc_sessions').where({ session_id: sessionId }).first();
    if (!row) return undefined;
    return { userId: row.user_id, expiresAt: Number(row.expires_at) };
  }

  // ── Pending GitHub Auths ───────────────────────────────────────────

  async savePendingAuth(state: string, returnTo: string, expiresAt: number): Promise<void> {
    await this.table('oidc_pending_auths').insert({
      state,
      return_to: returnTo,
      expires_at: expiresAt,
    });
  }

  async consumePendingAuth(state: string): Promise<{ returnTo: string; expiresAt: number } | undefined> {
    const row = await this.table('oidc_pending_auths').where({ state }).first();
    if (!row) return undefined;
    await this.table('oidc_pending_auths').where({ state }).delete();
    return { returnTo: row.return_to, expiresAt: Number(row.expires_at) };
  }

  // ── Access Tokens ──────────────────────────────────────────────────

  async saveAccessToken(token: string, userId: string, expiresAt: number): Promise<void> {
    await this.table('oidc_access_tokens').insert({
      token,
      user_id: userId,
      expires_at: expiresAt,
    });
  }

  async getAccessToken(token: string): Promise<{ userId: string; expiresAt: number } | undefined> {
    const row = await this.table('oidc_access_tokens').where({ token }).first();
    if (!row) return undefined;
    return { userId: row.user_id, expiresAt: Number(row.expires_at) };
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const tables = ['oidc_codes', 'oidc_sessions', 'oidc_pending_auths', 'oidc_access_tokens'];
    for (const t of tables) {
      await this.table(t).where('expires_at', '<', now).delete();
    }
  }
}
