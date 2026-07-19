import {
  createBackendPlugin,
  coreServices,
} from '@backstage/backend-plugin-api';
import { KeyStore } from './keyStore';
import { OidcStore } from './oidcStore';
import { createRouter, OidcClient, MembershipLookup } from './router';

export const oidcProviderPlugin = createBackendPlugin({
  pluginId: 'oidc-provider',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        database: coreServices.database,
        httpRouter: coreServices.httpRouter,
      },
      async init({ config, logger, database, httpRouter }) {
        // ── Config ─────────────────────────────────────────────────────
        const issuer = config.getString('oidcProvider.issuer');
        const clientsConfig = config.getConfigArray('oidcProvider.clients');
        // Entries whose env-substituted values are missing are skipped (with
        // a warning) instead of crashing the whole portal: a client whose
        // secret has not reached the deployment yet must not take SSO down.
        const clients: OidcClient[] = [];
        for (const c of clientsConfig) {
          const clientId = c.getOptionalString('clientId');
          const clientSecret = c.getOptionalString('clientSecret');
          const redirectUris = c.getOptionalStringArray('redirectUris');
          if (!clientId || !clientSecret || !redirectUris?.length) {
            logger.warn(
              `[OIDC Provider] Skipping incompletely configured client (clientId=${clientId ?? 'missing'})`,
            );
            continue;
          }
          clients.push({ clientId, clientSecret, redirectUris });
        }

        const githubClientId = config.getString('oidcProvider.github.clientId');
        const githubClientSecret = config.getString('oidcProvider.github.clientSecret');

        // ── Membership lookup ──────────────────────────────────────────
        // pluginDivisionMode=schema: all plugins share the same PG database
        // but each has its own schema (= pluginId). The tenant-management
        // plugin's schema is "tenant-management". We cross-query using
        // knex withSchema().
        const dbClient = await database.getClient();
        const isPostgres = dbClient.client.config.client === 'pg';
        const tmSchema = 'tenant-management';

        const membershipLookup: MembershipLookup = {
          async getUserGroups(userId: string): Promise<string[]> {
            const id = userId.toLowerCase();
            const rows = isPostgres
              ? await dbClient('tenant_members')
                  .withSchema(tmSchema)
                  .select('tenant_name')
                  .whereRaw('LOWER(user_id) = ?', [id])
              : await dbClient('tenant_members')
                  .select('tenant_name')
                  .whereRaw('LOWER(user_id) = ?', [id]);
            return rows.map((r: any) => r.tenant_name);
          },
          async userExists(userId: string): Promise<boolean> {
            const id = userId.toLowerCase();
            const row = isPostgres
              ? await dbClient('tenant_members')
                  .withSchema(tmSchema)
                  .whereRaw('LOWER(user_id) = ?', [id])
                  .first()
              : await dbClient('tenant_members')
                  .whereRaw('LOWER(user_id) = ?', [id])
                  .first();
            return !!row;
          },
          async getUserRole(userId: string, tenantName: string): Promise<string | null> {
            const id = userId.toLowerCase();
            const tenant = tenantName.toLowerCase();
            const row = isPostgres
              ? await dbClient('tenant_members')
                  .withSchema(tmSchema)
                  .select('role')
                  .whereRaw('LOWER(user_id) = ?', [id])
                  .andWhereRaw('LOWER(tenant_name) = ?', [tenant])
                  .first()
              : await dbClient('tenant_members')
                  .select('role')
                  .whereRaw('LOWER(user_id) = ?', [id])
                  .andWhereRaw('LOWER(tenant_name) = ?', [tenant])
                  .first();
            return row?.role ? String(row.role) : null;
          },
          async getUserTenantRoles(userId: string): Promise<Record<string, string>> {
            const id = userId.toLowerCase();
            const rows = isPostgres
              ? await dbClient('tenant_members')
                  .withSchema(tmSchema)
                  .select('tenant_name', 'role')
                  .whereRaw('LOWER(user_id) = ?', [id])
              : await dbClient('tenant_members')
                  .select('tenant_name', 'role')
                  .whereRaw('LOWER(user_id) = ?', [id]);
            const roles: Record<string, string> = {};
            for (const row of rows as Array<{ tenant_name: string; role: string }>) {
              roles[row.tenant_name] = String(row.role);
            }
            return roles;
          },
        };

        // ── OIDC persistent store ────────────────────────────────────
        const oidcStore = new OidcStore(dbClient, logger, isPostgres);
        await oidcStore.init();

        // ── Signing keys (persisted; restarts keep tokens verifiable) ──
        const keyStore = new KeyStore(logger);
        await keyStore.init(oidcStore);

        // ── Router ─────────────────────────────────────────────────────
        const router = createRouter({
          logger,
          membership: membershipLookup,
          keyStore,
          issuer,
          clients,
          githubClientId,
          githubClientSecret,
          store: oidcStore,
        });
        httpRouter.use(router);

        // All OIDC endpoints must be publicly accessible (Dex calls them server-to-server)
        httpRouter.addAuthPolicy({ path: '/', allow: 'unauthenticated' });
        httpRouter.addAuthPolicy({ path: '/github/callback', allow: 'unauthenticated' });
        httpRouter.addAuthPolicy({ path: '/openai-codex/callback', allow: 'unauthenticated' });

        logger.info(
          `[OIDC Provider] Initialized. Issuer: ${issuer}, clients: ${clients.map(c => c.clientId).join(', ')}`,
        );
      },
    });
  },
});
