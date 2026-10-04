import { Knex } from 'knex';
import { LoggerService } from '@backstage/backend-plugin-api';

/** A forward-auth session: valid for exactly one tenant, service and host. */
export interface ForwardAuthSession {
  userId: string;
  tenant: string;
  service: string;
  host: string;
  expiresAt: number;
}

/** A one-time code that establishes a ForwardAuthSession on its host. */
export interface ForwardAuthCode {
  userId: string;
  tenant: string;
  service: string;
  host: string;
  state: string;
  returnPath: string;
  sessionExpiresAt: number;
  expiresAt: number;
}

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

    const hasColumn = async (table: string, column: string) =>
      schema
        ? knex.schema.withSchema(schema).hasColumn(table, column)
        : knex.schema.hasColumn(table, column);

    const alterTable = (name: string, builder: (t: Knex.AlterTableBuilder) => void) =>
      schema
        ? knex.schema.withSchema(schema).alterTable(name, builder)
        : knex.schema.alterTable(name, builder);

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

    // Sessions created before host_only existed were sent as a cookie scoped
    // to the whole parent domain, so any *.mctl.ai host may have seen them.
    // Delete them when the column is introduced, and only ever accept rows
    // that carry host_only = true, so a row written by a pod still running
    // the old code during the rollout is not honored either.
    if (!(await hasColumn('oidc_sessions', 'host_only'))) {
      await this.table('oidc_sessions').delete();
      await alterTable('oidc_sessions', t => {
        t.boolean('host_only').notNullable().defaultTo(false);
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

    if (!(await hasTable('oidc_forward_auth_codes'))) {
      await createTable('oidc_forward_auth_codes', t => {
        t.string('code', 128).primary().notNullable();
        t.string('user_id', 128).notNullable();
        t.string('tenant', 128).notNullable();
        t.string('service', 128).notNullable();
        t.string('host', 256).notNullable();
        t.string('state', 128).notNullable();
        t.text('return_path').notNullable();
        t.bigInteger('session_expires_at').notNullable();
        t.bigInteger('expires_at').notNullable();
      });
    }

    if (!(await hasTable('oidc_forward_auth_sessions'))) {
      await createTable('oidc_forward_auth_sessions', t => {
        t.string('session_id', 128).primary().notNullable();
        t.string('user_id', 128).notNullable();
        t.string('tenant', 128).notNullable();
        t.string('service', 128).notNullable();
        t.string('host', 256).notNullable();
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
      host_only: true,
    });
  }

  async getSession(sessionId: string): Promise<{ userId: string; expiresAt: number } | undefined> {
    const row = await this.table('oidc_sessions')
      .where({ session_id: sessionId, host_only: true })
      .first();
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

  // ── Forward-auth Codes ─────────────────────────────────────────────
  //
  // One-time codes that carry a portal sign-in to a single forward-auth
  // protected host. Each is bound to the tenant, service and host it was
  // issued for, and to the state cookie of the browser that asked for it.

  async saveForwardAuthCode(code: string, data: ForwardAuthCode): Promise<void> {
    await this.table('oidc_forward_auth_codes').insert({
      code,
      user_id: data.userId,
      tenant: data.tenant,
      service: data.service,
      host: data.host,
      state: data.state,
      return_path: data.returnPath,
      session_expires_at: data.sessionExpiresAt,
      expires_at: data.expiresAt,
    });
  }

  async consumeForwardAuthCode(code: string): Promise<ForwardAuthCode | undefined> {
    const row = await this.table('oidc_forward_auth_codes').where({ code }).first();
    if (!row) return undefined;
    // Single-use: only the request that actually deletes the row may use it,
    // so two concurrent redemptions of the same code cannot both succeed.
    const deleted = await this.table('oidc_forward_auth_codes').where({ code }).delete();
    if (deleted !== 1) return undefined;
    return {
      userId: row.user_id,
      tenant: row.tenant,
      service: row.service,
      host: row.host,
      state: row.state,
      returnPath: row.return_path,
      sessionExpiresAt: Number(row.session_expires_at),
      expiresAt: Number(row.expires_at),
    };
  }

  // ── Forward-auth Sessions ──────────────────────────────────────────

  async saveForwardAuthSession(sessionId: string, data: ForwardAuthSession): Promise<void> {
    await this.table('oidc_forward_auth_sessions').insert({
      session_id: sessionId,
      user_id: data.userId,
      tenant: data.tenant,
      service: data.service,
      host: data.host,
      expires_at: data.expiresAt,
    });
  }

  async getForwardAuthSession(sessionId: string): Promise<ForwardAuthSession | undefined> {
    const row = await this.table('oidc_forward_auth_sessions').where({ session_id: sessionId }).first();
    if (!row) return undefined;
    return {
      userId: row.user_id,
      tenant: row.tenant,
      service: row.service,
      host: row.host,
      expiresAt: Number(row.expires_at),
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    const tables = [
      'oidc_codes',
      'oidc_sessions',
      'oidc_pending_auths',
      'oidc_access_tokens',
      'oidc_forward_auth_codes',
      'oidc_forward_auth_sessions',
    ];
    for (const t of tables) {
      await this.table(t).where('expires_at', '<', now).delete();
    }
  }
}
