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
        const clients: OidcClient[] = clientsConfig.map(c => ({
          clientId: c.getString('clientId'),
          clientSecret: c.getString('clientSecret'),
          redirectUris: c.getStringArray('redirectUris'),
        }));

        const githubClientId = config.getString('oidcProvider.github.clientId');
        const githubClientSecret = config.getString('oidcProvider.github.clientSecret');

        // ── Signing keys ───────────────────────────────────────────────
        const keyStore = new KeyStore(logger);
        await keyStore.init();

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
        };

        // ── OIDC persistent store ────────────────────────────────────
        const oidcStore = new OidcStore(dbClient, logger, isPostgres);
        await oidcStore.init();

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

        logger.info(
          `[OIDC Provider] Initialized. Issuer: ${issuer}, clients: ${clients.map(c => c.clientId).join(', ')}`,
        );
      },
    });
  },
});
